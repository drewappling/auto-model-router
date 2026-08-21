import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel } from "../src/catalog/types.ts";
import { computeCost, forecast, priceAt } from "../src/cost/forecast.ts";
import { EMPTY_USAGE, type UsageCounts } from "../src/cost/types.ts";

const FIXTURE = (await Bun.file("test/fixtures/openrouter-models.json").json()) as { data: unknown[] };

function model(slug: string): CatalogModel {
	const raw = FIXTURE.data.find((m) => typeof m === "object" && m !== null && "id" in m && m.id === slug);
	if (raw === undefined) throw new Error(`fixture is missing ${slug}`);
	const normalized = normalizeCatalogModel(raw);
	if (normalized === null) throw new Error(`${slug} did not normalize`);
	return normalized;
}

function usage(over: Partial<UsageCounts>): UsageCounts {
	return { ...EMPTY_USAGE, ...over };
}

const SONNET = model("anthropic/claude-sonnet-4.5"); // publishes cache prices + override tiers
const ALL = FIXTURE.data.map(normalizeCatalogModel).filter((m): m is CatalogModel => m !== null);

describe("priceAt", () => {
	test("returns the base price below every override threshold", () => {
		expect(priceAt(SONNET, 1000).prompt).toBe(SONNET.price.prompt);
		expect(priceAt(SONNET, 199_999).prompt).toBe(SONNET.price.prompt);
	});

	test("crosses into the long-context tier at the threshold", () => {
		const tier = SONNET.priceTiers[0];
		expect(tier).toBeDefined();
		if (tier === undefined) return;
		expect(priceAt(SONNET, tier.minPromptTokens).prompt).toBe(tier.price.prompt);
		expect(priceAt(SONNET, tier.minPromptTokens + 1).prompt).toBeGreaterThan(SONNET.price.prompt);
	});

	test("a long conversation is dearer per token than a short one", () => {
		// The whole reason override tiers are modelled: ignoring them
		// underestimates long-session cost by roughly half.
		const short = computeCost(SONNET, usage({ promptTokens: 50_000, completionTokens: 1000 }));
		const long = computeCost(SONNET, usage({ promptTokens: 400_000, completionTokens: 1000 }));
		expect(long.total / 400_000).toBeGreaterThan(short.total / 50_000);
		expect(long.tierAtPromptTokens).toBe(200_000);
		expect(short.tierAtPromptTokens).toBe(0);
	});
});

describe("computeCost", () => {
	test("components sum to the reported total", () => {
		const b = computeCost(
			SONNET,
			usage({ promptTokens: 10_000, cachedTokens: 6000, cacheWriteTokens: 1000, completionTokens: 500, reasoningTokens: 200, images: 2 }),
		);
		const sum = b.freshPrompt + b.cacheRead + b.cacheWrite + b.completion + b.reasoning + b.images + b.request;
		expect(sum).toBeCloseTo(b.total, 12);
	});

	test("prompt_tokens already includes cached tokens, so they are not billed twice", () => {
		// 10k prompt of which 10k cached must cost far less than 10k fresh,
		// and must not be billed as 20k.
		const allFresh = computeCost(SONNET, usage({ promptTokens: 10_000 }));
		const allCached = computeCost(SONNET, usage({ promptTokens: 10_000, cachedTokens: 10_000 }));
		expect(allCached.total).toBeLessThan(allFresh.total);
		expect(allCached.freshPrompt).toBe(0);
		const cacheRead = SONNET.price.cacheRead;
		expect(cacheRead).toBeDefined();
		if (cacheRead === undefined) return;
		expect(allCached.cacheRead).toBeCloseTo(10_000 * cacheRead, 12);
	});

	test("cache reads are cheaper than fresh prompt tokens wherever published", () => {
		let checked = 0;
		for (const m of ALL) {
			const read = m.price.cacheRead;
			if (read === undefined || read === 0) continue;
			checked++;
			const fresh = computeCost(m, usage({ promptTokens: 20_000 }));
			const cached = computeCost(m, usage({ promptTokens: 20_000, cachedTokens: 20_000 }));
			expect(cached.total).toBeLessThanOrEqual(fresh.total);
		}
		expect(checked).toBeGreaterThan(0);
	});

	test("reasoning tokens are a subset of completion tokens and never double-billed", () => {
		const withReasoning = computeCost(SONNET, usage({ completionTokens: 1000, reasoningTokens: 400 }));
		const withoutReasoning = computeCost(SONNET, usage({ completionTokens: 1000 }));
		// Sonnet publishes no separate reasoning rate, so 1000 completion tokens
		// cost the same whether or not 400 of them were reasoning.
		expect(withReasoning.total).toBeCloseTo(withoutReasoning.total, 12);
		// And never more than billing all 1400 separately would have cost.
		const inflated = computeCost(SONNET, usage({ completionTokens: 1400 }));
		expect(withReasoning.total).toBeLessThan(inflated.total);
	});

	test("zero usage costs nothing beyond any flat per-request fee", () => {
		const b = computeCost(SONNET, EMPTY_USAGE);
		expect(b.total).toBe(b.request);
	});
});

describe("forecast", () => {
	test("cold is never cheaper than expected, for every model in the catalog", () => {
		// A budget guard checks the cold number, so this ordering is load-bearing:
		// several models publish a cache-write rate BELOW their prompt rate, so
		// the honest worst case is the max of "no cache" and "full cache write".
		for (const m of ALL) {
			for (const hitRate of [0, 0.5, 0.9]) {
				const f = forecast(m, { promptTokens: 30_000, completionTokens: 800, cacheHitRate: hitRate, images: 0 });
				expect(f.coldUsd).toBeGreaterThanOrEqual(f.expectedUsd - 1e-12);
			}
		}
	});

	test("a higher assumed cache hit rate lowers the expected cost", () => {
		const cold = forecast(SONNET, { promptTokens: 50_000, completionTokens: 500, cacheHitRate: 0, images: 0 });
		const warm = forecast(SONNET, { promptTokens: 50_000, completionTokens: 500, cacheHitRate: 0.9, images: 0 });
		expect(warm.expectedUsd).toBeLessThan(cold.expectedUsd);
		expect(warm.assumedCacheHitRate).toBeCloseTo(0.9, 12);
	});

	test("records the assumptions it was given", () => {
		const f = forecast(SONNET, { promptTokens: 1234, completionTokens: 567, cacheHitRate: 0.25, images: 3 });
		expect(f.slug).toBe(SONNET.slug);
		expect(f.assumedPromptTokens).toBe(1234);
		expect(f.assumedCompletionTokens).toBe(567);
		expect(f.expectedUsd).toBeGreaterThan(0);
	});

	test("a cheap model forecasts below an expensive one for identical work", () => {
		const cheap = model("openai/gpt-5-nano");
		const dear = model("openai/gpt-5-pro");
		const args = { promptTokens: 20_000, completionTokens: 1000, cacheHitRate: 0, images: 0 };
		expect(forecast(cheap, args).expectedUsd).toBeLessThan(forecast(dear, args).expectedUsd);
	});
});
