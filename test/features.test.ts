import { describe, expect, test } from "bun:test";

import { extractFeatures } from "../src/router/features.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";
import type { NormRequest } from "../src/wire/types.ts";

const TOOLS = [
	{
		type: "function",
		function: {
			name: "bash",
			description: "Run a shell command",
			parameters: { type: "object", properties: { command: { type: "string" } } },
		},
	},
	{
		type: "function",
		function: {
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	},
];

function req(messages: unknown[], tools = TOOLS): NormRequest {
	return parseChatRequest({ model: "auto", messages, tools }, new Headers());
}

function toolCall(id: string, name: string, args: string) {
	return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] };
}

const SYSTEM = { role: "system", content: "You are a coding agent." };

describe("agent-loop shape", () => {
	test("a tool-result tail is a mechanical continuation, not fresh intent", async () => {
		const f = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "check the version" },
				toolCall("c1", "read", '{"path":"package.json"}'),
				{ role: "tool", tool_call_id: "c1", name: "read", content: '{"version":"1.0.0"}' },
			]),
			100,
		);
		expect(f.isToolResultContinuation).toBe(true);
		expect(f.toolLoopDepth).toBeGreaterThan(0);
	});

	test("a trailing user message is fresh intent, not a continuation", async () => {
		const f = extractFeatures(req([SYSTEM, { role: "user", content: "add a retry" }]), 100);
		expect(f.isToolResultContinuation).toBe(false);
		expect(f.toolLoopDepth).toBe(0);
	});

	test("loop depth grows with consecutive tool round-trips", async () => {
		const shallow = extractFeatures(
			req([SYSTEM, { role: "user", content: "go" }, toolCall("c1", "read", "{}"), { role: "tool", tool_call_id: "c1", content: "a" }]),
			100,
		);
		const deep = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "go" },
				toolCall("c1", "read", '{"path":"a"}'),
				{ role: "tool", tool_call_id: "c1", content: "a" },
				toolCall("c2", "read", '{"path":"b"}'),
				{ role: "tool", tool_call_id: "c2", content: "b" },
				toolCall("c3", "read", '{"path":"c"}'),
				{ role: "tool", tool_call_id: "c3", content: "c" },
			]),
			100,
		);
		expect(deep.toolLoopDepth).toBeGreaterThan(shallow.toolLoopDepth);
	});

	test("counts distinct tools actually used, not merely offered", async () => {
		const f = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "go" },
				toolCall("c1", "read", '{"path":"a"}'),
				{ role: "tool", tool_call_id: "c1", content: "a" },
				toolCall("c2", "bash", '{"command":"ls"}'),
				{ role: "tool", tool_call_id: "c2", content: "a.txt" },
			]),
			100,
		);
		expect(f.toolCount).toBe(2);
		expect(f.distinctToolsUsed).toBe(2);
	});
});

describe("failure and loop signals", () => {
	test("detects a failing tool result", async () => {
		const f = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "build it" },
				toolCall("c1", "bash", '{"command":"make"}'),
				{ role: "tool", tool_call_id: "c1", content: "make: *** [all] Error 2\ncommand not found: cc" },
			]),
			100,
		);
		expect(f.lastToolFailed).toBe(true);
	});

	test("does not cry failure over ordinary output", async () => {
		// A false positive here escalates to an expensive model for nothing.
		const f = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "list files" },
				toolCall("c1", "bash", '{"command":"ls"}'),
				{ role: "tool", tool_call_id: "c1", content: "README.md\nsrc\npackage.json" },
			]),
			100,
		);
		expect(f.lastToolFailed).toBe(false);
	});

	test("detects an identical repeated tool call as a loop", async () => {
		const f = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "go" },
				toolCall("c1", "read", '{"path":"same.ts"}'),
				{ role: "tool", tool_call_id: "c1", content: "x" },
				toolCall("c2", "read", '{"path":"same.ts"}'),
				{ role: "tool", tool_call_id: "c2", content: "x" },
			]),
			100,
		);
		expect(f.repeatedToolCall).toBe(true);
		expect(f.circularToolCall).toBe(true);
	});

	test("different arguments to the same tool are not a loop", async () => {
		const f = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "go" },
				toolCall("c1", "read", '{"path":"a.ts"}'),
				{ role: "tool", tool_call_id: "c1", content: "x" },
				toolCall("c2", "read", '{"path":"b.ts"}'),
				{ role: "tool", tool_call_id: "c2", content: "y" },
			]),
			100,
		);
		expect(f.repeatedToolCall).toBe(false);
		expect(f.circularToolCall).toBe(false);
	});

	test("a non-adjacent re-issued call is circular but not an adjacent repeat", async () => {
		const f = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "go" },
				toolCall("c1", "read", '{"path":"same.ts"}'),
				{ role: "tool", tool_call_id: "c1", content: "x" },
				toolCall("c2", "bash", '{"command":"ls"}'),
				{ role: "tool", tool_call_id: "c2", content: "a.txt" },
				toolCall("c3", "read", '{"path":"same.ts"}'),
				{ role: "tool", tool_call_id: "c3", content: "x" },
			]),
			100,
		);
		// c3 repeats c1 verbatim with c2 in between: not adjacent, but circular.
		expect(f.repeatedToolCall).toBe(false);
		expect(f.circularToolCall).toBe(true);
	});
});

describe("newest-content scoping", () => {
	test("keywords are read from the newest user content only, not from history", async () => {
		// History mentioning "architecture" must not permanently inflate every
		// later turn in a long session.
		const f = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "Explain the architecture and the deadlock root cause." },
				{ role: "assistant", content: "Here is the design." },
				{ role: "user", content: "fix the typo" },
			]),
			100,
		);
		expect(f.complexityKeywords).toHaveLength(0);
		expect(f.trivialityKeywords.length).toBeGreaterThan(0);
	});

	test("picks up complexity keywords when they are actually current", async () => {
		const f = extractFeatures(
			req([SYSTEM, { role: "user", content: "Find the root cause of this race condition and redesign the architecture." }]),
			100,
		);
		expect(f.complexityKeywords.length).toBeGreaterThan(0);
	});

	test("measures code volume in the newest content", async () => {
		const f = extractFeatures(
			req([SYSTEM, { role: "user", content: "review this\n```ts\nconst a = 1;\nconst b = 2;\n```" }]),
			100,
		);
		expect(f.codeBlocks).toBe(1);
		expect(f.codeBytes).toBeGreaterThan(0);
	});

	test("flags a terse instruction", async () => {
		const terse = extractFeatures(req([SYSTEM, { role: "user", content: "bump the version" }]), 100);
		expect(terse.isTerseInstruction).toBe(true);
		const verbose = extractFeatures(
			req([
				SYSTEM,
				{
					role: "user",
					content:
						"I need you to walk through the whole retry subsystem, explain how the backoff interacts with the circuit breaker, and then propose a design that makes both testable in isolation.",
				},
			]),
			100,
		);
		expect(verbose.isTerseInstruction).toBe(false);
	});

	test("carries through image presence and requested reasoning", async () => {
		const f = extractFeatures(
			parseChatRequest(
				{
					model: "auto",
					reasoning_effort: "high",
					messages: [
						{
							role: "user",
							content: [
								{ type: "text", text: "what is this" },
								{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
							],
						},
					],
				},
				new Headers(),
			),
			100,
		);
		expect(f.hasImages).toBe(true);
		expect(f.hasNewImage).toBe(true);
		expect(f.requestedReasoning).toBe("high");
	});

	test("a stale image in history is not new visual work on a tool continuation", async () => {
		const f = extractFeatures(
			req([
				SYSTEM,
				{
					role: "user",
					content: [
						{ type: "text", text: "implement this screen" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } },
					],
				},
				toolCall("c1", "read", '{"path":"src/app.tsx"}'),
				{ role: "tool", tool_call_id: "c1", name: "read", content: "export const App = () => null;" },
			]),
			100,
		);
		// The image is still in context (capability), but the current turn is a
		// mechanical continuation, not fresh visual work (task axis).
		expect(f.hasImages).toBe(true);
		expect(f.hasNewImage).toBe(false);
		expect(f.isToolResultContinuation).toBe(true);
	});
});

describe("user-visible tool failure (review 2026-09-05)", () => {
	test("a failed tool run the user is now responding to still counts as failed", async () => {
		// The classifier keeps the FULL failed-tool weight when the failure is
		// user-visible (not a mechanical continuation); that branch was dead
		// while the scan ran only on tool-result tails.
		const f = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "build it" },
				toolCall("c1", "bash", '{"command":"make"}'),
				{ role: "tool", tool_call_id: "c1", content: "make: *** [all] Error 2" },
				{ role: "user", content: "that failed, try a different approach" },
			]),
			100,
		);
		expect(f.isToolResultContinuation).toBe(false);
		expect(f.lastToolFailed).toBe(true);
	});

	test("an assistant reply between the failed run and the user resets the failure signal", async () => {
		const f = extractFeatures(
			req([
				SYSTEM,
				{ role: "user", content: "build it" },
				toolCall("c1", "bash", '{"command":"make"}'),
				{ role: "tool", tool_call_id: "c1", content: "make: *** [all] Error 2" },
				{ role: "assistant", content: "The build failed because cc is missing." },
				{ role: "user", content: "ok, install it" },
			]),
			100,
		);
		expect(f.lastToolFailed).toBe(false);
	});
});

describe("prompt anatomy", () => {
	test("splits prompt bytes by role and marks the older half and stale tool results", async () => {
		// 24 non-system messages: 12 tool-call/result pairs. The newest 20
		// non-system messages are "fresh"; the 4 before them hold 2 stale tool results.
		const messages: unknown[] = [SYSTEM];
		for (let i = 0; i < 12; i++) {
			messages.push(toolCall(`c${i}`, "bash", `{"command":"ls ${i}"}`));
			messages.push({ role: "tool", tool_call_id: `c${i}`, content: "x".repeat(100) });
		}
		messages.push({ role: "user", content: "y".repeat(50) });
		const f = extractFeatures(req(messages), 5000);
		const a = f.anatomy!;
		expect(a.messages).toBe(26);
		expect(a.systemBytes).toBe("You are a coding agent.".length);
		expect(a.userBytes).toBe(50);
		expect(a.toolBytes).toBe(1200);
		// 25 non-system messages; the older half is the first 12 (6 pairs ⇒ 6 tool results).
		expect(a.olderHalfBytes).toBeGreaterThanOrEqual(600);
		expect(a.olderHalfBytes).toBeLessThan(1200);
		// Stale: tool results among the first 25-20 = 5 non-system messages ⇒ results at index 1 and 3.
		expect(a.staleToolBytes).toBe(200);
	});

	test("a bare chat request has no stale tool bytes", async () => {
		const a = extractFeatures(req([SYSTEM, { role: "user", content: "hi" }]), 20).anatomy!;
		expect(a.toolBytes).toBe(0);
		expect(a.staleToolBytes).toBe(0);
		expect(a.olderHalfBytes).toBe(0);
	});
});

describe("subagent and read-only tool loop signals", () => {
	test("a tool-result tail behind read-only calls is flagged; a write call clears it", async () => {
		const reads = req([
			SYSTEM,
			{ role: "user", content: "find the retry helper" },
			{ role: "assistant", content: null, tool_calls: [
				{ id: "a", type: "function", function: { name: "grep", arguments: "{\"pattern\":\"retry\"}" } },
				{ id: "b", type: "function", function: { name: "read", arguments: "{\"path\":\"x.ts\"}" } },
			] },
			{ role: "tool", tool_call_id: "a", content: "x.ts:12" },
			{ role: "tool", tool_call_id: "b", content: "export function retry() {}" },
		]);
		expect(extractFeatures(reads, 1000).readOnlyToolTail).toBe(true);
		const write = req([
			SYSTEM,
			{ role: "user", content: "fix it" },
			toolCall("c", "edit", "{\"path\":\"x.ts\"}"),
			{ role: "tool", tool_call_id: "c", content: "ok" },
		]);
		expect(extractFeatures(write, 1000).readOnlyToolTail).toBe(false);
		// A fresh user turn is never a read-only tail, whatever came before.
		expect(extractFeatures(req([SYSTEM, { role: "user", content: "now what?" }]), 100).readOnlyToolTail).toBe(false);
	});

	test("the subagent marker rides on the request", async () => {
		const r = parseChatRequest({ model: "auto", messages: [SYSTEM, { role: "user", content: "hi" }], tools: TOOLS }, new Headers({ "x-omp-subagent": "1" }));
		expect(r.isSubagent).toBe(true);
		expect(extractFeatures(r, 100).isSubagent).toBe(true);
		expect(req([SYSTEM, { role: "user", content: "hi" }]).isSubagent).toBe(false);
	});
});
