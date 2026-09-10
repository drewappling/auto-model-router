/**
 * The spend ledger: one row per dispatched generation, plus the two derived
 * signals the router consumes — per-model trust (Laplace-smoothed success) and
 * per-tokenizer-family token calibration.
 *
 * `record` also persists the cost component split implied by the entry's own
 * model pricing (`cost_breakdown`). The split needs catalog prices, which the
 * ledger does not receive; it reads them back from the `catalog_cache` row the
 * catalog slice already persists, re-normalized lazily and re-read only when
 * the cache's `fetched_at_ms` changes. An entry recorded before the first
 * catalog fetch simply stores NULL and is skipped by the blended rate.
 */

import type { Database } from "bun:sqlite";
import { normalizeCatalogModel } from "../catalog/openrouter-catalog.ts";
import type { CatalogModel } from "../catalog/types.ts";
import type { RouterConfig } from "../config/types.ts";
import { consumePendingEstimate } from "../tokens/estimate.ts";
import { computeBlendedRate } from "./blended.ts";
import { computeCost } from "./forecast.ts";
import type {
	BlendedRate,
	EscalationCost,
	Ledger,
	LedgerEntry,
	LedgerSignals,
	ModelCacheReliability,
	ModelLatency,
	ModelTrust,
	PruneResult,
	SoftFailureSpike,
	UsageCounts,
} from "./types.ts";

/** Estimates below this many samples are noise; the default ratio is better. */
const MIN_CALIBRATION_SAMPLES = 20;
/** Calibration samples outside this bytes-per-token band are provider accounting quirks, not tokenizer facts. */
const MIN_SANE_BYTES_PER_TOKEN = 1.5;
const MAX_SANE_BYTES_PER_TOKEN = 8;
/**
 * Soft-failure spike detection (visibility only). A model is spiking when, over
 * the recent window, it has at least SPIKE_MIN_DISPATCHES dispatches, at least
 * SPIKE_MIN_FAILURES of them failed, its failure rate is at least
 * SPIKE_MIN_RATE, and that rate is at least SPIKE_RATIO × its own baseline
 * rate over the preceding window (a model with no baseline failures spikes on
 * the absolute floor alone).
 */
const SPIKE_RECENT_MS = 60 * 60_000;
const SPIKE_BASELINE_MS = 7 * 24 * 60 * 60_000;
const SPIKE_MIN_DISPATCHES = 5;
const SPIKE_MIN_FAILURES = 3;
const SPIKE_MIN_RATE = 0.25;
const SPIKE_RATIO = 2;
/** Escalated attempts needed before their measured cost is trusted. */
const MIN_ESCALATION_SAMPLES = 10;
/** The escalation-cost aggregate scans a window of rows; memoised for this long. */
const ESCALATION_COST_MEMO_MS = 60_000;

/**
 * Cache reliability is one window-function pass over the newest rows, memoised
 * for a minute: the previous kept turn of each conversation is found with LAG,
 * and a row counts when that turn was on the same model within the warm TTL.
 */
const CACHE_RELIABILITY_ROWS = 6_000;
const CACHE_RELIABILITY_MEMO_MS = 60_000;
const DAY_MS = 86_400_000;

// Row shapes below are fixed by our own schema in util/sqlite.ts.
export interface LedgerRow {
	id: string;
	created_at_ms: number;
	conversation_key: string;
	session_id: string;
	turn: number;
	requested_model: string;
	harness_id: string;
	omp_session_id: string;
	slug: string;
	served_slug: string | null;
	tier: string;
	classification_source: string;
	reasons: string;
	features: string | null;
	score: number | null;
	confidence: number | null;
	task: string | null;
	classifier_reasons: string | null;
	explored_from: string | null;
	hold_arm: number | null;
	predicted_usd: number;
	reported_usd: number | null;
	usage: string;
	cost_breakdown: string | null;
	attempt: number;
	escalation_signal: string | null;
	latency_ms: number;
	ttft_ms: number | null;
	finish_reason: string | null;
	wasted: number;
	upstream_generation_id: string | null;
	error: string | null;
	prompt_tokens_saved: number | null;
	scope: string | null;
	redactions: number | null;
}

interface TrustRow {
	attempts: number;
	escalations: number;
	errors: number;
	failures: number;
	mean_cost_error: number | null;
}

interface FeedbackRow {
	good: number | null;
	bad: number | null;
}

/** Verdict counts per served slug since a cutoff (optionally one harness). */
const FEEDBACK_SELECT = `COALESCE(SUM(CASE WHEN f.verdict = 'good' THEN 1 ELSE 0 END), 0) AS good,
		COALESCE(SUM(CASE WHEN f.verdict = 'bad' THEN 1 ELSE 0 END), 0) AS bad`;

interface LatencyRow {
	samples: number;
	ttft_ms: number | null;
	ctok_sum: number | null;
	elapsed_ms_sum: number | null;
}

interface CalibrationRow {
	est_bytes: number;
	actual_tokens: number;
	samples: number;
}

/**
 * Error kinds that say nothing about a MODEL's reliability, and so must not
 * count against its trust:
 *  - `aborted`: the client hung up (user pressed escape mid-turn).
 *  - `auth`: credential or credit refusal (401 invalid key, 402 out of credits)
 *    — key-wide, identical for every model.
 *  - `moderation`: a provider content-moderation or per-model policy gate (403:
 *    prompt-injection block, age/data-policy confirmation). Per-model, not a
 *    quality signal, and failover already handles it.
 *  - `model_unavailable`: the guardrail or data policy excludes the endpoint;
 *    an availability fact, not a quality one, and failover already handles it.
 *
 * Everything else (upstream_error, timeout, network, rate_limit, …) stays
 * attributable. A NULL `error_kind` on a row that HAS an error is an
 * unclassifiable legacy row and stays attributable, preserving the old,
 * stricter behaviour rather than silently forgiving it.
 */
// `quota` joins the list for the same reason as `auth`: an exhausted plan
// allowance is a fact about the account, identical for every model behind it.
const UNATTRIBUTABLE_KINDS = "('aborted', 'auth', 'moderation', 'model_unavailable', 'quota')";

const ATTRIBUTABLE_ERROR = `error IS NOT NULL AND (error_kind IS NULL OR error_kind NOT IN ${UNATTRIBUTABLE_KINDS})`;

const TRUST_SELECT = `COUNT(*) AS attempts,
		COALESCE(SUM(CASE WHEN escalation_signal IS NOT NULL THEN 1 ELSE 0 END), 0) AS escalations,
		COALESCE(SUM(CASE WHEN ${ATTRIBUTABLE_ERROR} THEN 1 ELSE 0 END), 0) AS errors,
		COALESCE(SUM(CASE WHEN escalation_signal IS NOT NULL OR (${ATTRIBUTABLE_ERROR}) THEN 1 ELSE 0 END), 0) AS failures,
		AVG(CASE WHEN reported_usd IS NOT NULL AND reported_usd > 0
			THEN ABS(reported_usd - predicted_usd) / reported_usd END) AS mean_cost_error`;

/**
 * Responsiveness over streamed, non-errored turns. TTFT (not total latency)
 * isolates start latency from answer length: a model is "slow to start" when it
 * takes a long time to emit the FIRST token. Throughput (aggregate completion
 * tokens per post-TTFT second) captures the complementary axis — how fast the
 * body streams once it starts. Errored/aborted and non-streaming rows (null
 * ttft) are excluded; throughput additionally requires a positive completion
 * count and elapsed time.
 *
 * Aggregated over a RECENT WINDOW (LATENCY_WINDOW_ROWS newest rows per slug),
 * NOT all history: a model that degrades — e.g. deepseek-v4-flash collapsing
 * from ~18 tok/s to ~7 — must move its score fast, or the penalty is drowned by
 * hundreds of historical good rows and never demotes it (observed live: it kept
 * 100% of coding at ~53s/turn despite latencyWeight=0.75). Trust (reliability)
 * stays all-time; latency (volatile) is recency-weighted.
 */
const LATENCY_SELECT = `COUNT(CASE WHEN ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL THEN 1 END) AS samples,
		AVG(CASE WHEN ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL THEN ttft_ms END) AS ttft_ms,
		SUM(CASE WHEN ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL AND latency_ms > ttft_ms
			AND json_extract(usage, '$.completionTokens') > 0
			THEN json_extract(usage, '$.completionTokens') END) AS ctok_sum,
		SUM(CASE WHEN ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL AND latency_ms > ttft_ms
			AND json_extract(usage, '$.completionTokens') > 0
			THEN latency_ms - ttft_ms END) AS elapsed_ms_sum`;

/**
 * Recent-rows window for latency stats: recent enough to react to a degrading
 * model, wide enough to stay stable for a busy one. Rows are taken newest-first
 * and then filtered by LATENCY_SELECT, so recent aborts naturally shrink the
 * qualifying sample count (and can drop a model below latencyMinSamples).
 */
export const LATENCY_WINDOW_ROWS = 100;

/**
 * Recovers the `UpstreamErrorKind` from the text turn.ts stored.
 *
 * Errors are written as `"<kind>: <message>"`, except the abort path which
 * writes the bare message. Returning null for anything unrecognised keeps that
 * row model-attributable — the stricter reading — rather than quietly
 * forgiving a failure we cannot classify.
 */
function errorKindOf(error: string | null): string | null {
	if (error === null) return null;
	if (error === "request aborted") return "aborted";
	const sep = error.indexOf(": ");
	if (sep <= 0) return null;
	return error.slice(0, sep);
}

function toTrust(slug: string, row: TrustRow, fb: FeedbackRow | null = null, feedbackWeight = 0): ModelTrust {
	// Laplace smoothing: an untried model scores a neutral 1/2, and a failure
	// is an attempt superseded by an escalation or ended in an upstream error.
	// A user verdict counts as feedbackWeight extra attempts of that outcome.
	const good = fb?.good ?? 0;
	const bad = fb?.bad ?? 0;
	const w = feedbackWeight > 0 ? feedbackWeight : 0;
	const attempts = row.attempts + w * (good + bad);
	const failures = row.failures + w * bad;
	return {
		slug,
		attempts: row.attempts,
		escalations: row.escalations,
		errors: row.errors,
		feedbackGood: good,
		feedbackBad: bad,
		successRate: (attempts - failures + 1) / (attempts + 2),
		meanCostError: row.mean_cost_error ?? 0,
	};
}

function toLatency(slug: string, row: LatencyRow): ModelLatency | null {
	if (row.samples <= 0 || row.ttft_ms === null) return null;
	const tokensPerSec =
		row.elapsed_ms_sum !== null && row.elapsed_ms_sum > 0 && row.ctok_sum !== null
			? (row.ctok_sum * 1000) / row.elapsed_ms_sum
			: 0;
	return { slug, samples: row.samples, ttftMs: row.ttft_ms, tokensPerSec };
}

export function toEntry(row: LedgerRow): LedgerEntry {
	return {
		id: row.id,
		createdAtMs: row.created_at_ms,
		conversationKey: row.conversation_key,
		sessionId: row.session_id,
		turn: row.turn,
		requestedModel: row.requested_model,
		harnessId: row.harness_id,
		ompSessionId: row.omp_session_id,
		slug: row.slug,
		servedSlug: row.served_slug,
		tier: row.tier,
		classificationSource: row.classification_source,
		reasons: JSON.parse(row.reasons) as string[],
		features: row.features === null ? null : (JSON.parse(row.features) as object),
		score: row.score,
		confidence: row.confidence,
		task: row.task,
		classifierReasons: row.classifier_reasons === null ? null : (JSON.parse(row.classifier_reasons) as string[]),
		exploredFrom: row.explored_from,
		holdArm: row.hold_arm,
		predictedUsd: row.predicted_usd,
		reportedUsd: row.reported_usd,
		usage: JSON.parse(row.usage) as UsageCounts,
		attempt: row.attempt,
		escalationSignal: row.escalation_signal,
		latencyMs: row.latency_ms,
		ttftMs: row.ttft_ms,
		finishReason: row.finish_reason,
		wasted: row.wasted === 1,
		upstreamGenerationId: row.upstream_generation_id,
		error: row.error,
		promptTokensSaved: row.prompt_tokens_saved ?? 0,
		// Optional under exactOptionalPropertyTypes: an old row (or a scopeless
		// turn) simply has no `scope`, rather than an explicit undefined.
		...(row.scope === null || row.scope === undefined ? {} : { scope: row.scope }),
		// Likewise a row from before v19, or a turn with redaction off: absent,
		// which is a different fact from 0 (the rules ran and matched nothing).
		...(row.redactions === null || row.redactions === undefined ? {} : { redactions: row.redactions }),
	};
}

export interface CacheReliabilityRow {
	slug: string;
	samples: number;
	hit: number;
}

/**
 * Observed cache hit rates when a warm cache was expected, per served slug.
 * `sinceMs` bounds the rows scanned (0 ⇒ the newest `limitRows`). Rows whose
 * cache count the router estimated (`usage.cachedEstimated`) are excluded.
 */
export function queryCacheReliability(db: Database, opts: { warmTtlMs: number; sinceMs?: number; limitRows?: number }): CacheReliabilityRow[] {
	const sinceMs = opts.sinceMs ?? 0;
	const limitRows = opts.limitRows ?? CACHE_RELIABILITY_ROWS;
	return db
		.query(
			`WITH recent AS (
				SELECT conversation_key AS ck, created_at_ms AS t, COALESCE(served_slug, slug) AS s,
					json_extract(usage, '$.promptTokens') AS p, json_extract(usage, '$.cachedTokens') AS c,
					COALESCE(json_extract(usage, '$.cachedEstimated'), 0) AS est
				FROM ledger WHERE wasted = 0 AND error IS NULL AND created_at_ms >= $since
				ORDER BY created_at_ms DESC LIMIT $limit),
			seq AS (
				SELECT s, p, c, est, t,
					LAG(s) OVER w AS prev_s, LAG(p) OVER w AS prev_p, LAG(t) OVER w AS prev_t
				FROM recent WINDOW w AS (PARTITION BY ck ORDER BY t))
			SELECT s AS slug, COUNT(*) AS samples, AVG(MIN(1.0, c * 1.0 / MIN(prev_p, p))) AS hit
			FROM seq
			WHERE prev_s = s AND p > 1000 AND prev_p > 1000 AND t - prev_t <= $ttl AND est = 0
			GROUP BY s`,
		)
		.all({ $since: sinceMs, $limit: limitRows, $ttl: opts.warmTtlMs }) as CacheReliabilityRow[];
}

export function createLedger(db: Database, cfg: RouterConfig): Ledger {
	let cacheMemo: { atMs: number; map: Map<string, ModelCacheReliability> } | null = null;
	// Prepared once: record() runs on every turn.
	const insertStmt = db.query(
		`INSERT INTO ledger (
			id, created_at_ms, conversation_key, session_id, turn, requested_model, harness_id, omp_session_id, slug, served_slug,
			tier, classification_source, reasons, predicted_usd, reported_usd, usage, cost_breakdown,
			attempt, escalation_signal, latency_ms, ttft_ms, finish_reason, wasted, upstream_generation_id, error,
			error_kind, features, score, confidence, task, classifier_reasons, explored_from, hold_arm, prompt_tokens_saved, scope, redactions
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const calibrationStmt = db.query(
		`INSERT INTO token_calibration (tokenizer, est_bytes, actual_tokens, samples) VALUES (?, ?, ?, 1)
		 ON CONFLICT(tokenizer) DO UPDATE SET
			est_bytes = est_bytes + excluded.est_bytes,
			actual_tokens = actual_tokens + excluded.actual_tokens,
			samples = samples + 1`,
	);
	const spendByConversationStmt = db.query(
		"SELECT COALESCE(SUM(COALESCE(reported_usd, predicted_usd)), 0) AS total FROM ledger WHERE conversation_key = ?",
	);
	const spendSinceStmt = db.query(
		"SELECT COALESCE(SUM(COALESCE(reported_usd, predicted_usd)), 0) AS total FROM ledger WHERE created_at_ms >= ?",
	);
	const spendSinceHarnessStmt = db.query(
		"SELECT COALESCE(SUM(COALESCE(reported_usd, predicted_usd)), 0) AS total FROM ledger WHERE created_at_ms >= ? AND harness_id = ?",
	);
	// `created_at_ms > ?` is always present, with a cutoff of 0 meaning all-time.
	// One statement shape rather than two keeps the plan (and the index it uses,
	// idx_ledger_slug_created) identical whether or not a window is configured.
	const trustStmt = db.query(`SELECT ${TRUST_SELECT} FROM ledger WHERE slug = ? AND created_at_ms > ?`);
	const trustHarnessStmt = db.query(`SELECT ${TRUST_SELECT} FROM ledger WHERE slug = ? AND harness_id = ? AND created_at_ms > ?`);
	const allTrustStmt = db.query(`SELECT slug, ${TRUST_SELECT} FROM ledger WHERE created_at_ms > ? GROUP BY slug`);
	const feedbackStmt = db.query(`SELECT ${FEEDBACK_SELECT} FROM feedback f WHERE f.slug = ? AND f.created_at_ms > ?`);
	const feedbackHarnessStmt = db.query(
		`SELECT ${FEEDBACK_SELECT} FROM feedback f JOIN ledger l ON l.id = f.ledger_id WHERE f.slug = ? AND l.harness_id = ? AND f.created_at_ms > ?`,
	);
	const allFeedbackStmt = db.query(`SELECT f.slug, ${FEEDBACK_SELECT} FROM feedback f WHERE f.created_at_ms > ? GROUP BY f.slug`);
	// Task-scoped variants (filters.feedbackByTask): the judged turn's task
	// must match, or be unrecorded (older rows, or a turn that never classified).
	const feedbackTaskStmt = db.query(
		`SELECT ${FEEDBACK_SELECT} FROM feedback f JOIN ledger l ON l.id = f.ledger_id WHERE f.slug = ? AND (l.task = ? OR l.task IS NULL) AND f.created_at_ms > ?`,
	);
	const feedbackHarnessTaskStmt = db.query(
		`SELECT ${FEEDBACK_SELECT} FROM feedback f JOIN ledger l ON l.id = f.ledger_id WHERE f.slug = ? AND l.harness_id = ? AND (l.task = ? OR l.task IS NULL) AND f.created_at_ms > ?`,
	);
	const feedbackFor = (slug: string, harnessId: string | undefined, cutoff: number, task?: string): FeedbackRow | null => {
		if (cfg.filters.feedbackWeight <= 0) return null;
		const byHarness = harnessId !== undefined && harnessId !== "";
		if (cfg.filters.feedbackByTask && task !== undefined && task !== "") {
			return byHarness
				? (feedbackHarnessTaskStmt.get(slug, harnessId, task, cutoff) as FeedbackRow | null)
				: (feedbackTaskStmt.get(slug, task, cutoff) as FeedbackRow | null);
		}
		return byHarness ? (feedbackHarnessStmt.get(slug, harnessId, cutoff) as FeedbackRow | null) : (feedbackStmt.get(slug, cutoff) as FeedbackRow | null);
	};
	const latencyStmt = db.query(
		`SELECT ${LATENCY_SELECT} FROM (SELECT * FROM ledger WHERE slug = ? ORDER BY created_at_ms DESC LIMIT ${LATENCY_WINDOW_ROWS})`,
	);
	const latencyHarnessStmt = db.query(
		`SELECT ${LATENCY_SELECT} FROM (SELECT * FROM ledger WHERE slug = ? AND harness_id = ? ORDER BY created_at_ms DESC LIMIT ${LATENCY_WINDOW_ROWS})`,
	);
	const ratioStmt = db.query("SELECT est_bytes, actual_tokens, samples FROM token_calibration WHERE tokenizer = ?");
	const recentStmt = db.query("SELECT * FROM ledger ORDER BY created_at_ms DESC LIMIT ?");
	const pruneStmt = db.query("DELETE FROM ledger WHERE created_at_ms < ?");
	// Feedback is a verdict ON a ledger row; keeping it past the turn it judges
	// would leave a note about a conversation the operator asked us to forget.
	// Matched by the row it points at AND by its own age, so verdicts orphaned
	// by a prune that ran before v0.21.0 are swept up too.
	const pruneFeedbackStmt = db.query(
		"DELETE FROM feedback WHERE created_at_ms < ? OR ledger_id IN (SELECT id FROM ledger WHERE created_at_ms < ?)",
	);
	// Ollama meter samples (one per usage poll) only matter for the current
	// billing cycle's calibration; they age out with the ledger rows.
	const pruneMeterStmt = db.query("DELETE FROM ollama_meter_samples WHERE at_ms < ?");
	const oldestStmt = db.query("SELECT MIN(created_at_ms) AS oldest FROM ledger");
	const wasteStmt = db.query("UPDATE ledger SET wasted = 1 WHERE id = ?");
	const providerSpendStmt = db.query(
		"SELECT COALESCE(SUM(COALESCE(reported_usd, predicted_usd)), 0) AS total FROM ledger WHERE created_at_ms >= ? AND COALESCE(served_slug, slug) LIKE ?",
	);
	// Digest rows (requested_model 'digest') are side calls, not the session's turns.
	const sessionStmt = db.query("SELECT * FROM ledger WHERE omp_session_id = ? AND wasted = 0 AND requested_model <> 'digest' ORDER BY created_at_ms DESC LIMIT ?");
	// What an escalated retry actually bills, per prompt token, over a window.
	// attempt > 0 rows are the re-dispatches that followed a rejected attempt;
	// errored ones carry no usage and are excluded.
	const escalationCostStmt = db.query(
		`SELECT COUNT(*) AS samples,
			COALESCE(SUM(COALESCE(reported_usd, predicted_usd)), 0) AS usd,
			COALESCE(SUM(json_extract(usage, '$.promptTokens')), 0) AS prompt_tokens
		 FROM ledger WHERE attempt > 0 AND error IS NULL AND created_at_ms >= ?`,
	);
	let escalationMemo: { atMs: number; windowDays: number; value: EscalationCost | null } | null = null;
	// Per-model failure counts over two adjacent windows: [recentStart, now] and
	// [baselineStart, recentStart). Wasted rows (the failed attempt a retry
	// replaced) stay in: they ARE the soft failures being counted. Digest side
	// calls are excluded: they are not the session's turns.
	const softFailureStmt = db.query(
		`SELECT COALESCE(served_slug, slug) AS slug,
			SUM(CASE WHEN created_at_ms >= $recentStart THEN 1 ELSE 0 END) AS recent_n,
			SUM(CASE WHEN created_at_ms >= $recentStart AND (escalation_signal IS NOT NULL OR (${ATTRIBUTABLE_ERROR})) THEN 1 ELSE 0 END) AS recent_f,
			SUM(CASE WHEN created_at_ms < $recentStart THEN 1 ELSE 0 END) AS base_n,
			SUM(CASE WHEN created_at_ms < $recentStart AND (escalation_signal IS NOT NULL OR (${ATTRIBUTABLE_ERROR})) THEN 1 ELSE 0 END) AS base_f
		 FROM ledger WHERE created_at_ms >= $baselineStart AND created_at_ms <= $now AND requested_model <> 'digest'
		 GROUP BY COALESCE(served_slug, slug)`,
	);
	const cacheMetaStmt = db.query("SELECT fetched_at_ms FROM catalog_cache WHERE id = 1");
	const cachePayloadStmt = db.query("SELECT payload FROM catalog_cache WHERE id = 1");

	let indexFetchedAtMs = -1;
	let modelBySlug: Map<string, CatalogModel> | null = null;

	/** Slug → catalog model, rebuilt only when the catalog cache row changes. */
	function priceIndex(): Map<string, CatalogModel> | null {
		const meta = cacheMetaStmt.get() as { fetched_at_ms: number } | null;
		if (meta === null) return null;
		if (modelBySlug !== null && indexFetchedAtMs === meta.fetched_at_ms) return modelBySlug;
		const row = cachePayloadStmt.get() as { payload: string } | null;
		if (row === null) return null;
		const payload: unknown = JSON.parse(row.payload);
		if (!Array.isArray(payload)) return null;
		const map = new Map<string, CatalogModel>();
		for (const record of payload) {
			const model = normalizeCatalogModel(record);
			if (model !== null) map.set(model.slug, model);
		}
		modelBySlug = map;
		indexFetchedAtMs = meta.fetched_at_ms;
		return map;
	}

	return {
		record(entry: LedgerEntry): void {
			const models = priceIndex();
			const model =
				entry.priceModel ?? (entry.servedSlug !== null ? models?.get(entry.servedSlug) : undefined) ?? models?.get(entry.slug) ?? null;
			insertStmt.run(
				entry.id,
				entry.createdAtMs,
				entry.conversationKey,
				entry.sessionId,
				entry.turn,
				entry.requestedModel,
				entry.harnessId,
				entry.ompSessionId,
				entry.slug,
				entry.servedSlug,
				entry.tier,
				entry.classificationSource,
				JSON.stringify(entry.reasons),
				entry.predictedUsd,
				entry.reportedUsd,
				JSON.stringify(entry.usage),
				model !== null ? JSON.stringify(computeCost(model, entry.usage)) : null,
				entry.attempt,
				entry.escalationSignal,
				entry.latencyMs,
				entry.ttftMs,
				entry.finishReason,
				entry.wasted ? 1 : 0,
				entry.upstreamGenerationId,
				entry.error,
				errorKindOf(entry.error),
				entry.features === null ? null : JSON.stringify(entry.features),
				entry.score,
				entry.confidence,
				entry.task,
				entry.classifierReasons === null ? null : JSON.stringify(entry.classifierReasons),
				entry.exploredFrom,
				entry.holdArm,
				entry.promptTokensSaved,
				// A turn that carried no scope stores NULL, exactly as every row
				// written before v18 did; "" and absent are the same fact.
				entry.scope === undefined || entry.scope === "" ? null : entry.scope,
				// NULL when redaction was off for this turn; 0 says the rules ran.
				entry.redactions ?? null,
			);
			// Always consume the pending estimate, even when the turn failed, so a
			// dead turn's bytes can never pair with a later turn's tokens. Only
			// actually-billed prompt tokens calibrate.
			const pending = consumePendingEstimate(entry.conversationKey);
			if (entry.usage.promptTokens > 0 && pending !== null) {
				// The SERVED model's tokenizer produced the billing; the estimate-time
				// family is the fallback when the model is unknown to the catalog.
				const tokenizer = (model?.tokenizer ?? pending.tokenizer).trim().toLowerCase();
				// Reject samples no real tokenizer could produce. The rows are
				// running sums, so one provider that reports inflated counts (seen:
				// ~8x the bytes-implied tokens, i.e. 0.4 bytes/token) poisons a
				// whole family for thousands of samples. Text tokenizers land
				// between ~2 and ~5 bytes/token; the band is generous around that.
				const bytesPerToken = pending.bytes / entry.usage.promptTokens;
				if (bytesPerToken >= MIN_SANE_BYTES_PER_TOKEN && bytesPerToken <= MAX_SANE_BYTES_PER_TOKEN) {
					calibrationStmt.run(tokenizer, pending.bytes, entry.usage.promptTokens);
				}
			}
		},

		conversationSpend(conversationKey: string): number {
			const row = spendByConversationStmt.get(conversationKey) as { total: number } | null;
			return row?.total ?? 0;
		},

		spendSince(sinceMs: number, harnessId?: string): number {
			const row =
				harnessId !== undefined && harnessId !== ""
					? (spendSinceHarnessStmt.get(sinceMs, harnessId) as { total: number } | null)
					: (spendSinceStmt.get(sinceMs) as { total: number } | null);
			return row?.total ?? 0;
		},

		blendedRate(windowDays: number): BlendedRate | null {
			return computeBlendedRate(db, cfg, windowDays);
		},

		trust(slug: string, harnessId?: string, task?: string): ModelTrust | null {
			// Read the window at CALL time, not at construction: hot reload mutates
			// the shared config object in place, so a pinned value would ignore an
			// edit until restart. 0 => cutoff 0 => every row qualifies.
			const cutoff = cfg.filters.trustWindowDays > 0 ? Date.now() - cfg.filters.trustWindowDays * DAY_MS : 0;
			const row =
				harnessId !== undefined && harnessId !== ""
					? (trustHarnessStmt.get(slug, harnessId, cutoff) as TrustRow | null)
					: (trustStmt.get(slug, cutoff) as TrustRow | null);
			if (row === null || row.attempts === 0) return null;
			return toTrust(slug, row, feedbackFor(slug, harnessId, cutoff, task), cfg.filters.feedbackWeight);
		},

		allTrust(): ModelTrust[] {
			const cutoff = cfg.filters.trustWindowDays > 0 ? Date.now() - cfg.filters.trustWindowDays * DAY_MS : 0;
			const rows = allTrustStmt.all(cutoff) as (TrustRow & { slug: string })[];
			const fb = new Map<string, FeedbackRow>();
			if (cfg.filters.feedbackWeight > 0) {
				for (const r of allFeedbackStmt.all(cutoff) as (FeedbackRow & { slug: string })[]) fb.set(r.slug, r);
			}
			return rows.map((row) => toTrust(row.slug, row, fb.get(row.slug) ?? null, cfg.filters.feedbackWeight));
		},

		latency(slug: string, harnessId?: string): ModelLatency | null {
			const row =
				harnessId !== undefined && harnessId !== ""
					? (latencyHarnessStmt.get(slug, harnessId) as LatencyRow | null)
					: (latencyStmt.get(slug) as LatencyRow | null);
			if (row === null) return null;
			return toLatency(slug, row);
		},
		signals(slugs: readonly string[], harnessId?: string, task?: string): Map<string, LedgerSignals> {
			const cutoff = cfg.filters.trustWindowDays > 0 ? Date.now() - cfg.filters.trustWindowDays * DAY_MS : 0;
			const hasHarness = harnessId !== undefined && harnessId !== "";
			const out = new Map<string, LedgerSignals>();
			for (const slug of slugs) {
				const trustRow = hasHarness
					? (trustHarnessStmt.get(slug, harnessId, cutoff) as TrustRow | null)
					: (trustStmt.get(slug, cutoff) as TrustRow | null);
				const latencyRow = hasHarness
					? (latencyHarnessStmt.get(slug, harnessId) as LatencyRow | null)
					: (latencyStmt.get(slug) as LatencyRow | null);
				out.set(slug, {
					trust: trustRow === null || trustRow.attempts === 0 ? null : toTrust(slug, trustRow, feedbackFor(slug, harnessId, cutoff, task), cfg.filters.feedbackWeight),
					latency: latencyRow === null ? null : toLatency(slug, latencyRow),
				});
			}
			return out;
		},

		cacheReliability(slug: string): ModelCacheReliability | null {
			const now = Date.now();
			if (cacheMemo === null || now - cacheMemo.atMs > CACHE_RELIABILITY_MEMO_MS) {
				const map = new Map<string, ModelCacheReliability>();
				for (const r of queryCacheReliability(db, { warmTtlMs: cfg.hysteresis.cacheWarmTtlMs })) {
					map.set(r.slug, { slug: r.slug, samples: r.samples, hitRate: Math.min(1, Math.max(0, r.hit)) });
				}
				cacheMemo = { atMs: now, map };
			}
			return cacheMemo.map.get(slug) ?? null;
		},

		escalationCost(windowDays: number): EscalationCost | null {
			const now = Date.now();
			if (escalationMemo !== null && escalationMemo.windowDays === windowDays && now - escalationMemo.atMs < ESCALATION_COST_MEMO_MS) {
				return escalationMemo.value;
			}
			const row = escalationCostStmt.get(now - windowDays * DAY_MS) as { samples: number; usd: number; prompt_tokens: number } | null;
			const value: EscalationCost | null =
				row === null || row.samples < MIN_ESCALATION_SAMPLES || row.prompt_tokens <= 0
					? null
					: { usdPerPromptToken: row.usd / row.prompt_tokens, samples: row.samples, windowDays };
			escalationMemo = { atMs: now, windowDays, value };
			return value;
		},

		tokenRatio(tokenizer: string): number | null {
			const row = ratioStmt.get(tokenizer.trim().toLowerCase()) as CalibrationRow | null;
			if (row === null || row.samples < MIN_CALIBRATION_SAMPLES || row.actual_tokens <= 0) return null;
			return row.est_bytes / row.actual_tokens;
		},

		recentEntries(limit: number): LedgerEntry[] {
			const rows = recentStmt.all(limit) as LedgerRow[];
			return rows.map(toEntry);
		},
		softFailureSpikes(nowMs = Date.now(), recentMs = SPIKE_RECENT_MS, baselineMs = SPIKE_BASELINE_MS): SoftFailureSpike[] {
			const rows = softFailureStmt.all({ $now: nowMs, $recentStart: nowMs - recentMs, $baselineStart: nowMs - recentMs - baselineMs }) as {
				slug: string;
				recent_n: number;
				recent_f: number;
				base_n: number;
				base_f: number;
			}[];
			const spikes: SoftFailureSpike[] = [];
			for (const r of rows) {
				if (r.recent_n < SPIKE_MIN_DISPATCHES || r.recent_f < SPIKE_MIN_FAILURES) continue;
				const recentRate = r.recent_f / r.recent_n;
				const baselineRate = r.base_n > 0 ? r.base_f / r.base_n : 0;
				if (recentRate < SPIKE_MIN_RATE || recentRate < SPIKE_RATIO * baselineRate) continue;
				spikes.push({
					slug: r.slug,
					recentDispatches: r.recent_n,
					recentFailures: r.recent_f,
					recentRate,
					baselineDispatches: r.base_n,
					baselineFailures: r.base_f,
					baselineRate,
				});
			}
			spikes.sort((a, b) => b.recentRate - a.recentRate || b.recentFailures - a.recentFailures);
			return spikes;
		},
		providerSpendSince(slugPrefix: string, sinceMs: number): number {
			const row = providerSpendStmt.get(sinceMs, `${slugPrefix}%`) as { total: number } | null;
			return row?.total ?? 0;
		},
		prune(retentionDays: number | null, nowMs = Date.now()): PruneResult {
			const oldestKeptMs = (): number | null => (oldestStmt.get() as { oldest: number | null } | null)?.oldest ?? null;
			// null and 0 are the same instruction: keep everything. Still reports
			// how far back the ledger goes, which is what the caller asked.
			if (retentionDays === null || retentionDays <= 0) return { deleted: 0, oldestKeptMs: oldestKeptMs() };
			const cutoff = nowMs - retentionDays * DAY_MS;
			// Dependants first: the feedback statement reads the rows being deleted.
			pruneFeedbackStmt.run(cutoff, cutoff);
			pruneMeterStmt.run(cutoff);
			const deleted = pruneStmt.run(cutoff).changes;
			// Hand the freed pages back where the engine can (a ledger created at
			// v0.21.0 or later is auto_vacuum=INCREMENTAL; an older file reuses
			// them instead), then fold the WAL back so the space is real on disk.
			// Best-effort by design: a full ledger that could not shrink is a far
			// smaller problem than a prune that throws.
			if (deleted > 0) {
				try {
					db.exec("PRAGMA incremental_vacuum");
					db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
				} catch {
					/* freed pages stay in the file, to be reused by later rows */
				}
			}
			return { deleted, oldestKeptMs: oldestKeptMs() };
		},
		markWasted(id: string): void {
			wasteStmt.run(id);
		},
		latestForSession(ompSessionId: string): LedgerEntry | null {
			if (ompSessionId === "") return null;
			const row = sessionStmt.get(ompSessionId, 1) as LedgerRow | null;
			return row === null ? null : toEntry(row);
		},
		entriesForSession(ompSessionId: string, limit: number): LedgerEntry[] {
			if (ompSessionId === "") return [];
			return (sessionStmt.all(ompSessionId, Math.max(1, limit)) as LedgerRow[]).map(toEntry);
		},
	};
}
