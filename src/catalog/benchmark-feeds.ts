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
 * Both still leave holes, and the expensive kind is a PARTIAL one: a model with
 * intelligence and neither coding nor agentic clears no tier floor above the
 * cheapest on those axes and is simply never picked. `benchmarks.extraScores`
 * is the seam for that — curated rows a front door supplies (`suppliedScores`),
 * under exactly the rules below.
 *
 * Three rules, all load-bearing:
 *
 *  - FILL, NEVER OVERWRITE. A score OpenRouter already published wins; the feeds
 *    only supply axes that are absent. Two suites measure the same idea on
 *    different tests, so letting one overwrite the other would make a model's
 *    score jump with whichever feed refreshed last.
 *  - PER AXIS, STRONGEST SOURCE FIRST (`FILL_ORDER`). AA fills first, BenchLM
 *    fills whatever axis AA left empty, then anything the front door supplied
 *    through `benchmarks.extraScores` (a neutral leaderboard ahead of a
 *    self-reported vendor number), then our own eval. Every one of them only
 *    ever fills a hole the ones above it left.
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

/**
 * Where one score came from, and — through `FILL_ORDER` — what it may outrank.
 *
 *  - `artificial_analysis`, `benchlm`: the fetched feeds described above.
 *  - `neutral`, `vendor`: supplied through `benchmarks.extraScores` by whatever
 *    sits in front of the router. `neutral` is a benchmark's own leaderboard;
 *    `vendor` is a self-reported model-card number. They stay two members rather
 *    than collapsing into one `supplied` because that distinction is the whole
 *    reason the supplier curated the table, and collapsing would discard it at
 *    the boundary. The router rescales neither: a `vendor` number is expected to
 *    arrive already discounted, and a discount applied twice is its own lie.
 *  - `local`: our own eval harness, gated by `benchmarks.useLocalScores`.
 */
export type FeedSource = "artificial_analysis" | "benchlm" | "neutral" | "vendor" | "local";

/**
 * Fill priority, strongest first — one list rather than a chain of ifs, so the
 * ordering rule is a thing a test can point at. A published score is not in it
 * at all: an axis that already has a value is skipped before this is consulted.
 */
export const FILL_ORDER: readonly FeedSource[] = ["artificial_analysis", "benchlm", "neutral", "vendor", "local"];

/** The sources the fetched-feed cache may hold — exactly what fetches write it. */
const FETCHED_SOURCES: readonly FeedSource[] = ["artificial_analysis", "benchlm"];

/** The sources `benchmarks.extraScores` may claim. Anything else is dropped. */
export const SUPPLIED_SOURCES: readonly FeedSource[] = ["neutral", "vendor"];

/**
 * Cap on `benchmarks.extraScores`. The curated table is a few hundred rows; this
 * sits far above it and exists only so one config patch cannot hand the fill
 * path an unbounded list. The excess is dropped; the rest still applies.
 */
export const MAX_EXTRA_SCORES = 2_000;

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

/** A zeroed per-source counter, derived from `FILL_ORDER` so it cannot drift from it. */
function zeroSources(): Record<FeedSource, number> {
	const out = {} as Record<FeedSource, number>;
	for (const source of FILL_ORDER) out[source] = 0;
	return out;
}

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
		sources: zeroSources(),
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
			// Walk the sources strongest-first and take the first that has this axis:
			// the measured feeds, then whatever the front door supplied (a neutral
			// leaderboard ahead of a self-reported vendor number), then our own
			// calibrated eval, which only ever fills what nothing else does.
			let value: number | undefined;
			let source: FeedSource | undefined;
			for (const candidate of FILL_ORDER) {
				const hit = pick(candidates, candidate, author);
				const found = hit === null ? undefined : axisValue(hit, axis);
				if (found === undefined) continue;
				value = found;
				source = candidate;
				break;
			}
			if (value === undefined || source === undefined) continue;
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
	const cached: FeedScore[] | null = row === null ? null : parseFeedScores(row.payload, FETCHED_SOURCES);
	// A zero timestamp is `invalidateFeedCache`'s marker, not a real fetch time:
	// the payload stays readable as a fallback but never counts as fresh again.
	const fresh = row !== null && row.fetched_at_ms > 0 && now - row.fetched_at_ms < bm.refreshMs;
	if (fresh && cached !== null) return cached;

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

/**
 * Mark the cached feeds stale so the next `refreshFeedScores` re-fetches instead
 * of sitting out `benchmarks.refreshMs` (~a day). The benchmarks config changing
 * is what calls this: an Artificial Analysis key that only takes effect tomorrow
 * is a key the operator will believe is broken, and a key taken away has to stop
 * filling scores just as promptly.
 *
 * The row is aged out, never deleted. A forced re-fetch that then fails must
 * still find the previous scores to fall back on — best-effort is the rule here,
 * and invalidation must not be the one path that empties the catalog.
 */
export function invalidateFeedCache(db: Database): void {
	db.query("UPDATE benchmark_cache SET fetched_at_ms = 0 WHERE id = 1").run();
}

interface SanitizeOpts {
	/** Which `source` values are acceptable here. */
	allow: readonly FeedSource[];
	/** Re-run `normalizeModelKey`/`normalizeCreator` on the way in. */
	normalize?: boolean;
}

interface SanitizeResult {
	scores: FeedScore[];
	/** Entries thrown away whole: not an object, no key, or a source not allowed. */
	dropped: number;
	/** Axes thrown away from an otherwise usable entry: not a finite number in [0, 100]. */
	droppedAxes: number;
}

/**
 * Turn an arbitrary array into `FeedScore[]`, keeping only what is usable.
 *
 * The one invariant everything downstream leans on: an axis this cannot read is
 * OMITTED, never defaulted. `applyFeedScores` writes only defined values, so a
 * `"61"` or a `-3` or a `NaN` leaves the axis exactly as unscored as it was —
 * a bad entry can no more zero a score than it can raise one.
 */
function sanitizeFeedScores(value: unknown, opts: SanitizeOpts): SanitizeResult {
	const result: SanitizeResult = { scores: [], dropped: 0, droppedAxes: 0 };
	if (!Array.isArray(value)) return result;
	for (const item of value) {
		const rec = asRecord(item);
		if (rec === null || typeof rec.key !== "string") {
			result.dropped += 1;
			continue;
		}
		const source = rec.source;
		if (typeof source !== "string" || !opts.allow.includes(source as FeedSource)) {
			result.dropped += 1;
			continue;
		}
		const rawCreator = typeof rec.creator === "string" ? rec.creator : "";
		const key = opts.normalize === true ? normalizeModelKey(rec.key) : rec.key;
		if (key === "") {
			result.dropped += 1;
			continue;
		}
		const entry: FeedScore = {
			key,
			creator: opts.normalize === true ? normalizeCreator(rawCreator) : rawCreator,
			source: source as FeedSource,
		};
		for (const axis of AXES) {
			const present = rec[axis];
			if (present === undefined || present === null) continue;
			const parsed = score100(present);
			if (parsed === null) {
				result.droppedAxes += 1;
				continue;
			}
			entry[axis] = parsed;
		}
		result.scores.push(entry);
	}
	return result;
}

/**
 * Validate a persisted `FeedScore[]` blob, skipping any entry that drifted.
 * `allow` is what WROTE this particular blob, so a row can never reach a rank by
 * sitting in a table that does not produce that source — the keys are already
 * normalized here, having been normalized when they were parsed out of a feed.
 */
function parseFeedScores(payload: string, allow: readonly FeedSource[]): FeedScore[] | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return null;
	}
	if (!Array.isArray(parsed)) return null;
	return sanitizeFeedScores(parsed, { allow }).scores;
}

/**
 * `benchmarks.extraScores`, sanitised. The front door curates a table of
 * vendor-published and neutral-leaderboard numbers for axes the feeds leave
 * empty — the case this exists for is a model carrying intelligence and nothing
 * else, which no tier floor above the cheapest can admit.
 *
 * Three decisions live here, all about the fact that this arrives over a config
 * patch from ANOTHER PROCESS rather than out of a file the operator wrote:
 *
 *  - A malformed entry is DROPPED, LOUDLY — never a refused patch. The patch
 *    carries unrelated settings (the Artificial Analysis key rides in the same
 *    `benchmarks` block), and one bad row out of six hundred must not take an
 *    operator's key save down with it. Silence was the other option and is worse:
 *    a table that quietly stopped applying looks exactly like one that worked.
 *  - Only `neutral` and `vendor` are accepted. Config claiming
 *    `artificial_analysis` would outrank BenchLM on the strength of a label, and
 *    config claiming `local` would write into the lane `useLocalScores` gates —
 *    which is precisely the switch this design refuses to make into a lie.
 *  - Keys are normalised here, so the supplier may send the OpenRouter slug
 *    (`deepseek/deepseek-v4.1-flash`) and need not reimplement the match key.
 */
export function suppliedScores(cfg: RouterConfig, log?: Logger): FeedScore[] {
	const supplied = cfg.benchmarks.extraScores;
	if (supplied === undefined || supplied.length === 0) return [];
	const capped = supplied.length > MAX_EXTRA_SCORES ? supplied.slice(0, MAX_EXTRA_SCORES) : supplied;
	const { scores, dropped, droppedAxes } = sanitizeFeedScores(capped, { allow: SUPPLIED_SOURCES, normalize: true });
	const over = supplied.length - capped.length;
	if (dropped > 0 || droppedAxes > 0 || over > 0) {
		(log ?? createLogger(cfg.logLevel)).warn("supplied benchmark scores partly unusable; the rest still apply", {
			kept: scores.length,
			droppedEntries: dropped + over,
			droppedAxes,
			...(over > 0 ? { overCap: MAX_EXTRA_SCORES } : {}),
		});
	}
	return scores;
}

/**
 * Local eval scores from the `local_scores` table (written by the eval runner),
 * or [] when absent/unreadable. No TTL: these change only when the eval is
 * re-run, and are gated by `benchmarks.useLocalScores` at the call site.
 */
export function loadLocalScores(db: Database): FeedScore[] {
	const row = db.query("SELECT payload FROM local_scores WHERE id = 1").get() as { payload: string } | null;
	if (row === null) return [];
	// Only `local` may come out of the local lane: the table `useLocalScores`
	// gates must not be a way to claim a rank it does not have.
	return parseFeedScores(row.payload, ["local"]) ?? [];
}

/** Persist local eval scores (source `local`) for `doRefresh` to pick up when enabled. */
export function saveLocalScores(db: Database, scores: readonly FeedScore[], now = Date.now()): void {
	db.query(
		`INSERT INTO local_scores (id, payload, fetched_at_ms) VALUES (1, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at_ms = excluded.fetched_at_ms`,
	).run(JSON.stringify(scores), now);
}
