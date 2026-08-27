import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import {
	applyFeedScores,
	fetchBenchlmScores,
	normalizeModelKey,
	parseAaModels,
	parseBenchlmModels,
	refreshFeedScores,
	type FeedScore,
	type FetchLike,
} from "../src/catalog/benchmark-feeds.ts";
import { loadConfig } from "../src/config/load.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { openDb } from "../src/util/sqlite.ts";

/** A bare OpenRouter `/models` record, optionally pre-scored. */
function raw(id: string, benchmarks?: Record<string, unknown>): Record<string, unknown> {
	const record: Record<string, unknown> = {
		id,
		canonical_slug: id,
		name: id,
		context_length: 131_072,
		pricing: { prompt: "0.0000003", completion: "0.0000011" },
		supported_parameters: ["tools"],
		architecture: { input_modalities: ["text"], tokenizer: "Other" },
		created: 1_700_000_000,
	};
	if (benchmarks !== undefined) record.benchmarks = benchmarks;
	return record;
}

function aaScore(over: Partial<FeedScore> & { key: string }): FeedScore {
	return { creator: "", source: "artificial_analysis", ...over };
}
function blScore(over: Partial<FeedScore> & { key: string }): FeedScore {
	return { creator: "", source: "benchlm", ...over };
}

describe("normalizeModelKey", () => {
	test("strips provider, tilde, and release words but keeps the parameter size", () => {
		expect(normalizeModelKey("z-ai/glm-5.3-flash")).toBe("glm-5-3-flash");
		expect(normalizeModelKey("~deepseek/deepseek-v4-flash-latest")).toBe("deepseek-v4-flash");
		expect(normalizeModelKey("meta/muse-glimmer-30b")).toBe("muse-glimmer-30b");
		// The feed's own display spelling collapses onto the same key.
		expect(normalizeModelKey("Muse Glimmer 30B")).toBe("muse-glimmer-30b");
		expect(normalizeModelKey("MiniMax M3")).toBe("minimax-m3");
	});
});

describe("parseAaModels", () => {
	test("reads the three indices, keeps in-range values, and skips empty rows", () => {
		const body = {
			data: [
				{
					slug: "glm-5.3-flash",
					model_creator: { slug: "z-ai" },
					evaluations: {
						artificial_analysis_coding_index: 61.2,
						artificial_analysis_intelligence_index: 58.4,
						artificial_analysis_agentic_index: 150, // out of range → dropped
					},
				},
				{ slug: "no-evals", model_creator: { slug: "x" }, evaluations: {} },
			],
		};
		const parsed = parseAaModels(body);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ key: "glm-5-3-flash", creator: "z-ai", coding: 61.2, intelligence: 58.4 });
		expect(parsed[0]?.agentic).toBeUndefined();
	});
});

describe("parseBenchlmModels", () => {
	test("maps categories to axes, drops estimated rows, and ignores out-of-range", () => {
		const body = {
			models: [
				{
					model: "Muse Glimmer 30B",
					creator: "Meta",
					evidenceStatus: "supported",
					categoryScores: { coding: 55, reasoning: 52, agentic: 48 },
				},
				{
					model: "Guessed Model",
					creator: "x",
					evidenceStatus: "estimated",
					categoryScores: { coding: 90 },
				},
			],
		};
		const parsed = parseBenchlmModels(body);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({ key: "muse-glimmer-30b", coding: 55, intelligence: 52, agentic: 48 });
	});
});

describe("applyFeedScores", () => {
	test("fills the real gap models and reaches normalizeCatalogModel", () => {
		const catalog = [
			raw("meta/muse-glimmer-30b"),
			raw("z-ai/glm-5.3-flash"),
			// Already scored by OpenRouter on coding; a feed must not overwrite it.
			raw("google/gemini-3.7-flash", { artificial_analysis: { coding_index: 76.1 } }),
		];
		const feeds: FeedScore[] = [
			aaScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 61, intelligence: 58 }),
			aaScore({ key: "gemini-3-7-flash", creator: "google", coding: 40, intelligence: 63 }),
			blScore({ key: "muse-glimmer-30b", creator: "meta", coding: 55, agentic: 48 }),
			blScore({ key: "glm-5-3-flash", creator: "z-ai", agentic: 44 }),
		];

		const result = applyFeedScores(catalog, feeds);

		// muse-glimmer: was empty, gains coding + agentic from BenchLM.
		const muse = normalizeCatalogModel(catalog[0]);
		expect(muse?.quality).toEqual({ coding: 55, agentic: 48 });

		// glm: coding + intelligence from AA (stronger), agentic from BenchLM.
		const glm = normalizeCatalogModel(catalog[1]);
		expect(glm?.quality).toEqual({ coding: 61, intelligence: 58, agentic: 44 });

		// gemini: published coding survives untouched; intelligence filled from AA.
		const gemini = normalizeCatalogModel(catalog[2]);
		expect(gemini?.quality.coding).toBe(76.1);
		expect(gemini?.quality.intelligence).toBe(63);

		// Provenance recorded, counts add up.
		const museBench = catalog[0]?.benchmarks;
		expect(museBench).toMatchObject({ fill_sources: { coding: "benchlm", agentic: "benchlm" } });
		expect(result.modelsFilled).toBe(3);
		expect(result.sources.artificial_analysis).toBe(3); // glm coding+intel, gemini intel
		expect(result.sources.benchlm).toBe(3); // muse coding+agentic, glm agentic
	});

	test("AA wins over BenchLM for the same axis", () => {
		const catalog = [raw("z-ai/glm-5.3-flash")];
		const feeds: FeedScore[] = [
			blScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 10 }),
			aaScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 61 }),
		];
		applyFeedScores(catalog, feeds);
		expect(normalizeCatalogModel(catalog[0])?.quality.coding).toBe(61);
	});

	test("never fuzzy-matches a different model", () => {
		const catalog = [raw("meta/muse-glimmer-30b")];
		// Same family, different model — must not lend its score.
		const feeds: FeedScore[] = [aaScore({ key: "muse-spark-1-2", creator: "meta", coding: 72 })];
		const result = applyFeedScores(catalog, feeds);
		expect(result.modelsFilled).toBe(0);
		expect(normalizeCatalogModel(catalog[0])?.quality).toEqual({});
	});

	test("a shared key with conflicting creators fills only the creator that matches", () => {
		const catalog = [raw("z-ai/glm-5.3-flash")];
		const feeds: FeedScore[] = [
			aaScore({ key: "glm-5-3-flash", creator: "someone-else", coding: 5 }),
			aaScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 61 }),
		];
		applyFeedScores(catalog, feeds);
		expect(normalizeCatalogModel(catalog[0])?.quality.coding).toBe(61);
	});
});

describe("refreshFeedScores", () => {
	function cfgWith(over: Partial<RouterConfig["benchmarks"]>): RouterConfig {
		const base = loadConfig({});
		return { ...base, benchmarks: { ...base.benchmarks, ...over } };
	}

	test("fetches once, then serves the cache within the TTL", async () => {
		const db = openDb(":memory:");
		let calls = 0;
		const fakeFetch: FetchLike = async (url) => {
			calls += 1;
			const u = String(url);
			if (u.includes("benchlm")) {
				return Response.json({
					models: [
						{ model: "MiniMax M3", creator: "MiniMax", evidenceStatus: "supported", categoryScores: { coding: 58 } },
					],
				});
			}
			return Response.json({ data: [] });
		};

		const cfg = cfgWith({ enabled: true, artificialAnalysisApiKey: "", benchlm: true, refreshMs: 1_000_000 });
		const first = await refreshFeedScores(cfg, db, { fetchImpl: fakeFetch, now: 1000 });
		expect(first).toHaveLength(1);
		expect(first[0]).toMatchObject({ key: "minimax-m3", coding: 58, source: "benchlm" });
		expect(calls).toBe(1); // AA skipped (no key), BenchLM fetched once

		const second = await refreshFeedScores(cfg, db, { fetchImpl: fakeFetch, now: 2000 });
		expect(second).toHaveLength(1);
		expect(calls).toBe(1); // within TTL → no new fetch
		db.close();
	});

	test("falls back to the stale cache when a refresh returns nothing", async () => {
		const db = openDb(":memory:");
		const seed = [{ key: "minimax-m3", creator: "minimax", coding: 58, source: "benchlm" }];
		db.query("INSERT INTO benchmark_cache (id, payload, fetched_at_ms) VALUES (1, ?, ?)").run(JSON.stringify(seed), 0);
		const emptyFetch: FetchLike = async () => Response.json({ models: [] });
		const cfg = cfgWith({ enabled: true, artificialAnalysisApiKey: "", benchlm: true, refreshMs: 10 });
		const got = await refreshFeedScores(cfg, db, { fetchImpl: emptyFetch, now: 1_000_000 });
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({ key: "minimax-m3", coding: 58 });
		db.close();
	});
});

// fetchBenchlmScores over a fake fetch: the keyless path parses end to end.
test("fetchBenchlmScores parses a keyless leaderboard response", async () => {
	const fake: FetchLike = async () =>
		Response.json({
			models: [{ model: "GLM 5.3 Flash", creator: "Z-AI", evidenceStatus: "supported", categoryScores: { coding: 61, reasoning: 58 } }],
		});
	const scores = await fetchBenchlmScores({ fetchImpl: fake });
	expect(scores).toEqual([{ key: "glm-5-3-flash", creator: "z-ai", coding: 61, intelligence: 58, source: "benchlm" }]);
});
