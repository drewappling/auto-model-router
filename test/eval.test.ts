import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import { applyFeedScores, loadLocalScores, saveLocalScores, type FeedScore } from "../src/catalog/benchmark-feeds.ts";
import { answerScore, extractJson, isRefusalOrEmpty, jsonField, tokenCoverage } from "../src/eval/grade.ts";
import { applyFit, fitAxis, fitCalibration, hardRaw, pickAnchors, toLocalFeedScores, MIN_ANCHORS, MIN_R, PUBLISH_MIN_R } from "../src/eval/calibrate.ts";
import { runEval, type EvalResult } from "../src/eval/run.ts";
import { EVAL_TASKS } from "../src/eval/tasks.ts";
import type { QualityAxis } from "../src/config/types.ts";
import { makeJudge, parseScore } from "../src/eval/judge.ts";
import type { EvalTask, JudgedTask } from "../src/eval/tasks.ts";
import { openDb } from "../src/util/sqlite.ts";

describe("grade helpers", () => {
	test("answerScore matches whole reply, last line, or a standalone token", async () => {
		expect(answerScore("9.9", "9.9")).toBe(1);
		expect(answerScore("The answer is 9.9", "9.9")).toBe(1);
		expect(answerScore("reasoning...\n9.9", "9.9")).toBe(1);
		expect(answerScore("19.99", "9.9")).toBe(0); // not a substring match
		expect(answerScore("", "9.9")).toBe(0);
	});
	test("tokenCoverage is the fraction of tokens present", async () => {
		expect(tokenCoverage("return a + b;", ["a + b"])).toBe(1);
		expect(tokenCoverage("n * 2", ["n", "*", "2"])).toBe(1);
		expect(tokenCoverage("n plus two", ["n", "*", "2"])).toBeCloseTo(1 / 3);
	});
	test("extractJson tolerates fences and prose; jsonField reads a key", async () => {
		expect(extractJson('here: {"answer": 8} ok')).toEqual({ answer: 8 });
		expect(extractJson("```json\n[2,3,5]\n```")).toEqual([2, 3, 5]);
		expect(extractJson("no json here")).toBeUndefined();
		expect(jsonField({ tool: "read_file" }, "tool")).toBe("read_file");
		expect(jsonField([1, 2], "tool")).toBeUndefined();
	});
	test("isRefusalOrEmpty flags empties and refusals", async () => {
		expect(isRefusalOrEmpty("")).toBe(true);
		expect(isRefusalOrEmpty("I cannot help with that")).toBe(true);
		expect(isRefusalOrEmpty("sure, here")).toBe(false);
	});
});

describe("calibration", () => {
	test("fitAxis is OLS, needs MIN_ANCHORS points and some spread", async () => {
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

	test("pickAnchors spreads over the score range, skips the target and the unscored", async () => {
		const m = (slug: string, coding: number | undefined, supportsTools = true) => ({ slug, quality: coding === undefined ? {} : { coding }, supportsTools });
		const catalog = [m("a/10", 10), m("a/30", 30), m("a/50", 50), m("a/70", 70), m("a/90", 90), m("a/target", undefined), m("a/notools", 60, false)];
		const picked = pickAnchors(catalog, "a/target");
		// Both extremes, so the fitted line spans the scale rather than a cluster.
		expect(picked).toContain("a/10");
		expect(picked).toContain("a/90");
		expect(picked.length).toBeGreaterThanOrEqual(MIN_ANCHORS);
		// An unscored model cannot anchor anything, and one that cannot call tools would fail
		// the suite's tool tasks for a reason unrelated to its quality.
		expect(picked).not.toContain("a/target");
		expect(picked).not.toContain("a/notools");
		// Refuses rather than fitting a line through too few points.
		expect(pickAnchors([m("a/10", 10), m("a/90", 90)], "a/target")).toEqual([]);
		// The target is excluded even when it is itself scored (a re-measurement).
		expect(pickAnchors(catalog, "a/50")).not.toContain("a/50");
	});

	test("repeats pool observations, report spread, and split scores by complexity", async () => {
		// A flaky model: the strict-format task passes on odd calls only. One pass cannot tell
		// that apart from a model that always passes or always fails.
		let call = 0;
		const flaky = async (_slug: string, messages: { role: string; content: string }[]) => {
			call += 1;
			const user = messages[messages.length - 1]!.content;
			if (user.includes("primary colours")) return call % 2 === 0 ? "red blue yellow" : "Red, Blue, and Yellow!";
			return "";
		};
		const [single] = await runEval({ slugs: ["a/flaky"], complete: flaky, tasks: EVAL_TASKS.filter((t) => t.id === "intel/strict-format") });
		expect(single!.repeats).toBe(1);
		expect(single!.spread).toEqual({});

		call = 0;
		const [many] = await runEval({ slugs: ["a/flaky"], complete: flaky, tasks: EVAL_TASKS.filter((t) => t.id === "intel/strict-format"), repeats: 10 });
		expect(many!.repeats).toBe(10);
		expect(many!.axes.intelligence.n).toBe(10);
		// Half the passes score 1 and half 0, so the pooled mean sits mid-range and the spread
		// says plainly that the headline is one sample of something noisy.
		expect(many!.axes.intelligence.sum / many!.axes.intelligence.n).toBeCloseTo(0.5, 1);
		expect(many!.spread.intelligence).toBe(1);
		// That task is in the hard band, so the breakdown attributes it there and nowhere else.
		expect(many!.byComplexity.hard?.n).toBe(10);
		expect(many!.byComplexity.easy).toBeUndefined();
	});

	test("the suite spans complexities, and hard items are not all pinned at the ceiling", async () => {
		const bands = new Set(EVAL_TASKS.map((t) => t.complexity ?? "easy"));
		expect(bands.has("easy")).toBe(true);
		expect(bands.has("hard")).toBe(true);
		// A perfect model must still score 1 on every hard task: a task nobody can pass
		// measures the grader, not the model.
		const hard = EVAL_TASKS.filter((t) => t.complexity === "hard");
		expect(hard.length).toBeGreaterThanOrEqual(6);
		expect(hard.find((t) => t.id === "coding/sort-lexicographic")!.grade("[10, 80, 9]")).toBe(1);
		expect(hard.find((t) => t.id === "coding/event-loop-order")!.grade("a, d, c, b")).toBe(1);
		expect(hard.find((t) => t.id === "intel/collatz-steps")!.grade("13")).toBe(1);
		expect(hard.find((t) => t.id === "intel/arith-hard")!.grade("2491\n8192\n59\n36\n6")).toBe(1);
		expect(hard.find((t) => t.id === "coding/trace-hard")!.grade("4\nxyabc\nab\n0\n3")).toBe(1);
		// And a plausible wrong answer must NOT score 1, or the task adds no signal.
		expect(hard.find((t) => t.id === "coding/sort-lexicographic")!.grade("[9, 10, 80]")).toBeLessThan(1);
		expect(hard.find((t) => t.id === "intel/collatz-steps")!.grade("1")).toBeLessThan(1);
		expect(hard.find((t) => t.id === "intel/strict-format")!.grade("Red, blue, and yellow.")).toBeLessThan(1);
		// The second hard band: computable only, no recall shortcut.
		expect(hard.find((t) => t.id === "coding/stack-machine")!.grade("-32")).toBe(1);
		expect(hard.find((t) => t.id === "coding/stack-machine")!.grade("-16")).toBeLessThan(1);
		expect(hard.find((t) => t.id === "intel/ledger-balance")!.grade("60")).toBe(1);
		expect(hard.find((t) => t.id === "intel/ledger-balance")!.grade("61")).toBeLessThan(1);
		expect(hard.find((t) => t.id === "intel/constraint-conflict")!.grade("IMPOSSIBLE")).toBe(1);
		expect(hard.find((t) => t.id === "intel/constraint-conflict")!.grade("12")).toBe(0);
		expect(hard.find((t) => t.id === "coding/regex-backtrack")!.grade("XX\nab\nfalse\nx|y\na[b$]c")).toBe(1);
	});

	test("fitCalibration + toLocalFeedScores place a target on the AA scale", async () => {
		expect(MIN_ANCHORS).toBe(3);
		const anchors: EvalResult[] = [
			{ slug: "a/one", axes: { coding: { sum: 0.2, n: 1 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } }, errors: 0, repeats: 1, spread: {}, byComplexity: {}, axesHard: { coding: { sum: 0, n: 0 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } } },
			{ slug: "a/two", axes: { coding: { sum: 0.5, n: 1 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } }, errors: 0, repeats: 1, spread: {}, byComplexity: {}, axesHard: { coding: { sum: 0, n: 0 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } } },
			{ slug: "a/three", axes: { coding: { sum: 0.8, n: 1 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } }, errors: 0, repeats: 1, spread: {}, byComplexity: {}, axesHard: { coding: { sum: 0, n: 0 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } } },
		];
		const aaOf: Record<string, number> = { "a/one": 40, "a/two": 60, "a/three": 80 };
		const cal = fitCalibration(anchors, (slug, axis) => (axis === "coding" ? aaOf[slug] : undefined));
		expect(cal.coding).toBeDefined();
		expect(cal.intelligence).toBeUndefined(); // no anchor data on that axis

		const targets: EvalResult[] = [
			{ slug: "z/gap", axes: { coding: { sum: 0.5, n: 1 }, intelligence: { sum: 0.9, n: 1 }, agentic: { sum: 0, n: 0 } }, errors: 0, repeats: 1, spread: {}, byComplexity: {}, axesHard: { coding: { sum: 0, n: 0 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } } },
		];
		const local = toLocalFeedScores(targets, cal, (s) => s.slice(0, s.indexOf("/")));
		expect(local).toHaveLength(1);
		expect(local[0]).toMatchObject({ key: "gap", creator: "z", source: "local" });
		expect(local[0]!.coding).toBeCloseTo(60, 5); // calibrated from raw 0.5
		expect(local[0]!.intelligence).toBeUndefined(); // axis had no fit, so not emitted
	});

	test("calibrating on the hard band beats calibrating on everything", async () => {
		// Three anchors published 20/50/80 apart. On the FULL suite they all score ~0.97
		// because easy and moderate pin everyone at the ceiling; on the hard band alone they
		// separate. Same models, same publishing, different x — and only one of them can fit.
		const mk = (slug: string, full: number, hard: number): EvalResult => ({
			slug,
			axes: { coding: { sum: full, n: 1 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } },
			axesHard: { coding: { sum: hard, n: 1 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } },
			errors: 0,
			repeats: 1,
			spread: {},
			byComplexity: {},
		});
		const anchors = [mk("a/low", 0.96, 0.2), mk("a/mid", 0.97, 0.5), mk("a/high", 0.98, 0.8)];
		const aa: Record<string, number> = { "a/low": 20, "a/mid": 50, "a/high": 80 };
		const published = (slug: string, axis: QualityAxis) => (axis === "coding" ? aa[slug] : undefined);
		const target = mk("z/target", 0.97, 0.5);

		const onHard = toLocalFeedScores([target], fitCalibration(anchors, published, hardRaw), () => "z", hardRaw);
		// The hard band spans 0.2-0.8 against 20-80, so the fit is a real line: raw 0.5 ⇒ ~50.
		expect(onHard[0]!.coding).toBeCloseTo(50, 0);

		// On the full suite the anchors span 0.96-0.98: the same published spread compressed into
		// a fiftieth of the range. That is the shallow slope that produced 22.8 for a model
		// published at 39.5, so the fit must be refused rather than published.
		const pooledFit = fitCalibration(anchors, published);
		const pooled = toLocalFeedScores([target], pooledFit, () => "z");
		expect(pooled).toEqual([]);
	});

	test("a weak fit is refused, not published", async () => {
		// Points with a real but noisy relationship: computable (r >= MIN_R) yet not worth
		// acting on. `r` and `n` used to be computed and then thrown away.
		const noisy = [
			{ raw: 0.1, aa: 20 },
			{ raw: 0.5, aa: 70 },
			{ raw: 0.6, aa: 30 },
			{ raw: 0.9, aa: 60 },
		];
		const fit = fitAxis(noisy)!;
		expect(fit.r).toBeGreaterThanOrEqual(MIN_R);
		expect(fit.r).toBeLessThan(PUBLISH_MIN_R);
		const target: EvalResult = {
			slug: "z/t",
			axes: { coding: { sum: 0.5, n: 1 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } },
			axesHard: { coding: { sum: 0.5, n: 1 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } },
			errors: 0,
			repeats: 1,
			spread: {},
			byComplexity: {},
		};
		expect(toLocalFeedScores([target], { coding: fit }, () => "z", hardRaw)).toEqual([]);
		// A caller that deliberately lowers the bar still can, so the gate is policy not dogma.
		expect(toLocalFeedScores([target], { coding: fit }, () => "z", hardRaw, MIN_R)[0]!.coding).toBeGreaterThan(0);
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

	test("local fills only where no stronger source has the axis", async () => {
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

	test("saveLocalScores / loadLocalScores round-trip", async () => {
		const db = openDb(":memory:");
		const scores: FeedScore[] = [{ key: "muse-glimmer-30b", creator: "meta", source: "local", coding: 42, agentic: 39 }];
		saveLocalScores(db, scores, 123);
		expect(loadLocalScores(db)).toEqual(scores);
		db.close();
	});
});

describe("llm judge", () => {
	test("parseScore takes the last standalone 0-10 and scales to 0-1", async () => {
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
