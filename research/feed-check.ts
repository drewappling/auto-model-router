/**
 * Live proof: fetch the external benchmark feeds for real, apply them to a COPY
 * of the live catalog, and print which previously-unscored models gained scores.
 * Read-only w.r.t. the production DB — never writes benchmark_cache.
 *
 *   bun run research/feed-check.ts [db]
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { applyFeedScores, fetchAaScores, fetchBenchlmScores, type FeedScore } from "../src/catalog/benchmark-feeds.ts";
import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import { loadConfig } from "../src/config/load.ts";

const dbPath = process.argv[2] ?? join(homedir(), ".auto-model-router", "router.db");
const cfg = loadConfig({});

const db = new Database(dbPath, { readonly: true });
const row = db.query("SELECT payload FROM catalog_cache WHERE id = 1").get() as { payload: string } | null;
db.close();
if (row === null) {
	console.log("no cached catalog");
	process.exit(1);
}

const parsed: unknown = JSON.parse(row.payload);
const rawModels: unknown[] = Array.isArray(parsed) ? parsed : [];

// Quality per slug BEFORE the fill.
function qualityBySlug(models: unknown[]): Map<string, object> {
	const out = new Map<string, object>();
	for (const raw of models) {
		const m = normalizeCatalogModel(raw);
		if (m !== null) out.set(m.slug, m.quality);
	}
	return out;
}

const before = qualityBySlug(structuredClone(rawModels));

const key = cfg.benchmarks.artificialAnalysisApiKey;
console.log(`AA key: ${key.trim() === "" ? "(none — AA feed skipped)" : "present"}`);
const [aa, bl] = await Promise.all([fetchAaScores(key, { timeoutMs: 30_000 }), fetchBenchlmScores({ timeoutMs: 30_000 })]);
const feeds: FeedScore[] = [...aa, ...bl];
console.log(`feeds fetched: artificial_analysis=${aa.length}  benchlm=${bl.length}\n`);

if (feeds.length === 0) {
	console.log("no feed data (endpoints unreachable or empty); nothing to apply.");
	process.exit(0);
}

const result = applyFeedScores(rawModels, feeds);
const after = qualityBySlug(rawModels);

console.log(`filled ${result.modelsFilled} model(s): coding=${result.axes.coding} intelligence=${result.axes.intelligence} agentic=${result.axes.agentic} (aa=${result.sources.artificial_analysis} benchlm=${result.sources.benchlm})\n`);

for (const [slug, q] of after) {
	const prev = JSON.stringify(before.get(slug) ?? {});
	const now = JSON.stringify(q);
	if (prev !== now) console.log(`${slug}\n    before ${prev}\n    after  ${now}`);
}
