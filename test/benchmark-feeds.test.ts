import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import {
	applyFeedScores,
	fetchBenchlmScores,
	invalidateFeedCache,
	MAX_EXTRA_SCORES,
	loadLocalScores,
	normalizeModelKey,
	parseAaModels,
	parseBenchlmModels,
	refreshFeedScores,
	saveLocalScores,
	suppliedScores,
	type FeedScore,
	type FetchLike,
} from "../src/catalog/benchmark-feeds.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { loadConfig } from "../src/config/load.ts";
import type { RouterConfig } from "../src/config/types.ts";
import type { Logger } from "../src/util/log.ts";
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
function localScore(over: Partial<FeedScore> & { key: string }): FeedScore {
	return { creator: "", source: "local", ...over };
}
/** A row as the front door supplies it: a neutral leaderboard number. */
function neutralScore(over: Partial<FeedScore> & { key: string }): FeedScore {
	return { creator: "", source: "neutral", ...over };
}
/** A row as the front door supplies it: a self-reported model-card number. */
function vendorScore(over: Partial<FeedScore> & { key: string }): FeedScore {
	return { creator: "", source: "vendor", ...over };
}

describe("normalizeModelKey", () => {
	test("strips provider, tilde, and release words but keeps the parameter size", async () => {
		expect(normalizeModelKey("z-ai/glm-5.3-flash")).toBe("glm-5-3-flash");
		expect(normalizeModelKey("~deepseek/deepseek-v4-flash-latest")).toBe("deepseek-v4-flash");
		expect(normalizeModelKey("meta/muse-glimmer-30b")).toBe("muse-glimmer-30b");
		// The feed's own display spelling collapses onto the same key.
		expect(normalizeModelKey("Muse Glimmer 30B")).toBe("muse-glimmer-30b");
		expect(normalizeModelKey("MiniMax M3")).toBe("minimax-m3");
	});
});

describe("parseAaModels", () => {
	test("reads the three indices, keeps in-range values, and skips empty rows", async () => {
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
	test("maps categories to axes, drops estimated rows, and ignores out-of-range", async () => {
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
	test("fills the real gap models and reaches normalizeCatalogModel", async () => {
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

	test("AA wins over BenchLM for the same axis", async () => {
		const catalog = [raw("z-ai/glm-5.3-flash")];
		const feeds: FeedScore[] = [
			blScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 10 }),
			aaScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 61 }),
		];
		applyFeedScores(catalog, feeds);
		expect(normalizeCatalogModel(catalog[0])?.quality.coding).toBe(61);
	});

	test("never fuzzy-matches a different model", async () => {
		const catalog = [raw("meta/muse-glimmer-30b")];
		// Same family, different model — must not lend its score.
		const feeds: FeedScore[] = [aaScore({ key: "muse-spark-1-2", creator: "meta", coding: 72 })];
		const result = applyFeedScores(catalog, feeds);
		expect(result.modelsFilled).toBe(0);
		expect(normalizeCatalogModel(catalog[0])?.quality).toEqual({});
	});

	test("a shared key with conflicting creators fills only the creator that matches", async () => {
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

	test("invalidateFeedCache re-fetches inside the TTL, and a failed forced fetch keeps the scores", async () => {
		const db = openDb(":memory:");
		let calls = 0;
		let coding = 58;
		const fakeFetch: FetchLike = async () => {
			calls += 1;
			return Response.json({
				models: coding === 0 ? [] : [{ model: "MiniMax M3", creator: "MiniMax", evidenceStatus: "supported", categoryScores: { coding } }],
			});
		};

		const cfg = cfgWith({ enabled: true, artificialAnalysisApiKey: "", benchlm: true, refreshMs: 1_000_000 });
		await refreshFeedScores(cfg, db, { fetchImpl: fakeFetch, now: 1000 });
		await refreshFeedScores(cfg, db, { fetchImpl: fakeFetch, now: 2000 });
		expect(calls).toBe(1); // deep inside the TTL

		// An Artificial Analysis key arriving cannot wait out the day still left on
		// the cache; invalidating is what makes the next refresh actually fetch.
		invalidateFeedCache(db);
		coding = 71;
		const forced = await refreshFeedScores(cfg, db, { fetchImpl: fakeFetch, now: 3000 });
		expect(calls).toBe(2);
		expect(forced[0]).toMatchObject({ key: "minimax-m3", coding: 71 });

		// And the forced fetch is still best-effort: a feed that answers with nothing
		// leaves the scores already serving in place rather than emptying them.
		invalidateFeedCache(db);
		coding = 0;
		const after = await refreshFeedScores(cfg, db, { fetchImpl: fakeFetch, now: 4000 });
		expect(calls).toBe(3);
		expect(after[0]).toMatchObject({ key: "minimax-m3", coding: 71 });
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

/**
 * `benchmarks.extraScores`: scores the FRONT DOOR supplies for axes the feeds
 * leave empty. The case it was built for is real — `deepseek/deepseek-v4.1-flash`
 * carries intelligence 39.5 and nothing else, so no tier floor above the cheapest
 * can admit it, and it took 1 dispatch in 30 days against its sibling's 1,455.
 * A model OpenRouter serves is defined by OpenRouter's catalog, which the front
 * door can only read; this is the one seam through which it can say more.
 */
describe("benchmarks.extraScores", () => {
	function cfgWith(extraScores?: FeedScore[]): RouterConfig {
		const base = structuredClone(DEFAULT_CONFIG);
		return {
			...base,
			logLevel: "silent",
			benchmarks: { ...base.benchmarks, ...(extraScores === undefined ? {} : { extraScores }) },
		};
	}

	/** Captures whatever the sanitiser decided to say out loud. */
	function recorder(): { log: Logger; warns: { msg: string; fields?: Record<string, unknown> }[] } {
		const warns: { msg: string; fields?: Record<string, unknown> }[] = [];
		const noop = (): void => {};
		const log: Logger = {
			error: noop,
			info: noop,
			debug: noop,
			warn: (msg, fields) => {
				warns.push(fields === undefined ? { msg } : { msg, fields });
			},
		};
		return { log, warns };
	}

	test("fills the axes the feeds left empty, and says where each came from", async () => {
		// Exactly the live shape: intelligence published, the other two absent.
		const catalog = [raw("deepseek/deepseek-v4.1-flash", { artificial_analysis: { intelligence_index: 39.5 } })];
		const cfg = cfgWith([
			vendorScore({ key: "deepseek-v4-1-flash", creator: "deepseek", coding: 55.2 }),
			neutralScore({ key: "deepseek-v4-1-flash", creator: "deepseek", agentic: 31.8 }),
		]);

		const result = applyFeedScores(catalog, suppliedScores(cfg));

		expect(normalizeCatalogModel(catalog[0])?.quality).toEqual({ intelligence: 39.5, coding: 55.2, agentic: 31.8 });
		// Provenance survives per axis, and the two kinds stay distinguishable.
		expect(catalog[0]?.benchmarks).toMatchObject({ fill_sources: { coding: "vendor", agentic: "neutral" } });
		expect(result.sources.vendor).toBe(1);
		expect(result.sources.neutral).toBe(1);
	});

	test("never moves a score a published source measured", async () => {
		const catalog = [raw("google/gemini-3.7-flash", { artificial_analysis: { coding_index: 76.1 } })];
		const cfg = cfgWith([neutralScore({ key: "gemini-3-7-flash", creator: "google", coding: 10, agentic: 40 })]);
		const result = applyFeedScores(catalog, suppliedScores(cfg));
		expect(normalizeCatalogModel(catalog[0])?.quality).toEqual({ coding: 76.1, agentic: 40 });
		expect(result.axes.coding).toBe(0);
	});

	test("loses to Artificial Analysis and BenchLM, beats local, and neutral leads vendor", async () => {
		const catalog = [raw("z-ai/glm-5.3-flash"), raw("meta/muse-glimmer-30b")];
		const cfg = cfgWith([
			// Every one of these is outranked on glm's coding and intelligence.
			neutralScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 10, agentic: 50 }),
			vendorScore({ key: "glm-5-3-flash", creator: "z-ai", intelligence: 9, agentic: 40 }),
			// ...but both outrank local, and on agentic neutral outranks vendor.
			vendorScore({ key: "muse-glimmer-30b", creator: "meta", agentic: 44 }),
		]);
		const feeds: FeedScore[] = [
			aaScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 61 }),
			blScore({ key: "glm-5-3-flash", creator: "z-ai", intelligence: 58 }),
			localScore({ key: "glm-5-3-flash", creator: "z-ai", agentic: 1 }),
			localScore({ key: "muse-glimmer-30b", creator: "meta", agentic: 33 }),
		];

		applyFeedScores(catalog, [...feeds, ...suppliedScores(cfg)]);

		expect(normalizeCatalogModel(catalog[0])?.quality).toEqual({ coding: 61, intelligence: 58, agentic: 50 });
		expect(catalog[0]?.benchmarks).toMatchObject({
			fill_sources: { coding: "artificial_analysis", intelligence: "benchlm", agentic: "neutral" },
		});
		expect(normalizeCatalogModel(catalog[1])?.quality).toEqual({ agentic: 44 });
		expect(catalog[1]?.benchmarks).toMatchObject({ fill_sources: { agentic: "vendor" } });
	});

	test("a malformed entry is dropped loudly, and can neither zero a score nor stop the rest", async () => {
		const { log, warns } = recorder();
		const cfg = cfgWith([
			42 as unknown as FeedScore, // not an object
			{ creator: "x", source: "neutral", coding: 70 } as unknown as FeedScore, // no key
			// Config may not claim a fetched feed, nor the lane `useLocalScores` gates.
			aaScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 99 }),
			localScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 98 }),
			// Well-formed row, unusable axes: a string and an out-of-range number.
			{ key: "glm-5-3-flash", creator: "z-ai", coding: "61", agentic: -3, source: "neutral" } as unknown as FeedScore,
			neutralScore({ key: "muse-glimmer-30b", creator: "meta", coding: 55 }),
		]);

		const kept = suppliedScores(cfg, log);

		// Four entries thrown away whole; the fifth survives with both axes gone.
		expect(kept).toHaveLength(2);
		expect(kept[0]).toEqual({ key: "glm-5-3-flash", creator: "z-ai", source: "neutral" });
		expect(warns).toHaveLength(1);
		expect(warns[0]?.fields).toMatchObject({ kept: 2, droppedEntries: 4, droppedAxes: 2 });

		// The unusable axes stay ABSENT, not 0 — an unscored model must satisfy no
		// floor, and a supplied 0 would satisfy `trivial` and bid for every turn.
		const catalog = [raw("z-ai/glm-5.3-flash"), raw("meta/muse-glimmer-30b")];
		applyFeedScores(catalog, kept);
		expect(normalizeCatalogModel(catalog[0])?.quality).toEqual({});
		expect(normalizeCatalogModel(catalog[1])?.quality).toEqual({ coding: 55 });
	});

	test("a supplied entry cannot claim a feed's rank by claiming its label", async () => {
		const catalog = [raw("z-ai/glm-5.3-flash")];
		// Sent as `artificial_analysis`, which would outrank BenchLM if it survived.
		const cfg = cfgWith([aaScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 99 })]);
		applyFeedScores(catalog, [blScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 58 }), ...suppliedScores(cfg)]);
		expect(normalizeCatalogModel(catalog[0])?.quality.coding).toBe(58);
	});

	test("nor by being written into a table that does not produce it", async () => {
		const db = openDb(":memory:");
		// Each stored blob only yields the sources that actually write it, so neither
		// lane is a side door into a rank. `local_scores` in particular stays the
		// local lane — the one `benchmarks.useLocalScores` gates.
		saveLocalScores(db, [
			localScore({ key: "muse-glimmer-30b", creator: "meta", coding: 42 }),
			neutralScore({ key: "muse-glimmer-30b", creator: "meta", agentic: 39 }),
		]);
		expect(loadLocalScores(db)).toEqual([{ key: "muse-glimmer-30b", creator: "meta", coding: 42, source: "local" }]);

		const cached = [neutralScore({ key: "minimax-m3", coding: 70 }), blScore({ key: "minimax-m3", coding: 58 })];
		db.query("INSERT INTO benchmark_cache (id, payload, fetched_at_ms) VALUES (1, ?, ?)").run(JSON.stringify(cached), 1000);
		const feeds = await refreshFeedScores(cfgWith(), db, { fetchImpl: async () => Response.json({ models: [] }), now: 1500 });
		expect(feeds).toEqual([{ key: "minimax-m3", creator: "", coding: 58, source: "benchlm" }]);
		db.close();
	});

	test("the key may be the OpenRouter slug; the front door need not reimplement the match", async () => {
		const catalog = [raw("deepseek/deepseek-v4.1-flash")];
		const cfg = cfgWith([{ key: "deepseek/deepseek-v4.1-flash", creator: "DeepSeek", coding: 55.2, source: "vendor" }]);
		expect(suppliedScores(cfg)[0]).toMatchObject({ key: "deepseek-v4-1-flash", creator: "deepseek" });
		applyFeedScores(catalog, suppliedScores(cfg));
		expect(normalizeCatalogModel(catalog[0])?.quality.coding).toBe(55.2);
	});

	test("past the cap the excess is dropped, loudly, and the rest still apply", async () => {
		const { log, warns } = recorder();
		const many: FeedScore[] = [];
		for (let i = 0; i < MAX_EXTRA_SCORES + 5; i += 1) many.push(neutralScore({ key: `model-${i}`, coding: 50 }));
		const kept = suppliedScores(cfgWith(many), log);
		expect(kept).toHaveLength(MAX_EXTRA_SCORES);
		expect(warns[0]?.fields).toMatchObject({ droppedEntries: 5, overCap: MAX_EXTRA_SCORES });
	});

	test("an older front door sends no such field and nothing changes", async () => {
		const cfg = cfgWith();
		expect(cfg.benchmarks.extraScores).toBeUndefined();
		expect(suppliedScores(cfg)).toEqual([]);

		// Byte for byte the same catalog, with the field absent and with it empty.
		const feeds: FeedScore[] = [
			aaScore({ key: "glm-5-3-flash", creator: "z-ai", coding: 61 }),
			blScore({ key: "muse-glimmer-30b", creator: "meta", agentic: 48 }),
		];
		const withoutField = [raw("z-ai/glm-5.3-flash"), raw("meta/muse-glimmer-30b")];
		const withEmpty = [raw("z-ai/glm-5.3-flash"), raw("meta/muse-glimmer-30b")];
		const a = applyFeedScores(withoutField, [...feeds, ...suppliedScores(cfg)]);
		const b = applyFeedScores(withEmpty, [...feeds, ...suppliedScores(cfgWith([]))]);
		expect(JSON.stringify(withoutField)).toBe(JSON.stringify(withEmpty));
		expect(a).toEqual(b);
		expect(a.sources.neutral).toBe(0);
		expect(a.sources.vendor).toBe(0);
	});
});
