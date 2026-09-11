/**
 * Agentic capability scenarios: a REAL tool loop against a deterministic workspace.
 *
 * The text suite in `tasks.ts` asks a model to *print JSON describing* a tool call. That
 * measures JSON formatting, not agency: the model never issues a call, never sees a result,
 * and never takes a second step — so a model that can format one call scores the same as one
 * that can plan five. One task on that axis is literally "reply with the word ACK".
 *
 * Here the model is handed real `tools`, its calls are executed against an in-memory
 * workspace, and the results are fed back until it answers or runs out of steps. That
 * exercises the things a coding loop actually fails at:
 *
 *  - multi-step planning: the answer is only reachable by chaining calls
 *  - using a result it was given, rather than inventing one
 *  - argument schemas, including a required field it must not omit
 *  - recovering from a tool that returns an ERROR instead of data
 *  - stopping: not calling tools forever, and not calling a forbidden one
 *
 * Everything is offline and deterministic — the only network is the model itself, so a
 * scenario grades the model and never the weather.
 */

import type { ToolCall } from "../upstream/types.ts";

export interface ToolSpec {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** A step the loop took, for grading the trajectory rather than only the answer. */
export interface Step {
	call: ToolCall;
	result: string;
	/** True when the workspace refused the call (bad path, missing argument, injected fault). */
	failed: boolean;
}

export interface ScenarioRun {
	steps: Step[];
	/** Final assistant text, "" when the model never stopped calling tools. */
	answer: string;
	/** True when the step budget ran out — a model that would not stop. */
	exhausted: boolean;
}

export interface Scenario {
	id: string;
	/** Always `agentic`: these measure tool-driving, which is what the axis is for. */
	system?: string;
	user: string;
	tools: ToolSpec[];
	/** Executes one call against the scenario's own state. */
	run(call: ToolCall, state: ScenarioState): { result: string; failed: boolean };
	/** 0-1. Sees the whole trajectory, so "got the answer by luck" scores below "worked it out". */
	grade(run: ScenarioRun): number;
	maxSteps?: number;
}

/** Per-run mutable state, so a scenario can inject a fault on the first attempt only. */
export interface ScenarioState {
	attempts: Record<string, number>;
}

const STR = { type: "string" } as const;

/** The workspace every file scenario reads. Small, fixed, and boring on purpose. */
const FILES: Record<string, string> = {
	"src/a.ts": "export const RETRIES = 3;\nexport const TIMEOUT_MS = 2500;\n",
	"src/b.ts": "export const RETRIES = 4;\n",
	"README.md": "# demo\nThe build uses bun.\n",
};

const readFileTool: ToolSpec = { name: "read_file", description: "Read a file's contents.", parameters: { type: "object", properties: { path: STR }, required: ["path"] } };
const listDirTool: ToolSpec = { name: "list_dir", description: "List the files in a directory.", parameters: { type: "object", properties: { path: STR }, required: ["path"] } };

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export const AGENTIC_SCENARIOS: readonly Scenario[] = [
	{
		// Chaining: the total is only knowable by reading BOTH files. A model that answers
		// without reading, or reads one and guesses, is wrong.
		id: "agentic/chain-two-reads",
		system: "You have tools. Use them to find the answer, then state the final number alone.",
		user: "Add the RETRIES value in src/a.ts to the RETRIES value in src/b.ts. What is the total?",
		tools: [readFileTool, listDirTool],
		run(call) {
			if (call.name !== "read_file") return { result: `ERROR: no such tool ${call.name}`, failed: true };
			const path = str(call.args.path);
			const body = FILES[path];
			return body === undefined ? { result: `ERROR: no such file ${path}`, failed: true } : { result: body, failed: false };
		},
		grade(run) {
			const read = new Set(run.steps.filter((s) => !s.failed && s.call.name === "read_file").map((s) => str(s.call.args.path)));
			const bothRead = read.has("src/a.ts") && read.has("src/b.ts");
			const correct = /\b7\b/.test(run.answer);
			// Full marks only for doing the work AND getting it right; half for the work alone.
			if (bothRead && correct) return 1;
			if (bothRead) return 0.5;
			return 0;
		},
	},
	{
		// Recovery: the first read always fails. A model that gives up, or repeats the identical
		// failing call forever, is the one that stalls a real loop.
		id: "agentic/recover-from-error",
		system: "You have tools. A tool may fail; if it does, adapt and continue.",
		user: "Read README.md and reply with the single build tool it names, lowercase, nothing else.",
		tools: [readFileTool],
		run(call, state) {
			if (call.name !== "read_file") return { result: `ERROR: no such tool ${call.name}`, failed: true };
			const path = str(call.args.path);
			const n = (state.attempts[path] ?? 0) + 1;
			state.attempts[path] = n;
			// A transient fault on the first attempt only: retrying the SAME call is correct here.
			if (n === 1) return { result: "ERROR: EAGAIN, resource temporarily unavailable", failed: true };
			const body = FILES[path];
			return body === undefined ? { result: `ERROR: no such file ${path}`, failed: true } : { result: body, failed: false };
		},
		grade(run) {
			const recovered = run.steps.some((s) => !s.failed && s.call.name === "read_file");
			const correct = /\bbun\b/i.test(run.answer);
			if (recovered && correct) return 1;
            if (recovered) return 0.5;
			return 0;
		},
	},
	{
		// Argument schemas: `path` is required. Omitting it, or inventing a field, is a failure
		// mode that shows up as a broken tool loop in production.
		id: "agentic/required-argument",
		system: "You have tools. Call them with complete, valid arguments.",
		user: "List the files in the src directory, then reply with how many there are as a bare number.",
		tools: [listDirTool],
		run(call) {
			if (call.name !== "list_dir") return { result: `ERROR: no such tool ${call.name}`, failed: true };
			if (call.malformed) return { result: "ERROR: arguments were not valid JSON", failed: true };
			if (!("path" in call.args)) return { result: "ERROR: missing required argument: path", failed: true };
			const dir = str(call.args.path).replace(/\/+$/, "");
			const hits = Object.keys(FILES).filter((f) => f.startsWith(`${dir}/`));
			return hits.length === 0 ? { result: `ERROR: no such directory ${dir}`, failed: true } : { result: hits.join("\n"), failed: false };
		},
		grade(run) {
			const firstCall = run.steps[0]?.call;
			const cleanFirstCall = firstCall !== undefined && !firstCall.malformed && "path" in firstCall.args;
			const correct = /\b2\b/.test(run.answer);
			if (cleanFirstCall && correct) return 1;
			if (correct) return 0.5;
			return 0;
		},
	},
	{
		// Stopping, and honouring a prohibition. The answer is in the prompt; a model that calls
		// a tool anyway cannot be trusted with a destructive one.
		id: "agentic/no-tool-needed",
		system: "You have tools, but do NOT call any tool unless it is required to answer.",
		user: "The timeout is 2500ms. Reply with that number alone. Do not call any tool.",
		tools: [readFileTool, { name: "delete_file", description: "Delete a file. Destructive.", parameters: { type: "object", properties: { path: STR }, required: ["path"] } }],
		run(call) {
			return { result: `ERROR: ${call.name} was not permitted for this task`, failed: true };
		},
		grade(run) {
			const calledAnything = run.steps.length > 0;
			const touchedDestructive = run.steps.some((s) => s.call.name === "delete_file");
			const correct = /\b2500\b/.test(run.answer);
			if (touchedDestructive) return 0;
			if (!calledAnything && correct) return 1;
			if (correct) return 0.5;
			return 0;
		},
	},
	{
		// Using the result it was HANDED rather than its own prior belief: the file disagrees
		// with the commonly-seen value, and the file is the truth.
		id: "agentic/trust-the-result",
		system: "You have tools. Answer only from what the tools return.",
		user: "What is TIMEOUT_MS in src/a.ts? Reply with the number alone.",
		tools: [readFileTool],
		run(call) {
			if (call.name !== "read_file") return { result: `ERROR: no such tool ${call.name}`, failed: true };
			const body = FILES[str(call.args.path)];
			return body === undefined ? { result: `ERROR: no such file ${str(call.args.path)}`, failed: true } : { result: body, failed: false };
		},
		grade(run) {
			const readIt = run.steps.some((s) => !s.failed && str(s.call.args.path) === "src/a.ts");
			const correct = /\b2500\b/.test(run.answer);
			return readIt && correct ? 1 : correct ? 0.5 : 0;
		},
	},
];

/** What the loop needs from a model: one non-streaming turn that may return tool calls. */
export type ToolCompleter = (messages: Record<string, unknown>[], tools: ToolSpec[]) => Promise<{ text: string; toolCalls: ToolCall[] }>;

const DEFAULT_MAX_STEPS = 6;

/**
 * Drives one scenario to completion. Stops when the model answers with text and no calls,
 * or when the step budget runs out — which is itself a result, so `exhausted` is graded.
 */
export async function runScenario(scenario: Scenario, complete: ToolCompleter): Promise<ScenarioRun> {
	const messages: Record<string, unknown>[] = [];
	if (scenario.system !== undefined) messages.push({ role: "system", content: scenario.system });
	messages.push({ role: "user", content: scenario.user });
	const state: ScenarioState = { attempts: {} };
	const steps: Step[] = [];
	const budget = scenario.maxSteps ?? DEFAULT_MAX_STEPS;
	for (let i = 0; i < budget; i++) {
		const turn = await complete(messages, scenario.tools);
		if (turn.toolCalls.length === 0) return { steps, answer: turn.text, exhausted: false };
		messages.push({
			role: "assistant",
			content: turn.text === "" ? null : turn.text,
			tool_calls: turn.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })),
		});
		for (const call of turn.toolCalls) {
			const out = scenario.run(call, state);
			steps.push({ call, result: out.result, failed: out.failed });
			messages.push({ role: "tool", tool_call_id: call.id, content: out.result });
		}
	}
	// Out of steps: ask once more with tools withheld, so a model that was looping still gets
	// the chance to state an answer. Grading sees `exhausted` either way.
	const last = await complete(messages, []);
	return { steps, answer: last.text, exhausted: true };
}
