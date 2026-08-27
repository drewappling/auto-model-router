/**
 * Run our own on-distribution benchmark and calibrate it to the AA scale.
 *
 * Reads the live cached catalog, splits it into ANCHORS (models AA already
 * scored) and TARGETS (unscored, routable), runs the curated suite against every
 * one via real OpenRouter completions, fits raw->AA per axis from the anchors,
 * and writes calibrated `local` scores for the targets into `local_scores`.
 *
 * Those scores are INERT until `benchmarks.useLocalScores` is turned on — this
 * script never flips it, so a run cannot perturb live routing on its own.
 *
 *   bun run research/run-eval.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";

// Force the PRODUCTION home; the fork's .env points it at research-data/home.
process.env.AUTO_MODEL_ROUTER_HOME = join(homedir(), ".auto-model-router");

import type { QualityAxis } from "../src/config/types.ts";
import type { CatalogModel } from "../src/catalog/types.ts";
import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import { saveLocalScores, normalizeModelKey } from "../src/catalog/benchmark-feeds.ts";
import { loadConfig } from "../src/config/load.ts";
import { fitCalibration, toLocalFeedScores, MIN_ANCHORS } from "../src/eval/calibrate.ts";
import { runEval, type ChatMessage, type EvalResult } from "../src/eval/run.ts";
import { EVAL_TASKS } from "../src/eval/tasks.ts";
import { createOpenRouterClient } from "../src/upstream/openrouter.ts";
import { openDb } from "../src/util/sqlite.ts";

const AXES: readonly QualityAxis[] = ["coding", "intelligence", "agentic"];
const cfg = loadConfig({});
if (cfg.openrouter.apiKey.trim() === "") {
	console.log("no OpenRouter key resolved; the eval needs one to dispatch completions.");
	process.exit(1);
}

const db = openDb(cfg.ledger.path);
const row = db.query("SELECT payload FROM catalog_cache WHERE id = 1").get() as { payload: string } | null;
if (row === null) {
	console.log("no cached catalog");
	process.exit(1);
}
const models: CatalogModel[] = (JSON.parse(row.payload) as unknown[])
	.map(normalizeCatalogModel)
	.filter((m): m is CatalogModel => m !== null);

const routable = (m: CatalogModel): boolean => !m.slug.startsWith("~") && !m.isFree && m.author !== "openrouter";
const scored = (m: CatalogModel): boolean => m.quality.coding !== undefined || m.quality.intelligence !== undefined || m.quality.agentic !== undefined;

const anchors = models.filter((m) => routable(m) && scored(m));
const targets = models.filter((m) => routable(m) && !scored(m));
console.log(`catalog ${models.length}: ${anchors.length} anchors (AA-scored), ${targets.length} targets (unscored)\n`);
if (anchors.length < MIN_ANCHORS) {
	console.log(`only ${anchors.length} anchors (< ${MIN_ANCHORS}); cannot calibrate. Aborting.`);
	process.exit(1);
}

const client = createOpenRouterClient(cfg);
const complete = async (slug: string, messages: ChatMessage[]): Promise<string> => {
	const body = { model: slug, messages, temperature: 0, max_tokens: 512 };
	const { text } = await client.complete(body, AbortSignal.timeout(cfg.benchmarks.timeoutMs));
	return text;
};

const allSlugs = [...anchors, ...targets].map((m) => m.slug);
console.log(`running ${EVAL_TASKS.length} tasks against ${allSlugs.length} models...`);
const results = await runEval({ slugs: allSlugs, complete });
const bySlug = new Map<string, EvalResult>(results.map((r) => [r.slug, r]));

const qualityOf = new Map<string, CatalogModel["quality"]>(models.map((m) => [m.slug, m.quality]));
const anchorAa = (slug: string, axis: QualityAxis): number | undefined => qualityOf.get(slug)?.[axis];

const mean = (r: EvalResult | undefined, axis: QualityAxis): number | null =>
	r === undefined || r.axes[axis].n === 0 ? null : r.axes[axis].sum / r.axes[axis].n;

const anchorResults = anchors.map((m) => bySlug.get(m.slug)).filter((r): r is EvalResult => r !== undefined);
const targetResults = targets.map((m) => bySlug.get(m.slug)).filter((r): r is EvalResult => r !== undefined);

const cal = fitCalibration(anchorResults, anchorAa);

console.log("\n=== anchors: raw suite mean vs known AA ===");
for (const m of anchors) {
	const r = bySlug.get(m.slug);
	const cells = AXES.map((a) => {
		const raw = mean(r, a);
		const aa = m.quality[a];
		return `${a[0]}: raw ${raw === null ? "-" : raw.toFixed(2)} / aa ${aa ?? "-"}`;
	}).join("   ");
	console.log(`  ${m.slug.padEnd(34)} ${cells}`);
}

console.log("\n=== calibration fit (raw 0-1 -> AA 0-100) ===");
for (const a of AXES) {
	const f = cal[a];
	console.log(`  ${a.padEnd(13)} ${f === undefined ? "(no fit — too few anchors, no spread, or weak/negative correlation)" : `aa = ${f.slope.toFixed(1)}*raw + ${f.intercept.toFixed(1)}  (r=${f.r.toFixed(2)}, n=${f.n})`}`);
}

const localScores = toLocalFeedScores(targetResults, cal, (slug) => {
	const bare = slug.startsWith("~") ? slug.slice(1) : slug;
	const slash = bare.indexOf("/");
	return slash === -1 ? "" : bare.slice(0, slash);
});

console.log("\n=== targets: calibrated local scores ===");
for (const m of targets) {
	const r = bySlug.get(m.slug);
	const fs = localScores.find((s) => s.key === normalizeModelKey(m.slug));
	const raws = AXES.map((a) => `${a[0]}:${mean(r, a)?.toFixed(2) ?? "-"}`).join(" ");
	const cal2 = fs === undefined ? "(none)" : AXES.map((a) => `${a[0]}:${fs[a]?.toFixed(1) ?? "-"}`).join(" ");
	console.log(`  ${m.slug.padEnd(34)} raw[${raws}]  ->  local[${cal2}]`);
}

saveLocalScores(db, localScores);
db.close();
console.log(`\nwrote ${localScores.length} local score row(s) to local_scores.`);
console.log(`benchmarks.useLocalScores = ${cfg.benchmarks.useLocalScores} — scores are INERT until this is true.`);
