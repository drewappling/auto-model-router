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
import type { BlendedRate, Ledger, LedgerEntry, ModelLatency, ModelTrust, UsageCounts } from "./types.ts";

/** Estimates below this many samples are noise; the default ratio is better. */
const MIN_CALIBRATION_SAMPLES = 20;

// Row shapes below are fixed by our own schema in util/sqlite.ts.
interface LedgerRow {
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
}

interface TrustRow {
	attempts: number;
	escalations: number;
	errors: number;
	failures: number;
	mean_cost_error: number | null;
}

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
const UNATTRIBUTABLE_KINDS = "('aborted', 'auth', 'moderation', 'model_unavailable')";

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

function toTrust(slug: string, row: TrustRow): ModelTrust {
	// Laplace smoothing: an untried model scores a neutral 1/2, and a failure
	// is an attempt superseded by an escalation or ended in an upstream error.
	return {
		slug,
		attempts: row.attempts,
		escalations: row.escalations,
		errors: row.errors,
		successRate: (row.attempts - row.failures + 1) / (row.attempts + 2),
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

function toEntry(row: LedgerRow): LedgerEntry {
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
	};
}

export function createLedger(db: Database, cfg: RouterConfig): Ledger {
	// Prepared once: record() runs on every turn.
	const insertStmt = db.query(
		`INSERT INTO ledger (
			id, created_at_ms, conversation_key, session_id, turn, requested_model, harness_id, omp_session_id, slug, served_slug,
			tier, classification_source, reasons, predicted_usd, reported_usd, usage, cost_breakdown,
			attempt, escalation_signal, latency_ms, ttft_ms, finish_reason, wasted, upstream_generation_id, error,
			error_kind, features, score, confidence, task, classifier_reasons, explored_from, hold_arm, prompt_tokens_saved
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
	const trustStmt = db.query(`SELECT ${TRUST_SELECT} FROM ledger WHERE slug = ?`);
	const trustHarnessStmt = db.query(`SELECT ${TRUST_SELECT} FROM ledger WHERE slug = ? AND harness_id = ?`);
	const allTrustStmt = db.query(`SELECT slug, ${TRUST_SELECT} FROM ledger GROUP BY slug`);
	const latencyStmt = db.query(`SELECT ${LATENCY_SELECT} FROM ledger WHERE slug = ?`);
	const latencyHarnessStmt = db.query(`SELECT ${LATENCY_SELECT} FROM ledger WHERE slug = ? AND harness_id = ?`);
	const ratioStmt = db.query("SELECT est_bytes, actual_tokens, samples FROM token_calibration WHERE tokenizer = ?");
	const recentStmt = db.query("SELECT * FROM ledger ORDER BY created_at_ms DESC LIMIT ?");
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
			const model = (entry.servedSlug !== null ? models?.get(entry.servedSlug) : undefined) ?? models?.get(entry.slug) ?? null;
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
			);
			// Always consume the pending estimate, even when the turn failed, so a
			// dead turn's bytes can never pair with a later turn's tokens. Only
			// actually-billed prompt tokens calibrate.
			const pending = consumePendingEstimate(entry.conversationKey);
			if (entry.usage.promptTokens > 0 && pending !== null) {
				// The SERVED model's tokenizer produced the billing; the estimate-time
				// family is the fallback when the model is unknown to the catalog.
				const tokenizer = (model?.tokenizer ?? pending.tokenizer).trim().toLowerCase();
				calibrationStmt.run(tokenizer, pending.bytes, entry.usage.promptTokens);
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

		trust(slug: string, harnessId?: string): ModelTrust | null {
			const row =
				harnessId !== undefined && harnessId !== ""
					? (trustHarnessStmt.get(slug, harnessId) as TrustRow | null)
					: (trustStmt.get(slug) as TrustRow | null);
			if (row === null || row.attempts === 0) return null;
			return toTrust(slug, row);
		},

		allTrust(): ModelTrust[] {
			const rows = allTrustStmt.all() as (TrustRow & { slug: string })[];
			return rows.map((row) => toTrust(row.slug, row));
		},

		latency(slug: string, harnessId?: string): ModelLatency | null {
			const row =
				harnessId !== undefined && harnessId !== ""
					? (latencyHarnessStmt.get(slug, harnessId) as LatencyRow | null)
					: (latencyStmt.get(slug) as LatencyRow | null);
			if (row === null) return null;
			return toLatency(slug, row);
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
	};
}
