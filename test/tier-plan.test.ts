import { describe, expect, test } from "bun:test";

import { joinBenchmarks, normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot } from "../src/catalog/types.ts";
import { loadConfig } from "../src/config/load.ts";
import { buildCandidates } from "../src/router/candidates.ts";
import { extractFeatures } from "../src/router/features.ts";
import { computeTierPlan, effectivePriceCeiling, effectiveQualityFloor, tierPlanFor } from "../src/router/tier-plan.ts";
import { TIER_ORDER } from "../src/router/types.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";

const BASE = loadConfig({});

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
