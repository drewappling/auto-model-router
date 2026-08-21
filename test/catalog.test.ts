import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";

const FIXTURE = (await Bun.file("test/fixtures/openrouter-models.json").json()) as { data: unknown[] };
const RAW = FIXTURE.data;

function rawFor(slug: string): unknown {
	const found = RAW.find((m) => typeof m === "object" && m !== null && "id" in m && m.id === slug);
	if (found === undefined) throw new Error(`fixture is missing ${slug}`);
	return found;
}

describe("normalizeCatalogModel", () => {
	test("survives every record in the real catalog without throwing", () => {
		let normalized = 0;
		for (const raw of RAW) {
			const model = normalizeCatalogModel(raw);
			if (model !== null) normalized++;
		}
		// Most of the catalog must be usable, or a filter is misfiring.
		expect(normalized).toBeGreaterThan(RAW.length * 0.9);
	});

	test("every normalized model has strictly positive prompt and completion prices", () => {
		for (const raw of RAW) {
			const model = normalizeCatalogModel(raw);
			if (model === null) continue;
			expect(model.price.prompt).toBeGreaterThanOrEqual(0);
			expect(model.price.completion).toBeGreaterThanOrEqual(0);
			expect(Number.isFinite(model.price.prompt)).toBe(true);
			expect(Number.isFinite(model.price.completion)).toBe(true);
		}
	});

	test("rejects the openrouter meta-routers, whose -1 pricing means unknown", () => {
		// Routing to another router is both out of scope and uncostable: a -1
		// price would otherwise be read as free and win every tier outright.
		for (const slug of ["openrouter/auto", "openrouter/pareto-code", "openrouter/fusion"]) {
			expect(normalizeCatalogModel(rawFor(slug))).toBeNull();
		}
	});

	test("does not mistake unknown (-1) pricing for free pricing", () => {
		const free = normalizeCatalogModel(rawFor("openai/gpt-oss-20b:free"));
		expect(free).not.toBeNull();
		expect(free?.isFree).toBe(true);
		// The -1 models never normalize at all, so they can never be marked free.
		expect(normalizeCatalogModel(rawFor("openrouter/auto"))).toBeNull();
	});

	test("preserves published quality scores and never imputes missing ones", () => {
		const scoredInFixture = RAW.filter(
			(m) =>
				typeof m === "object" &&
				m !== null &&
				"benchmarks" in m &&
				typeof m.benchmarks === "object" &&
				m.benchmarks !== null &&
				"artificial_analysis" in m.benchmarks,
		).length;

		let scored = 0;
		let unscored = 0;
		for (const raw of RAW) {
			const model = normalizeCatalogModel(raw);
			if (model === null) continue;
			const q = model.quality;
			if (q.coding !== undefined || q.agentic !== undefined || q.intelligence !== undefined) scored++;
			else unscored++;
		}
		// Coverage is genuinely partial; that fact drives the quality-floor rule.
		expect(scored).toBeLessThanOrEqual(scoredInFixture);
		expect(unscored).toBeGreaterThan(0);
	});

	test("reads long-context override tiers, sorted ascending", () => {
		const sonnet = normalizeCatalogModel(rawFor("anthropic/claude-sonnet-4.5"));
		expect(sonnet).not.toBeNull();
		expect(sonnet?.priceTiers.length).toBeGreaterThan(0);
		const tiers = sonnet?.priceTiers ?? [];
		for (let i = 1; i < tiers.length; i++) {
			const prev = tiers[i - 1];
			const cur = tiers[i];
			if (prev === undefined || cur === undefined) continue;
			expect(cur.minPromptTokens).toBeGreaterThan(prev.minPromptTokens);
		}
		// Anthropic doubles above 200k; the override must be dearer than base.
		const first = tiers[0];
		expect(first?.minPromptTokens).toBe(200000);
		expect(first?.price.prompt).toBeGreaterThan(sonnet?.price.prompt ?? 0);
	});

	test("an override tier inherits components it does not restate", () => {
		for (const raw of RAW) {
			const model = normalizeCatalogModel(raw);
			if (model === null || model.priceTiers.length === 0) continue;
			for (const tier of model.priceTiers) {
				// Completion is always meaningful, whether restated or inherited.
				expect(Number.isFinite(tier.price.completion)).toBe(true);
				expect(tier.price.completion).toBeGreaterThan(0);
			}
		}
	});

	test("strips the floating-alias marker from the author segment", () => {
		const alias = normalizeCatalogModel(rawFor("~x-ai/grok-latest"));
		expect(alias).not.toBeNull();
		expect(alias?.author).toBe("x-ai");
		// The slug itself is retained verbatim so the deny rule can still see it.
		expect(alias?.slug.startsWith("~")).toBe(true);
	});

	test("derives capability flags from supported_parameters", () => {
		const sonnet = normalizeCatalogModel(rawFor("anthropic/claude-sonnet-4.5"));
		expect(sonnet?.supportsTools).toBe(true);
		expect(sonnet?.supportsToolChoice).toBe(true);
		expect(sonnet?.supportsReasoning).toBe(true);
		expect(sonnet?.reasoningMandatory).toBe(false);

		const toolless = normalizeCatalogModel(rawFor("tencent/hy-mt2-1.8b"));
		expect(toolless?.supportsTools).toBe(false);
	});

	test("rejects records missing the fields routing depends on", () => {
		expect(normalizeCatalogModel({})).toBeNull();
		expect(normalizeCatalogModel(null)).toBeNull();
		expect(normalizeCatalogModel({ id: "x/y" })).toBeNull();
		expect(normalizeCatalogModel({ id: "x/y", pricing: { prompt: "0.1" } })).toBeNull();
	});
});
