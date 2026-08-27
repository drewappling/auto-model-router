/**
 * External benchmark backfill.
 *
 * OpenRouter embeds Artificial Analysis scores for the models it has bench data
 * for, but returns the rest unscored — GLM, MiniMax, smaller vendors — which
 * strands them below every tier floor above `trivial` (see openrouter-catalog.ts
 * `joinBenchmarks`). These feeds fill the axes a model is MISSING, from the same
 * two sources agentmanager uses:
 *
 *  - Artificial Analysis (`/api/v2/data/llms/models`, `x-api-key`): the broad
 *    baseline, but only when a key is configured.
 *  - BenchLM (`/api/data/leaderboard`, keyless): covers the models AA omits.
 *
 * Three rules, all load-bearing:
 *
 *  - FILL, NEVER OVERWRITE. A score OpenRouter already published wins; the feeds
 *    only supply axes that are absent. Two suites measure the same idea on
 *    different tests, so letting one overwrite the other would make a model's
 *    score jump with whichever feed refreshed last.
 *  - PER AXIS, AA BEFORE BENCHLM. AA is the stronger source and fills first;
 *    BenchLM fills whatever axis AA still left empty.
 *  - MATCH EXACTLY OR NOT AT ALL. Matching is on a normalized model-name key,
 *    with the creator used only to break a tie between two rows that share a
 *    key. A fuzzy match would let a 7B inherit a 72B's score and then be handed
 *    the hard task; an unmatched model stays honestly unscored.
 *
 * Everything here is best-effort: any fetch or parse failure yields an empty
 * feed, and the catalog keeps its published scores rather than failing.
 */

import type { Database } from "bun:sqlite";
import type { RouterConfig } from "../config/types.ts";
import { createLogger, type Logger } from "../util/log.ts";
import type { QualityAxis } from "../config/types.ts";

export const AA_MODELS_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
export const BENCHLM_URL = "https://benchlm.ai/api/data/leaderboard";

export type FeedSource = "artificial_analysis" | "benchlm" | "local";

/** One model's scores from one feed, on the router's three axes (0-100). */
export interface FeedScore {
	/** Normalized model-name key, e.g. `glm-5-3-flash`. The match key. */
	key: string;
	/** Normalized creator/author. May be "". Used only to disambiguate a key tie. */
	creator: string;
	coding?: number;
	intelligence?: number;
	agentic?: number;
	source: FeedSource;
}

export interface FillResult {
	/** Models that gained at least one score. */
	modelsFilled: number;
	/** Fills per axis. */
	axes: Record<QualityAxis, number>;
	/** Fills per source. */
	sources: Record<FeedSource, number>;
}

const AXES: readonly QualityAxis[] = ["coding", "intelligence", "agentic"];

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** A finite number in [0, 100], or null. Scores outside the range mean the field is not what we think. */
function score100(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	if (value < 0 || value > 100) return null;
	return value;
}

function axisValue(f: FeedScore, axis: QualityAxis): number | undefined {
	if (axis === "coding") return f.coding;
	if (axis === "intelligence") return f.intelligence;
	return f.agentic;
}

/**
 * A model name reduced to something comparable across OpenRouter slugs and the
 * feeds' own names. Provider prefix and release/packaging words are routing,
 * not identity, and go; a parameter count (7b vs 72b) is identity and stays.
 */
export function normalizeModelKey(name: string): string {
	let s = name.toLowerCase().trim();
	if (s.startsWith("~")) s = s.slice(1);
	// `/` separates provider from model; a bare `:` is a CLI/tag separator.
	if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1);
	else if (s.includes(":")) s = s.slice(s.indexOf(":") + 1);
	// Delivery/release words stack (`:preview-cloud`), so strip until stable.
	const packaging = /[:@-](?:cloud|free|latest|online|nitro|beta|preview)$/;
	while (packaging.test(s)) s = s.replace(packaging, "");
	s = s.replace(/[.\s_:]+/g, "-");
	return s.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Creator reduced for a tie-break comparison. Never used to reject a lone match. */
function normalizeCreator(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[.\s_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/** Author segment of an OpenRouter slug (before the first `/`, tilde stripped). */
function authorOf(slug: string): string {
	const bare = slug.startsWith("~") ? slug.slice(1) : slug;
	const slash = bare.indexOf("/");
	return normalizeCreator(slash === -1 ? "" : bare.slice(0, slash));
}

// ---------------------------------------------------------------------------- parse

/** Parse the Artificial Analysis `data[]` payload into feed scores. */
export function parseAaModels(body: unknown): FeedScore[] {
	const root = asRecord(body);
	const data = root === null ? null : root.data;
	if (!Array.isArray(data)) return [];
	const out: FeedScore[] = [];
	for (const raw of data) {
		const rec = asRecord(raw);
		if (rec === null) continue;
		const slug = typeof rec.slug === "string" ? rec.slug : null;
		if (slug === null || slug.length === 0) continue;
		const evals = asRecord(rec.evaluations);
		if (evals === null) continue;
		const coding = score100(evals.artificial_analysis_coding_index);
		const intelligence = score100(evals.artificial_analysis_intelligence_index);
		const agentic = score100(evals.artificial_analysis_agentic_index);
		if (coding === null && intelligence === null && agentic === null) continue;
		const creatorRec = asRecord(rec.model_creator);
		const creator = creatorRec !== null && typeof creatorRec.slug === "string" ? normalizeCreator(creatorRec.slug) : "";
		const entry: FeedScore = { key: normalizeModelKey(slug), creator, source: "artificial_analysis" };
		if (coding !== null) entry.coding = coding;
		if (intelligence !== null) entry.intelligence = intelligence;
		if (agentic !== null) entry.agentic = agentic;
		out.push(entry);
	}
	return out;
}

/**
 * Parse the BenchLM `models[]` payload. Only `supported` rows are used: an
 * `estimated` row is BenchLM's own inference, not a measurement, and applying
 * it at benchmark grade would make the grade mean nothing.
 */
export function parseBenchlmModels(body: unknown): FeedScore[] {
	const root = asRecord(body);
	const models = root === null ? null : root.models;
	if (!Array.isArray(models)) return [];
	const out: FeedScore[] = [];
	for (const raw of models) {
		const rec = asRecord(raw);
		if (rec === null) continue;
		if (rec.evidenceStatus !== "supported") continue;
		const name = typeof rec.model === "string" ? rec.model : null;
		if (name === null || name.length === 0) continue;
		const scores = asRecord(rec.categoryScores);
		if (scores === null) continue;
		// BenchLM's `reasoning` category is the closest proxy for AA's composite
		// intelligence index; coding and agentic map straight across.
		const coding = score100(scores.coding);
		const intelligence = score100(scores.reasoning);
		const agentic = score100(scores.agentic);
		if (coding === null && intelligence === null && agentic === null) continue;
		const creator = typeof rec.creator === "string" ? normalizeCreator(rec.creator) : "";
		const entry: FeedScore = { key: normalizeModelKey(name), creator, source: "benchlm" };
		if (coding !== null) entry.coding = coding;
		if (intelligence !== null) entry.intelligence = intelligence;
		if (agentic !== null) entry.agentic = agentic;
		out.push(entry);
	}
	return out;
}

// ---------------------------------------------------------------------------- fetch

/** The subset of `fetch` these feeds use: call it, get a Response. Lets a test pass a plain stub. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface FetchOpts {
	fetchImpl?: FetchLike;
	timeoutMs?: number;
}

async function fetchJson(url: string, headers: Record<string, string>, opts: FetchOpts): Promise<unknown | null> {
	const impl = opts.fetchImpl ?? fetch;
	try {
		const res = await impl(url, { headers, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

export async function fetchAaScores(apiKey: string, opts: FetchOpts = {}): Promise<FeedScore[]> {
	if (apiKey.trim() === "") return [];
	const body = await fetchJson(AA_MODELS_URL, { "x-api-key": apiKey.trim() }, opts);
	return body === null ? [] : parseAaModels(body);
}

export async function fetchBenchlmScores(opts: FetchOpts = {}): Promise<FeedScore[]> {
	const body = await fetchJson(`${BENCHLM_URL}?mode=bench-align-v5&limit=200`, {}, opts);
	return body === null ? [] : parseBenchlmModels(body);
}

// ---------------------------------------------------------------------------- apply

function pick(candidates: FeedScore[], source: FeedSource, author: string): FeedScore | null {
	const sourced = candidates.filter((c) => c.source === source);
	if (sourced.length === 0) return null;
	if (sourced.length === 1) return sourced[0] ?? null;
	// A shared key with several rows: only the one whose creator matches, and
	// only if that is unique. Anything else is ambiguous and left unfilled.
	const byCreator = sourced.filter((c) => c.creator !== "" && c.creator === author);
	return byCreator.length === 1 ? (byCreator[0] ?? null) : null;
}

/**
 * Mutate raw OpenRouter records in place, filling absent quality axes from the
 * feeds. Scores are written into `benchmarks.artificial_analysis.*_index` so
 * `normalizeCatalogModel` reads them unchanged, and provenance is recorded under
 * `benchmarks.fill_sources` (ignored by normalization, kept for diagnostics).
 */
export function applyFeedScores(rawModels: unknown[], feeds: FeedScore[]): FillResult {
	const result: FillResult = {
		modelsFilled: 0,
		axes: { coding: 0, intelligence: 0, agentic: 0 },
		sources: { artificial_analysis: 0, benchlm: 0, local: 0 },
	};
	if (feeds.length === 0) return result;

	const byKey = new Map<string, FeedScore[]>();
	for (const f of feeds) {
		const list = byKey.get(f.key);
		if (list === undefined) byKey.set(f.key, [f]);
		else list.push(f);
	}

	for (const raw of rawModels) {
		const rec = asRecord(raw);
		if (rec === null) continue;
		const id = typeof rec.id === "string" ? rec.id : null;
		if (id === null) continue;
		const candidates = byKey.get(normalizeModelKey(id));
		if (candidates === undefined) continue;
		const author = authorOf(id);

		const bm = asRecord(rec.benchmarks) ?? {};
		const aa = asRecord(bm.artificial_analysis) ?? {};
		const fillSources: Record<string, string> = {};
		let filledThis = false;

		for (const axis of AXES) {
			if (score100(aa[`${axis}_index`]) !== null) continue; // published; never overwrite
			const aaHit = pick(candidates, "artificial_analysis", author);
			let value = aaHit === null ? undefined : axisValue(aaHit, axis);
			let source: FeedSource = "artificial_analysis";
			if (value === undefined) {
				const blHit = pick(candidates, "benchlm", author);
				value = blHit === null ? undefined : axisValue(blHit, axis);
				source = "benchlm";
			}
			if (value === undefined) {
				// Our own calibrated eval is the weakest source: only where neither
				// published nor third-party feeds have anything.
				const localHit = pick(candidates, "local", author);
				value = localHit === null ? undefined : axisValue(localHit, axis);
				source = "local";
			}
			if (value === undefined) continue;
			aa[`${axis}_index`] = value;
			fillSources[axis] = source;
			result.axes[axis] += 1;
			result.sources[source] += 1;
			filledThis = true;
		}

		if (filledThis) {
			bm.artificial_analysis = aa;
			const priorSources = asRecord(bm.fill_sources) ?? {};
			bm.fill_sources = { ...priorSources, ...fillSources };
			rec.benchmarks = bm;
			result.modelsFilled += 1;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------- cache-aware refresh

interface RefreshOpts extends FetchOpts {
	log?: Logger;
	now?: number;
}

interface CacheRow {
	payload: string;
	fetched_at_ms: number;
}

/**
 * The feed scores, from the `benchmark_cache` table when fresh, else re-fetched
 * and persisted. Cadence is `cfg.benchmarks.refreshMs` (~daily), deliberately
 * decoupled from the minute-scale catalog refresh so the endpoints are not hit
 * on every availability poll. A fetch that returns nothing falls back to the
 * stale cache rather than discarding usable scores.
 */
export async function refreshFeedScores(cfg: RouterConfig, db: Database, opts: RefreshOpts = {}): Promise<FeedScore[]> {
	const log = opts.log ?? createLogger(cfg.logLevel);
	const now = opts.now ?? Date.now();
	const bm = cfg.benchmarks;

	const row = db.query("SELECT payload, fetched_at_ms FROM benchmark_cache WHERE id = 1").get() as CacheRow | null;
	const cached: FeedScore[] | null = row === null ? null : parseFeedScores(row.payload);
	if (row !== null && cached !== null && now - row.fetched_at_ms < bm.refreshMs) return cached;

	const feedOpts: FetchOpts = { timeoutMs: bm.timeoutMs };
	if (opts.fetchImpl !== undefined) feedOpts.fetchImpl = opts.fetchImpl;
	const [aa, bl] = await Promise.all([
		bm.artificialAnalysisApiKey.trim() === ""
			? Promise.resolve<FeedScore[]>([])
			: fetchAaScores(bm.artificialAnalysisApiKey, feedOpts),
		bm.benchlm ? fetchBenchlmScores(feedOpts) : Promise.resolve<FeedScore[]>([]),
	]);
	const merged = [...aa, ...bl];

	if (merged.length === 0) {
		if (cached !== null) {
			log.warn("benchmark feeds returned nothing; reusing the cached feed", { cached: cached.length });
			return cached;
		}
		log.warn("benchmark feeds returned nothing and no cache exists; catalog keeps published scores");
		return [];
	}

	db.query(
		`INSERT INTO benchmark_cache (id, payload, fetched_at_ms) VALUES (1, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at_ms = excluded.fetched_at_ms`,
	).run(JSON.stringify(merged), now);
	log.debug("refreshed benchmark feeds", { artificial_analysis: aa.length, benchlm: bl.length });
	return merged;
}

/** Validate a persisted `FeedScore[]` blob, skipping any entry that drifted. */
function parseFeedScores(payload: string): FeedScore[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	const out: FeedScore[] = [];
	for (const item of parsed) {
		const rec = asRecord(item);
		if (rec === null || typeof rec.key !== "string") continue;
		if (rec.source !== "artificial_analysis" && rec.source !== "benchlm" && rec.source !== "local") continue;
		const entry: FeedScore = {
			key: rec.key,
			creator: typeof rec.creator === "string" ? rec.creator : "",
			source: rec.source,
		};
		const coding = score100(rec.coding);
		if (coding !== null) entry.coding = coding;
		const intelligence = score100(rec.intelligence);
		if (intelligence !== null) entry.intelligence = intelligence;
		const agentic = score100(rec.agentic);
		if (agentic !== null) entry.agentic = agentic;
		out.push(entry);
	}
	return out;
}

/**
 * Local eval scores from the `local_scores` table (written by the eval runner),
 * or [] when absent/unreadable. No TTL: these change only when the eval is
 * re-run, and are gated by `benchmarks.useLocalScores` at the call site.
 */
export function loadLocalScores(db: Database): FeedScore[] {
	const row = db.query("SELECT payload FROM local_scores WHERE id = 1").get() as { payload: string } | null;
	if (row === null) return [];
	return parseFeedScores(row.payload) ?? [];
}

/** Persist local eval scores (source `local`) for `doRefresh` to pick up when enabled. */
export function saveLocalScores(db: Database, scores: readonly FeedScore[], now = Date.now()): void {
	db.query(
		`INSERT INTO local_scores (id, payload, fetched_at_ms) VALUES (1, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at_ms = excluded.fetched_at_ms`,
	).run(JSON.stringify(scores), now);
}
