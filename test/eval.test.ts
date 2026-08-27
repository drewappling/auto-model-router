import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import { applyFeedScores, loadLocalScores, saveLocalScores, type FeedScore } from "../src/catalog/benchmark-feeds.ts";
import { answerScore, extractJson, isRefusalOrEmpty, jsonField, tokenCoverage } from "../src/eval/grade.ts";
import { applyFit, fitAxis, fitCalibration, toLocalFeedScores, MIN_ANCHORS } from "../src/eval/calibrate.ts";
import { runEval, type EvalResult } from "../src/eval/run.ts";
import { makeJudge, parseScore } from "../src/eval/judge.ts";
import type { EvalTask, JudgedTask } from "../src/eval/tasks.ts";
import { openDb } from "../src/util/sqlite.ts";

describe("grade helpers", () => {
	test("answerScore matches whole reply, last line, or a standalone token", () => {
		expect(answerScore("9.9", "9.9")).toBe(1);
		expect(answerScore("The answer is 9.9", "9.9")).toBe(1);
		expect(answerScore("reasoning...\n9.9", "9.9")).toBe(1);
		expect(answerScore("19.99", "9.9")).toBe(0); // not a substring match
		expect(answerScore("", "9.9")).toBe(0);
	});
	test("tokenCoverage is the fraction of tokens present", () => {
		expect(tokenCoverage("return a + b;", ["a + b"])).toBe(1);
		expect(tokenCoverage("n * 2", ["n", "*", "2"])).toBe(1);
		expect(tokenCoverage("n plus two", ["n", "*", "2"])).toBeCloseTo(1 / 3);
	});
	test("extractJson tolerates fences and prose; jsonField reads a key", () => {
		expect(extractJson('here: {"answer": 8} ok')).toEqual({ answer: 8 });
		expect(extractJson("```json\n[2,3,5]\n```")).toEqual([2, 3, 5]);
		expect(extractJson("no json here")).toBeUndefined();
		expect(jsonField({ tool: "read_file" }, "tool")).toBe("read_file");
		expect(jsonField([1, 2], "tool")).toBeUndefined();
	});
	test("isRefusalOrEmpty flags empties and refusals", () => {
		expect(isRefusalOrEmpty("")).toBe(true);
		expect(isRefusalOrEmpty("I cannot help with that")).toBe(true);
		expect(isRefusalOrEmpty("sure, here")).toBe(false);
	});
});

describe("calibration", () => {
	test("fitAxis is OLS, needs MIN_ANCHORS points and some spread", () => {
		const fit = fitAxis([
			{ raw: 0.2, aa: 40 },
			{ raw: 0.5, aa: 60 },
			{ raw: 0.8, aa: 80 },
		]);
		expect(fit).not.toBeNull();
		expect(fit!.slope).toBeCloseTo(66.67, 1);
		expect(fit!.r).toBeCloseTo(1, 5);
		expect(applyFit(fit!, 0.5)).toBeCloseTo(60, 5);
		expect(applyFit(fit!, 5)).toBe(100); // clamped
		expect(fitAxis([{ raw: 0.2, aa: 40 }, { raw: 0.5, aa: 60 }])).toBeNull(); // < MIN_ANCHORS
		expect(fitAxis([{ raw: 0.5, aa: 40 }, { raw: 0.5, aa: 60 }, { raw: 0.5, aa: 80 }])).toBeNull(); // no spread
		// Negative correlation (suite ranks models opposite to AA) is refused.
		expect(fitAxis([{ raw: 0.8, aa: 40 }, { raw: 0.5, aa: 60 }, { raw: 0.2, aa: 80 }])).toBeNull();
	});

	test("fitCalibration + toLocalFeedScores place a target on the AA scale", () => {
		expect(MIN_ANCHORS).toBe(3);
		const anchors: EvalResult[] = [
			{ slug: "a/one", axes: { coding: { sum: 0.2, n: 1 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } }, errors: 0 },
			{ slug: "a/two", axes: { coding: { sum: 0.5, n: 1 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } }, errors: 0 },
			{ slug: "a/three", axes: { coding: { sum: 0.8, n: 1 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } }, errors: 0 },
		];
		const aaOf: Record<string, number> = { "a/one": 40, "a/two": 60, "a/three": 80 };
		const cal = fitCalibration(anchors, (slug, axis) => (axis === "coding" ? aaOf[slug] : undefined));
		expect(cal.coding).toBeDefined();
		expect(cal.intelligence).toBeUndefined(); // no anchor data on that axis

		const targets: EvalResult[] = [
			{ slug: "z/gap", axes: { coding: { sum: 0.5, n: 1 }, intelligence: { sum: 0.9, n: 1 }, agentic: { sum: 0, n: 0 } }, errors: 0 },
		];
		const local = toLocalFeedScores(targets, cal, (s) => s.slice(0, s.indexOf("/")));
		expect(local).toHaveLength(1);
		expect(local[0]).toMatchObject({ key: "gap", creator: "z", source: "local" });
		expect(local[0]!.coding).toBeCloseTo(60, 5); // calibrated from raw 0.5
		expect(local[0]!.intelligence).toBeUndefined(); // axis had no fit, so not emitted
	});
});

describe("runEval", () => {
	test("aggregates grades into per-axis means", async () => {
		const tasks: EvalTask[] = [
			{ id: "c1", axis: "coding", user: "x", grade: (o) => (o === "good" ? 1 : 0) },
			{ id: "c2", axis: "coding", user: "y", grade: () => 0.5 },
			{ id: "a1", axis: "agentic", user: "z", grade: (o) => (o === "good" ? 1 : 0) },
		];
		const results = await runEval({ slugs: ["good", "bad"], tasks, complete: async (slug) => slug });
		const good = results.find((r) => r.slug === "good")!;
		expect(good.axes.coding.sum).toBe(1.5); // 1 + 0.5
		expect(good.axes.coding.n).toBe(2);
		expect(good.axes.agentic.sum).toBe(1);
		const bad = results.find((r) => r.slug === "bad")!;
		expect(bad.axes.coding.sum).toBe(0.5); // 0 + 0.5
		expect(bad.axes.agentic.sum).toBe(0);
	});

	test("a throwing completion is excluded, not scored 0", async () => {
		const tasks: EvalTask[] = [{ id: "a", axis: "coding", user: "x", grade: () => 1 }];
		const results = await runEval({
			slugs: ["m"],
			tasks,
			complete: async () => {
				throw new Error("boom");
			},
		});
		expect(results[0]!.axes.coding.n).toBe(0); // no observation
		expect(results[0]!.errors).toBe(1);
	});
});

describe("local source integration", () => {
	function raw(id: string): Record<string, unknown> {
		return {
			id,
			canonical_slug: id,
			name: id,
			context_length: 131072,
			pricing: { prompt: "0.0000003", completion: "0.0000011" },
			supported_parameters: ["tools"],
			architecture: { input_modalities: ["text"], tokenizer: "Other" },
			created: 1_700_000_000,
		};
	}

	test("local fills only where no stronger source has the axis", () => {
		const catalog = [raw("z-ai/glm-5.3-flash")];
		const feeds: FeedScore[] = [
			{ key: "glm-5-3-flash", creator: "z-ai", source: "artificial_analysis", coding: 61 },
			{ key: "glm-5-3-flash", creator: "z-ai", source: "local", coding: 20, intelligence: 55 },
		];
		const result = applyFeedScores(catalog, feeds);
		const q = normalizeCatalogModel(catalog[0])?.quality;
		expect(q?.coding).toBe(61); // AA wins over local
		expect(q?.intelligence).toBe(55); // local fills the axis nobody else had
		expect(result.sources.local).toBe(1);
		expect(result.sources.artificial_analysis).toBe(1);
	});

	test("saveLocalScores / loadLocalScores round-trip", () => {
		const db = openDb(":memory:");
		const scores: FeedScore[] = [{ key: "muse-glimmer-30b", creator: "meta", source: "local", coding: 42, agentic: 39 }];
		saveLocalScores(db, scores, 123);
		expect(loadLocalScores(db)).toEqual(scores);
		db.close();
	});
});

describe("llm judge", () => {
	test("parseScore takes the last standalone 0-10 and scales to 0-1", () => {
		expect(parseScore("8")).toBeCloseTo(0.8, 5);
		expect(parseScore("Score: 10/10")).toBeCloseTo(1, 5);
		expect(parseScore("I count 3 issues, so 7")).toBeCloseTo(0.7, 5); // last wins
		expect(parseScore("no number here")).toBeNull();
	});

	test("makeJudge parses a score, and returns null on a thrown completion", async () => {
		const task: JudgedTask = { id: "j", axis: "coding", user: "do a thing" };
		const good = makeJudge(async () => "the answer earns 8", "judge/model");
		expect(await good(task, "some answer")).toBeCloseTo(0.8, 5);
		const bad = makeJudge(async () => {
			throw new Error("judge down");
		}, "judge/model");
		expect(await bad(task, "some answer")).toBeNull();
	});

	test("runEval folds judged scores into the axis mean, and drops unscorable ones", async () => {
		const judged: JudgedTask[] = [
			{ id: "j1", axis: "coding", user: "a" },
			{ id: "j2", axis: "coding", user: "b" },
		];
		// j1 scores 0.6; j2 is unscorable (null) → excluded as an error.
		const judge = async (t: JudgedTask) => (t.id === "j1" ? 0.6 : null);
		const results = await runEval({ slugs: ["m"], tasks: [], judged, judge, complete: async () => "ans" });
		expect(results[0]!.axes.coding).toEqual({ sum: 0.6, n: 1 });
		expect(results[0]!.errors).toBe(1);
	});

	test("judged tasks are skipped entirely when no judge is supplied", async () => {
		const judged: JudgedTask[] = [{ id: "j1", axis: "coding", user: "a" }];
		const results = await runEval({ slugs: ["m"], tasks: [], judged, complete: async () => "ans" });
		expect(results[0]!.axes.coding).toEqual({ sum: 0, n: 0 });
		expect(results[0]!.errors).toBe(0);
	});
});
