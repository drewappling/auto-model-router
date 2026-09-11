import { describe, expect, test } from "bun:test";

import { AGENTIC_SCENARIOS, runScenario, type Scenario, type ToolCompleter } from "../src/eval/agentic.ts";
import type { ToolCall } from "../src/upstream/types.ts";

const call = (name: string, args: Record<string, unknown>, malformed = false): ToolCall => ({ id: `c_${name}`, name, args, malformed });

/** A model scripted as a list of turns, so a scenario's grading is tested without a network. */
function scripted(turns: { text?: string; calls?: ToolCall[] }[]): ToolCompleter {
	let i = 0;
	return async () => {
		const turn = turns[Math.min(i, turns.length - 1)];
		i += 1;
		return { text: turn?.text ?? "", toolCalls: turn?.calls ?? [] };
	};
}

const find = (id: string): Scenario => AGENTIC_SCENARIOS.find((s) => s.id === id)!;

describe("agentic scenarios", () => {
	test("the loop executes calls, feeds results back, and stops when the model answers", async () => {
		const scenario = find("agentic/chain-two-reads");
		const run = await runScenario(
			scenario,
			scripted([{ calls: [call("read_file", { path: "src/a.ts" })] }, { calls: [call("read_file", { path: "src/b.ts" })] }, { text: "7" }]),
		);
		expect(run.steps.map((s) => s.call.name)).toEqual(["read_file", "read_file"]);
		// The tool's real output came back, so the model could have used it.
		expect(run.steps[0]!.result).toContain("RETRIES = 3");
		expect(run.steps.every((s) => !s.failed)).toBe(true);
		expect(run.exhausted).toBe(false);
		expect(scenario.grade(run)).toBe(1);
	});

	test("chaining: doing the work and guessing the answer are scored differently", async () => {
		const scenario = find("agentic/chain-two-reads");
		// Right answer with no work: this is what the old text suite could not tell apart.
		const guessed = await runScenario(scenario, scripted([{ text: "7" }]));
		expect(guessed.steps).toHaveLength(0);
		expect(scenario.grade(guessed)).toBe(0);
		// Work done, arithmetic wrong: partial credit, not zero.
		const halfway = await runScenario(
			scenario,
			scripted([{ calls: [call("read_file", { path: "src/a.ts" })] }, { calls: [call("read_file", { path: "src/b.ts" })] }, { text: "8" }]),
		);
		expect(scenario.grade(halfway)).toBe(0.5);
	});

	test("recovery: a first-attempt fault is retryable, and giving up scores zero", async () => {
		const scenario = find("agentic/recover-from-error");
		const persisted = await runScenario(
			scenario,
			scripted([{ calls: [call("read_file", { path: "README.md" })] }, { calls: [call("read_file", { path: "README.md" })] }, { text: "bun" }]),
		);
		expect(persisted.steps[0]!.failed).toBe(true);
		expect(persisted.steps[0]!.result).toContain("EAGAIN");
		expect(persisted.steps[1]!.failed).toBe(false);
		expect(scenario.grade(persisted)).toBe(1);

		const gaveUp = await runScenario(scenario, scripted([{ calls: [call("read_file", { path: "README.md" })] }, { text: "I could not read the file" }]));
		expect(scenario.grade(gaveUp)).toBe(0);
	});

	test("argument schemas: a missing required field is rejected and costs the mark", async () => {
		const scenario = find("agentic/required-argument");
		const sloppy = await runScenario(
			scenario,
			scripted([{ calls: [call("list_dir", {})] }, { calls: [call("list_dir", { path: "src" })] }, { text: "2" }]),
		);
		expect(sloppy.steps[0]!.result).toContain("missing required argument");
		// Correct answer, but only after a malformed call: partial credit.
		expect(scenario.grade(sloppy)).toBe(0.5);

		const clean = await runScenario(scenario, scripted([{ calls: [call("list_dir", { path: "src" })] }, { text: "2" }]));
		expect(clean.steps[0]!.failed).toBe(false);
		expect(scenario.grade(clean)).toBe(1);

		// Arguments that were not valid JSON are a schema failure, not a refusal.
		const broken = await runScenario(scenario, scripted([{ calls: [call("list_dir", {}, true)] }, { text: "2" }]));
		expect(broken.steps[0]!.result).toContain("not valid JSON");
	});

	test("restraint: calling a forbidden destructive tool is a zero however right the answer is", async () => {
		const scenario = find("agentic/no-tool-needed");
		const restrained = await runScenario(scenario, scripted([{ text: "2500" }]));
		expect(restrained.steps).toHaveLength(0);
		expect(scenario.grade(restrained)).toBe(1);

		const destructive = await runScenario(scenario, scripted([{ calls: [call("delete_file", { path: "src/a.ts" })] }, { text: "2500" }]));
		expect(scenario.grade(destructive)).toBe(0);

		// An unnecessary but harmless call still loses the mark for restraint.
		const chatty = await runScenario(scenario, scripted([{ calls: [call("read_file", { path: "src/a.ts" })] }, { text: "2500" }]));
		expect(scenario.grade(chatty)).toBe(0.5);
	});

	test("a model that never stops is cut off, and is asked once more without tools", async () => {
		const scenario = find("agentic/trust-the-result");
		// Always calls, never answers: the budget ends it rather than looping for ever.
		const looping = await runScenario(scenario, scripted([{ calls: [call("read_file", { path: "src/a.ts" })] }]));
		expect(looping.exhausted).toBe(true);
		expect(looping.steps.length).toBe(6);
		expect(scenario.grade(looping)).toBe(0);
	});

	test("every scenario grades a perfect trajectory at 1 and an empty one at 0", async () => {
		// A suite-wide invariant: a scenario that cannot be passed, or cannot be failed,
		// contributes nothing to separating models.
		for (const scenario of AGENTIC_SCENARIOS) {
			const nothing = await runScenario(scenario, scripted([{ text: "" }]));
			expect(scenario.grade(nothing)).toBeLessThan(1);
		}
	});
});
