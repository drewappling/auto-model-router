import { describe, expect, test } from "bun:test";

import { joinBenchmarks, normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot } from "../src/catalog/types.ts";
import type { Ledger } from "../src/cost/types.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { buildCandidates } from "../src/router/candidates.ts";
import { extractFeatures } from "../src/router/features.ts";
import { computeTierPlan, countAdmitted, effectivePriceCeiling, effectiveQualityFloor, tierPlanFor } from "../src/router/tier-plan.ts";
import { TIER_ORDER } from "../src/router/types.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";

// SHIPPED defaults, deliberately NOT loadConfig({}): that reads the developer's
// live ~/.auto-model-router/config.yml, so an enabled machine-wide knob (e.g.
// tiers.hard.capabilityFloorUsd during the 0.2.20 rollout) silently changed
// these expectations and made the suite machine-dependent.
const BASE = DEFAULT_CONFIG;

/** Raw `/models`-shaped record with a controllable coding score and price. */
function raw(id: string, coding: number | null, inPerMtok: number): Record<string, unknown> {
	const record: Record<string, unknown> = {
		id,
		canonical_slug: id,
		name: id,
		context_length: 200_000,
		pricing: { prompt: String(inPerMtok / 1e6), completion: String((inPerMtok * 3) / 1e6) },
		supported_parameters: ["tools"],
		architecture: { input_modalities: ["text"], tokenizer: "GPT" },
		created: 1_700_000_000,
	};
	if (coding !== null) {
		record.benchmarks = { artificial_analysis: { coding_index: coding, intelligence_index: coding, agentic_index: coding } };
	}
	return record;
}

function models(specs: ReadonlyArray<[string, number | null, number]>): CatalogModel[] {
	const out: CatalogModel[] = [];
	for (const [id, coding, price] of specs) {
		const m = normalizeCatalogModel(raw(id, coding, price));
		if (m !== null) out.push(m);
	}
	return out;
}

function snapshot(list: CatalogModel[]): CatalogSnapshot {
	return { models: list, fetchedAtMs: Date.now(), keyScoped: true };
}

describe("joinBenchmarks", () => {
	test("copies benchmarks onto key-scoped records matched by id", () => {
		const keyScoped = [{ id: "a/one" }, { id: "b/two" }];
		const pub = [
			{ id: "a/one", benchmarks: { artificial_analysis: { coding_index: 70 } } },
			{ id: "c/three", benchmarks: { artificial_analysis: { coding_index: 10 } } },
		];
		expect(joinBenchmarks(keyScoped, pub)).toBe(1);
		expect(keyScoped[0]).toHaveProperty("benchmarks");
		expect(keyScoped[1]).not.toHaveProperty("benchmarks");
	});

	test("falls back to canonical_slug", () => {
		const keyScoped = [{ id: "vendor/model-preview", canonical_slug: "vendor/model" }];
		const pub = [{ id: "vendor/model", benchmarks: { artificial_analysis: { coding_index: 55 } } }];
		expect(joinBenchmarks(keyScoped, pub)).toBe(1);
	});

	test("strips a leading ~ from an alias id", () => {
		const keyScoped = [{ id: "~vendor/model-latest" }];
		const pub = [{ id: "vendor/model-latest", benchmarks: { artificial_analysis: { coding_index: 60 } } }];
		expect(joinBenchmarks(keyScoped, pub)).toBe(1);
	});

	/** Reads the joined coding index off a raw record without narrowing games. */
	function codingOf(record: unknown): number | undefined {
		const rec = record as { benchmarks?: { artificial_analysis?: { coding_index?: number } } };
		return rec.benchmarks?.artificial_analysis?.coding_index;
	}

	test("never overwrites benchmarks that are already present", () => {
		const keyScoped: unknown[] = [{ id: "a/one", benchmarks: { artificial_analysis: { coding_index: 1 } } }];
		const pub: unknown[] = [{ id: "a/one", benchmarks: { artificial_analysis: { coding_index: 99 } } }];
		expect(joinBenchmarks(keyScoped, pub)).toBe(0);
		expect(codingOf(keyScoped[0])).toBe(1);
	});

	test("a real id beats an alias target for the same key", () => {
		const keyScoped: unknown[] = [{ id: "vendor/model" }];
		const pub: unknown[] = [
			{ id: "other/model", canonical_slug: "vendor/model", benchmarks: { artificial_analysis: { coding_index: 10 } } },
			{ id: "vendor/model", benchmarks: { artificial_analysis: { coding_index: 80 } } },
		];
		joinBenchmarks(keyScoped, pub);
		expect(codingOf(keyScoped[0])).toBe(80);
	});

	test("tolerates junk records on both sides", () => {
		expect(joinBenchmarks([null, 7, "x"], [null, { id: "a" }])).toBe(0);
	});

	test("normalizing a joined record yields a scored model", () => {
		const keyScoped: unknown[] = [raw("a/one", null, 1)];
		joinBenchmarks(keyScoped, [raw("a/one", 66, 1)]);
		const model = normalizeCatalogModel(keyScoped[0]);
		expect(model?.quality.coding).toBe(66);
	});
});

describe("computeTierPlan", () => {
	test("bands ascend across tiers", () => {
		const plan = computeTierPlan(
			models([
				["a/1", 10, 0.1],
				["a/2", 30, 0.1],
				["a/3", 50, 0.1],
				["a/4", 70, 0.1],
			]),
			BASE,
		);
		const f = plan.floors.coding;
		expect(f.trivial).toBe(10);
		expect(f.simple).toBe(30);
		expect(f.moderate).toBe(50);
		expect(f.hard).toBe(70);
	});

	test("an all-unscored catalog yields zero floors, never an imputed score", () => {
		const plan = computeTierPlan(
			models([
				["a/1", null, 0.1],
				["a/2", null, 5],
			]),
			BASE,
		);
		for (const tier of TIER_ORDER) expect(plan.floors.coding[tier]).toBe(0);
		expect(plan.scoredCount.coding).toBe(0);
	});

	test("every tier floor is met by at least one available model", () => {
		const list = models([
			["a/1", 12, 0.1],
			["a/2", 44, 0.2],
			["a/3", 61, 0.3],
			["a/4", 63, 0.4],
			["a/5", 77, 0.5],
		]);
		const plan = computeTierPlan(list, BASE);
		for (const tier of TIER_ORDER) {
			const floor = plan.floors.coding[tier];
			expect(list.some((m) => (m.quality.coding ?? -1) >= floor), `tier ${tier} floor ${floor}`).toBe(true);
		}
	});

	test("excludes built-in denials from the ranking", () => {
		// The batch entry is cheap and scored, but selection can never pick it,
		// so it must not drag the bands down.
		const plan = computeTierPlan(
			models([
				["a/1:batch", 1, 0.1],
				["~a/latest", 2, 0.1],
				["a/2", 70, 0.1],
			]),
			BASE,
		);
		expect(plan.scoredCount.coding).toBe(1);
		expect(plan.floors.coding.trivial).toBe(70);
	});

	test("a single scored model puts that model in every tier", () => {
		const plan = computeTierPlan(models([["a/1", 42, 0.1]]), BASE);
		for (const tier of TIER_ORDER) expect(plan.floors.coding[tier]).toBe(42);
	});

	test("scores each axis independently", () => {
		const plan = computeTierPlan(models([["a/1", 30, 0.1]]), BASE);
		expect(plan.scoredCount.coding).toBe(1);
		expect(plan.scoredCount.agentic).toBe(1);
		expect(plan.scoredCount.intelligence).toBe(1);
	});
});

describe("effectiveQualityFloor", () => {
	const plan = computeTierPlan(
		models([
			["a/1", 20, 0.1],
			["a/2", 40, 0.1],
			["a/3", 60, 0.1],
			["a/4", 80, 0.1],
		]),
		BASE,
	);

	test("relaxes a floor the catalog cannot meet", () => {
		expect(effectiveQualityFloor(95, "hard", "coding", plan)).toBe(80);
	});

	test("never tightens a floor the catalog exceeds", () => {
		expect(effectiveQualityFloor(10, "hard", "coding", plan)).toBe(10);
	});

	test("is a no-op when configured equals adaptive", () => {
		expect(effectiveQualityFloor(80, "hard", "coding", plan)).toBe(80);
	});
});

describe("tierPlanFor", () => {
	test("memoizes per snapshot object", () => {
		const snap = snapshot(models([["a/1", 50, 0.1]]));
		expect(tierPlanFor(snap, BASE)).toBe(tierPlanFor(snap, BASE));
	});

	test("a new snapshot recomputes, so a refresh tracks availability", () => {
		const first = snapshot(models([["a/1", 50, 0.1]]));
		const second = snapshot(models([["a/1", 50, 0.1], ["a/2", 90, 0.1]]));
		expect(tierPlanFor(second, BASE)).not.toBe(tierPlanFor(first, BASE));
		expect(tierPlanFor(second, BASE).floors.coding.hard).toBe(90);
	});
});

describe("adaptive floors in candidate selection", () => {
	const req = parseChatRequest(
		{
			model: "auto",
			tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {} } } }],
			messages: [{ role: "user", content: "refactor the auth module" }],
		},
		new Headers(),
	);
	const features = extractFeatures(req, 100);

	// Every model scores far below the configured `hard` floor of 72.
  const lowCatalog = snapshot(
		models([
			["a/1", 20, 0.05],
			["a/2", 30, 0.06],
			["a/3", 40, 0.07],
			["a/4", 50, 0.08],
		]),
	);

	function build(cfg: typeof BASE) {
		return buildCandidates({
			req,
			features,
			tier: "hard",
			task: "coding",
			snapshot: lowCatalog,
			ledger: null,
			cfg,
			expectedCompletionTokens: 512,
			warmSlug: null,
		});
	}

	test("hard is empty with adaptive floors off", () => {
		const { candidates } = build({ ...BASE, adaptiveTierFloors: false });
		expect(candidates).toHaveLength(0);
	});

	test("hard still selects the best available with adaptive floors on", () => {
		const { candidates } = build({ ...BASE, adaptiveTierFloors: true });
		expect(candidates.length).toBeGreaterThan(0);
		// The top band is the best-scoring model, not the cheapest.
		expect(candidates.some((c) => c.model.slug === "a/4")).toBe(true);
	});

	test("adaptive floors still order the tiers apart", () => {
		const cfg = { ...BASE, adaptiveTierFloors: true };
		const best = (tier: "trivial" | "hard"): number => {
			const { candidates } = buildCandidates({
				req,
				features,
				tier,
				task: "coding",
				snapshot: lowCatalog,
				ledger: null,
				cfg,
				expectedCompletionTokens: 512,
				warmSlug: null,
			});
			return Math.max(...candidates.map((c) => c.model.quality.coding ?? 0));
		};
		// `hard` must not admit a strictly worse best-model than `trivial`.
		expect(best("hard")).toBeGreaterThanOrEqual(best("trivial"));
	});

	test("excludeSlugs removes a model from the candidate set", () => {
		const cfg = { ...BASE, adaptiveTierFloors: true };
		const all = build(cfg).candidates.map((c) => c.model.slug);
		const target = all[0];
		expect(target).toBeDefined();
		const { candidates, rejected } = buildCandidates({
			req,
			features,
			tier: "hard",
			task: "coding",
			snapshot: lowCatalog,
			ledger: null,
			cfg,
			expectedCompletionTokens: 512,
			warmSlug: null,
			excludeSlugs: [target ?? ""],
		});
		expect(candidates.map((c) => c.model.slug)).not.toContain(target);
		expect(rejected.some((r) => r.slug === target && r.reason === "failed_this_turn")).toBe(true);
	});
});

describe("adaptive price ceilings", () => {
	const priced = models([
		["a/1", 80, 1],
		["a/2", 80, 2],
		["a/3", 80, 3],
		["a/4", 80, 4],
	]);
	const req = parseChatRequest(
		{
			model: "auto",
			tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {} } } }],
			messages: [{ role: "user", content: "refactor the auth module" }],
		},
		new Headers(),
	);
	const features = extractFeatures(req, 100);

	test("computeTierPlan derives per-tier price bands from the catalog", () => {
		const plan = computeTierPlan(priced, BASE);
		expect(plan.priceCeilings).toEqual({ trivial: 1, simple: 2, moderate: 3, hard: 4 });
	});

	test("effectivePriceCeiling: band when on, tighter of config/band, config when off", () => {
		const plan = computeTierPlan(priced, BASE);
		expect(effectivePriceCeiling(undefined, "moderate", plan, true)).toBe(3); // band
		expect(effectivePriceCeiling(2, "moderate", plan, true)).toBe(2); // config tightens
		expect(effectivePriceCeiling(10, "moderate", plan, true)).toBe(3); // band tightens
		expect(effectivePriceCeiling(2, "moderate", plan, false)).toBe(2); // off ⇒ config
		expect(effectivePriceCeiling(undefined, "hard", plan, false)).toBeUndefined();
	});

	test("a model above the adaptive band is dropped in candidate selection", () => {
		const snap = snapshot(priced);
		const run = (adaptivePriceCeilings: boolean) =>
			buildCandidates({
				req,
				features,
				tier: "moderate",
				task: "coding",
				snapshot: snap,
				ledger: null,
				cfg: { ...BASE, adaptivePriceCeilings },
				expectedCompletionTokens: 512,
				warmSlug: null,
			});
		// Off: the fixed moderate ceiling ($4) admits a/4 at $4.
		expect(run(false).candidates.map((c) => c.model.slug)).toContain("a/4");
		// On: the catalog band tightens moderate to $3, so a/4 is over-ceiling.
		const on = run(true);
		expect(on.candidates.map((c) => c.model.slug)).not.toContain("a/4");
		expect(on.rejected.some((r) => r.slug === "a/4" && r.reason === "over_price_ceiling")).toBe(true);
	});
});

describe("quality normalization and capability floor (benchmark findings 4/6)", () => {
	const req = parseChatRequest(
		{
			model: "auto",
			tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {} } } }],
			messages: [{ role: "user", content: "implement nested transaction savepoints" }],
		},
		new Headers(),
	);
	const features = extractFeatures(req, 100);

	// The real catalog's shape: quality in a narrow band, price spanning ~100x.
	// `hard` has a quality floor of 72, so cheap/1 is deliberately below it —
	// it must be rejected, and mid/2 is the cheapest ELIGIBLE model, the one
	// raw quality-per-dollar ranking picks at any sane exponent.
	const spread = snapshot(
		models([
			["cheap/1", 70, 0.05],
			["mid/2", 74, 1.0],
			["good/3", 76, 3.0],
			["best/4", 78, 5.0],
		]),
	);

	const run = (tierOverride: Partial<(typeof BASE)["tiers"]["hard"]>) =>
		buildCandidates({
			req,
			features,
			tier: "hard",
			task: "coding",
			snapshot: spread,
			ledger: null,
			cfg: { ...BASE, tiers: { ...BASE.tiers, hard: { ...BASE.tiers.hard, ...tierOverride } } },
			expectedCompletionTokens: 512,
			warmSlug: null,
		});

	test("raw scoring at the shipped exponent picks the cheapest ELIGIBLE model", () => {
		const { candidates, rejected } = run({ qualityExponent: 3 });
		expect(candidates[0]?.model.slug).toBe("mid/2");
		// cheap/1 is under the hard floor of 72 and never competes.
		expect(rejected.some((r) => r.slug === "cheap/1" && r.reason === "below_quality_floor")).toBe(true);
	});

	test("normalization lets a single-digit exponent buy the best model, which raw cannot", () => {
		// Raw at the same exponent still cannot reach it: that is the defect.
		expect(run({ qualityExponent: 12 }).candidates[0]?.model.slug).toBe("mid/2");
		// Normalised, the same 12 selects the top-quality model.
		const normalised = run({ qualityExponent: 12, qualityNormalization: true });
		expect(normalised.candidates[0]?.model.slug).toBe("best/4");
		expect(normalised.candidates[0]?.reasons.some((r) => r.includes("quality normalised"))).toBe(true);
	});

	test("normalization is monotone in the exponent: higher never picks a weaker model", () => {
		let lastQuality = 0;
		for (const qualityExponent of [1, 4, 8, 12, 20]) {
			const top = run({ qualityExponent, qualityNormalization: true }).candidates[0];
			expect(top).toBeDefined();
			expect(top?.qualityScore ?? 0).toBeGreaterThanOrEqual(lastQuality);
			lastQuality = top?.qualityScore ?? 0;
		}
	});

	test("capability floor takes the best model inside the cap, ignoring the ratio", () => {
		// mid/2 costs ~$0.0016 and good/3 ~$0.0049, so this cap admits both but
		// excludes best/4 (~$0.0082). The ranked winner is mid/2 (cheapest).
		const cap = 0.005;
		const capped = run({ capabilityFloorUsd: cap });
		const top = capped.candidates[0];
		expect(top).toBeDefined();
		expect(top?.forecast.coldUsd ?? 1).toBeLessThanOrEqual(cap);
		// It must be the highest-quality affordable one, not the cheapest: good/3.
		expect(top?.model.slug).toBe("good/3");
		expect(top?.reasons.some((r) => r.includes("capability floor"))).toBe(true);
	});

	test("capability floor is strictly an upgrade: an unaffordable cap changes nothing", () => {
		const base = run({}).candidates.map((c) => c.model.slug);
		// A cap below every candidate's cost promotes nobody.
		const tiny = run({ capabilityFloorUsd: 1e-9 }).candidates.map((c) => c.model.slug);
		expect(tiny).toEqual(base);
	});

	test("both modes stay inert by default, so shipped behaviour is unchanged", () => {
		const shipped = run({});
		expect(shipped.candidates[0]?.model.slug).toBe("mid/2");
		expect(shipped.candidates.every((c) => !c.reasons.some((r) => r.includes("normalised")))).toBe(true);
		expect(shipped.candidates.every((c) => !c.reasons.some((r) => r.includes("capability floor")))).toBe(true);
	});
});

describe("thinness-gated relaxation (review 2026-09-05 §1)", () => {
	// A WIDE catalog whose weak tail drags every quantile band far below the
	// configured floors — the shape the key-admitted 347-model catalog has.
	// Configured coding floors: simple 40, moderate 60, hard 72.
	const wide = computeTierPlan(
		models([
			["w/1", 5, 0.02],
			["w/2", 10, 0.02],
			["w/3", 15, 0.03],
			["w/4", 20, 0.03],
			["w/5", 25, 0.05],
			["w/6", 30, 0.05],
			["w/7", 35, 0.1],
			["w/8", 45, 0.1],
			["w/9", 50, 0.2],
			["w/10", 62, 0.5],
			["w/11", 70, 0.7],
			["w/12", 74, 1.0],
			["w/13", 76, 2.0],
			["w/14", 78, 5.0],
		]),
		BASE,
	);

	test("the bands sit below the configured floors on a wide catalog", () => {
		// The premise the gate exists for: unconditional min() would relax here.
		expect(wide.floors.coding.moderate).toBeLessThan(60);
		expect(wide.floors.coding.hard).toBeLessThan(72);
	});

	test("a configured floor that three or more models meet stands as written", () => {
		expect(effectiveQualityFloor(60, "moderate", "coding", wide)).toBe(60); // 62,70,74,76,78 meet it
		expect(effectiveQualityFloor(72, "hard", "coding", wide)).toBe(72); // 74,76,78 meet it
		expect(effectiveQualityFloor(40, "simple", "coding", wide)).toBe(40);
	});

	test("a floor fewer than three models meet is relaxed to the band", () => {
		// Only 76 and 78 clear 75: thin, so the hard band applies.
		expect(effectiveQualityFloor(75, "hard", "coding", wide)).toBe(Math.min(75, wide.floors.coding.hard));
		// Nothing clears 90: relaxed as before.
		expect(effectiveQualityFloor(90, "hard", "coding", wide)).toBe(wide.floors.coding.hard);
	});

	test("countAdmitted counts scores at or above the floor", () => {
		expect(countAdmitted([10, 20, 30, 40], 25)).toBe(2);
		expect(countAdmitted([10, 20, 30, 40], 40)).toBe(1);
		expect(countAdmitted([10, 20, 30, 40], 41)).toBe(0);
		expect(countAdmitted([10, 20, 30, 40], 0)).toBe(4);
		expect(countAdmitted([], 0)).toBe(0);
	});

	test("in candidate selection the wide catalog keeps weak models out of moderate", () => {
		const req = parseChatRequest(
			{
				model: "auto",
				tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {} } } }],
				messages: [{ role: "user", content: "refactor the auth module" }],
			},
			new Headers(),
		);
		const features = extractFeatures(req, 100);
		const snap = snapshot(
			models([
				["w/8", 45, 0.1],
				["w/9", 50, 0.2],
				["w/10", 62, 0.5],
				["w/11", 70, 0.7],
				["w/12", 74, 1.0],
			]),
		);
		const { candidates, rejected } = buildCandidates({
			req,
			features,
			tier: "moderate",
			task: "coding",
			snapshot: snap,
			ledger: null,
			cfg: { ...BASE, adaptiveTierFloors: true },
			expectedCompletionTokens: 512,
			warmSlug: null,
		});
		// 62, 70 and 74 meet the configured 60, so 45 and 50 are excluded even
		// though the adaptive band would have admitted them.
		expect(candidates.map((c) => c.model.slug).sort()).toEqual(["w/10", "w/11", "w/12"]);
		expect(rejected.filter((r) => r.reason === "below_quality_floor").map((r) => r.slug).sort()).toEqual(["w/8", "w/9"]);
	});
});

describe("escalation-cost term (review 2026-09-05 §2)", () => {
	const req = parseChatRequest(
		{
			model: "auto",
			tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {} } } }],
			messages: [{ role: "user", content: "rename the helper" }],
		},
		new Headers(),
	);
	const features = extractFeatures(req, 100_000);
	// Identical price, quality AND success rate (so the trust divisor is
	// neutral); only the escalation count tells them apart.
	const snap = snapshot(
		models([
			["cheap/flaky", 50, 0.02],
			["cheap/solid", 50, 0.02],
		]),
	);
	const trustOf = (slug: string) =>
		slug === "cheap/flaky"
			? { slug, attempts: 100, escalations: 4, errors: 0, successRate: 0.96, meanCostError: 0 }
			: { slug, attempts: 100, escalations: 0, errors: 4, successRate: 0.96, meanCostError: 0 };
	const ledger: Ledger = {
		record: () => {},
		conversationSpend: () => 0,
		spendSince: () => 0,
		blendedRate: () => null,
		trust: (slug) => trustOf(slug),
		allTrust: () => [],
		latency: () => null,
		tokenRatio: () => null,
		recentEntries: () => [],
	};
	function build(weight: number, usdPerPromptToken?: number) {
		return buildCandidates({
			req,
			features,
			tier: "trivial",
			task: "coding",
			snapshot: snap,
			ledger,
			cfg: { ...BASE, filters: { ...BASE.filters, escalationCostWeight: weight } },
			expectedCompletionTokens: 512,
			warmSlug: null,
			...(usdPerPromptToken === undefined ? {} : { escalationUsdPerPromptToken: usdPerPromptToken }),
		});
	}

	test("with the term off, nothing separates them and the tie falls lexically to the flaky model", () => {
		const { candidates } = build(0, 1e-6);
		// Same success rate, same trust divisor: escalations are invisible.
		expect(candidates[0]!.model.slug).toBe("cheap/flaky");
		expect(candidates[0]!.reasons.some((r) => r.startsWith("escalation risk"))).toBe(false);
	});

	test("priced at what an escalated retry actually bills, the flaky model loses", () => {
		const { candidates } = build(1, 1e-6); // $1/Mtok of escalated-retry cost
		expect(candidates[0]!.model.slug).toBe("cheap/solid");
		const flaky = candidates.find((c) => c.model.slug === "cheap/flaky")!;
		expect(flaky.reasons.some((r) => r.startsWith("escalation risk"))).toBe(true);
	});

	test("inert until the ledger can measure the retry cost", () => {
		const { candidates } = build(1);
		expect(candidates[0]!.model.slug).toBe("cheap/flaky");
	});
});

