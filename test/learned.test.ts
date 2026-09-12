import { describe, expect, test } from "bun:test";

import { auc, FEATURE_NAMES, LEARNED_MODEL_VERSION, learnedRiskName, learnedVector, loadLearnedModel, predictRisk, resetLearnedModels, trainLogistic, type LearnedModel } from "../src/router/learned.ts";

/**
 * The learned escalation-risk model: a deterministic logistic regression that
 * must separate a synthetic dataset, score by rank correctly, and tolerate
 * old ledger rows missing fields.
 */

describe("learnedVector", () => {
	test("matches FEATURE_NAMES in length and tolerates missing fields", async () => {
		const v = learnedVector({});
		expect(v).toHaveLength(FEATURE_NAMES.length);
		expect(v.every((x) => x === 0)).toBe(true);
		const w = learnedVector({ promptTokens: 1000, lastToolFailed: true, requestedReasoning: "high", complexityKeywords: ["refactor", "migrate"] });
		expect(w[FEATURE_NAMES.indexOf("log_prompt_tokens")]).toBeCloseTo(Math.log1p(1000), 6);
		expect(w[FEATURE_NAMES.indexOf("last_tool_failed")]).toBe(1);
		expect(w[FEATURE_NAMES.indexOf("requested_reasoning")]).toBe(3);
		expect(w[FEATURE_NAMES.indexOf("complexity_keywords")]).toBe(2);
	});
});

describe("auc", () => {
	test("perfect ranking is 1, inverted is 0, ties count half", async () => {
		expect(auc([0.9, 0.8, 0.1, 0.2], [1, 1, 0, 0])).toBe(1);
		expect(auc([0.1, 0.2, 0.9, 0.8], [1, 1, 0, 0])).toBe(0);
		expect(auc([0.5, 0.5], [1, 0])).toBe(0.5);
		expect(auc([0.3], [1])).toBe(0.5);
	});
});

describe("trainLogistic", () => {
	test("separates a dataset where escalation follows failed tools and long prompts", async () => {
		const xs: number[][] = [];
		const ys: number[] = [];
		let seed = 7;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
		for (let i = 0; i < 2000; i++) {
			const failed = rnd() < 0.1;
			const prompt = Math.floor(rnd() * 150_000);
			const y = failed && prompt > 60_000 ? (rnd() < 0.9 ? 1 : 0) : rnd() < 0.02 ? 1 : 0;
			xs.push(learnedVector({ promptTokens: prompt, lastToolFailed: failed, turnDepth: Math.floor(rnd() * 100), toolCount: 12 }));
			ys.push(y);
		}
		const fit = trainLogistic(xs.slice(0, 1600), ys.slice(0, 1600), { epochs: 300 });
		const model: LearnedModel = { version: 1, trainedAtMs: 0, rows: 1600, positives: 0, names: [...FEATURE_NAMES], means: fit.means, stds: fit.stds, weights: fit.weights, bias: fit.bias, auc: 0 };
		const scores = xs.slice(1600).map((x) => {
			// predictRisk takes features; rebuild the same vector through it for parity.
			const f = { promptTokens: Math.expm1(x[0]!), lastToolFailed: x[8] === 1, turnDepth: x[2]!, toolCount: x[3]! };
			return predictRisk(model, f);
		});
		expect(auc(scores, ys.slice(1600))).toBeGreaterThan(0.85);
		expect(fit.weights[FEATURE_NAMES.indexOf("last_tool_failed")]!).toBeGreaterThan(0);
		expect(fit.weights[FEATURE_NAMES.indexOf("log_prompt_tokens")]!).toBeGreaterThan(0);
	});

	test("refuses an empty dataset", async () => {
		expect(() => trainLogistic([], [])).toThrow();
	});
});

describe("learned label", () => {
	test("a feedback-labelled model loads with its label and names its risk p(bad)", async () => {
		const d = FEATURE_NAMES.length;
		const base: LearnedModel = { version: LEARNED_MODEL_VERSION, trainedAtMs: 0, rows: 100, positives: 10, names: [...FEATURE_NAMES], means: new Array(d).fill(0), stds: new Array(d).fill(1), weights: new Array(d).fill(0), bias: 0, auc: 0.5 };
		expect(learnedRiskName(base)).toBe("escalate");
		expect(learnedRiskName({ ...base, label: "feedback" })).toBe("bad");
		const path = `${import.meta.dir}/../.tmp-learned-feedback.json`;
		await Bun.write(path, JSON.stringify({ ...base, label: "feedback" }));
		try {
			resetLearnedModels();
			const loaded = await loadLearnedModel(path);
			expect(loaded?.label).toBe("feedback");
			expect(learnedRiskName(loaded!)).toBe("bad");
		} finally {
			resetLearnedModels();
			(await Bun.file(path)).delete();
		}
	});
});
