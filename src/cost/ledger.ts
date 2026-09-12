/**
 * The ledger's shared vocabulary: the SQL fragments its aggregates are built
 * from, the thresholds those aggregates are judged against, and the mappers
 * that turn a stored row into the shapes the router consumes.
 *
 * `ledger-sql.ts` holds the one implementation, on either engine. This module
 * exists so the meaning of a term — what counts as an attributable error, when
 * a failure rate is a spike, how a row becomes a `LedgerEntry` — is written
 * once. Two copies of that is what this port set out to end: a divergent spike
 * threshold silently changed which models were reported as failing.
 */

import type { CostBreakdown, LedgerEntry, ModelLatency, ModelTrust, UsageCounts } from "./types.ts";

/** Estimates below this many samples are noise; the default ratio is better. */
export const MIN_CALIBRATION_SAMPLES = 20;
/** Calibration samples outside this bytes-per-token band are provider accounting quirks, not tokenizer facts. */
export const MIN_SANE_BYTES_PER_TOKEN = 1.5;
export const MAX_SANE_BYTES_PER_TOKEN = 8;
/**
 * Soft-failure spike detection (visibility only). A model is spiking when, over
 * the recent window, it has at least SPIKE_MIN_DISPATCHES dispatches, at least
 * SPIKE_MIN_FAILURES of them failed, its failure rate is at least
 * SPIKE_MIN_RATE, and that rate is at least SPIKE_RATIO × its own baseline
 * rate over the preceding window (a model with no baseline failures spikes on
 * the absolute floor alone).
 */
export const SPIKE_RECENT_MS = 60 * 60_000;
export const SPIKE_BASELINE_MS = 7 * 24 * 60 * 60_000;
export const SPIKE_MIN_DISPATCHES = 5;
export const SPIKE_MIN_FAILURES = 3;
export const SPIKE_MIN_RATE = 0.25;
export const SPIKE_RATIO = 2;
/** Escalated attempts needed before their measured cost is trusted. */
export const MIN_ESCALATION_SAMPLES = 10;
/** The escalation-cost aggregate scans a window of rows; memoised for this long. */
export const ESCALATION_COST_MEMO_MS = 60_000;

/**
 * Cache reliability is one window-function pass over the newest rows, memoised
 * for a minute: the previous kept turn of each conversation is found with LAG,
 * and a row counts when that turn was on the same model within the warm TTL.
 */
export const CACHE_RELIABILITY_ROWS = 6_000;
export const CACHE_RELIABILITY_MEMO_MS = 60_000;
export const DAY_MS = 86_400_000;

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
export const FEEDBACK_SELECT = `COALESCE(SUM(CASE WHEN f.verdict = 'good' THEN 1 ELSE 0 END), 0) AS good,
		COALESCE(SUM(CASE WHEN f.verdict = 'bad' THEN 1 ELSE 0 END), 0) AS bad`;

interface LatencyRow {
	samples: number;
	ttft_ms: number | null;
	ctok_sum: number | null;
	elapsed_ms_sum: number | null;
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

export const ATTRIBUTABLE_ERROR = `error IS NOT NULL AND (error_kind IS NULL OR error_kind NOT IN ${UNATTRIBUTABLE_KINDS})`;

export const TRUST_SELECT = `COUNT(*) AS attempts,
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
export const LATENCY_SELECT = `COUNT(CASE WHEN ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL THEN 1 END) AS samples,
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
export function errorKindOf(error: string | null): string | null {
	if (error === null) return null;
	if (error === "request aborted") return "aborted";
	const sep = error.indexOf(": ");
	if (sep <= 0) return null;
	return error.slice(0, sep);
}

export function toTrust(slug: string, row: TrustRow, fb: FeedbackRow | null = null, feedbackWeight = 0): ModelTrust {
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

export function toLatency(slug: string, row: LatencyRow): ModelLatency | null {
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
		// A row recorded before pricing, or one whose model could not be priced,
		// stores NULL; absent is the front door's cue to fall back to the blend.
		...(row.cost_breakdown === null || row.cost_breakdown === undefined ? {} : { costBreakdown: JSON.parse(row.cost_breakdown) as CostBreakdown }),
	};
}


