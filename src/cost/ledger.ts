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
import type { BlendedRate, Ledger, LedgerEntry, ModelTrust, UsageCounts } from "./types.ts";

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
	slug: string;
	served_slug: string | null;
	tier: string;
	classification_source: string;
	reasons: string;
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
}

interface TrustRow {
	attempts: number;
	escalations: number;
	errors: number;
	failures: number;
	mean_cost_error: number | null;
}

interface CalibrationRow {
	est_bytes: number;
	actual_tokens: number;
	samples: number;
}

const TRUST_SELECT = `COUNT(*) AS attempts,
		COALESCE(SUM(CASE WHEN escalation_signal IS NOT NULL THEN 1 ELSE 0 END), 0) AS escalations,
		COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END), 0) AS errors,
		COALESCE(SUM(CASE WHEN escalation_signal IS NOT NULL OR error IS NOT NULL THEN 1 ELSE 0 END), 0) AS failures,
		AVG(CASE WHEN reported_usd IS NOT NULL AND reported_usd > 0
			THEN ABS(reported_usd - predicted_usd) / reported_usd END) AS mean_cost_error`;

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

function toEntry(row: LedgerRow): LedgerEntry {
	return {
		id: row.id,
		createdAtMs: row.created_at_ms,
		conversationKey: row.conversation_key,
		sessionId: row.session_id,
		turn: row.turn,
		requestedModel: row.requested_model,
		slug: row.slug,
		servedSlug: row.served_slug,
		tier: row.tier,
		classificationSource: row.classification_source,
		reasons: JSON.parse(row.reasons) as string[],
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
	};
}

export function createLedger(db: Database, cfg: RouterConfig): Ledger {
	// Prepared once: record() runs on every turn.
	const insertStmt = db.query(
		`INSERT INTO ledger (
			id, created_at_ms, conversation_key, session_id, turn, requested_model, slug, served_slug,
			tier, classification_source, reasons, predicted_usd, reported_usd, usage, cost_breakdown,
			attempt, escalation_signal, latency_ms, ttft_ms, finish_reason, wasted, upstream_generation_id, error
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
	const trustStmt = db.query(`SELECT ${TRUST_SELECT} FROM ledger WHERE slug = ?`);
	const allTrustStmt = db.query(`SELECT slug, ${TRUST_SELECT} FROM ledger GROUP BY slug`);
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

		spendSince(sinceMs: number): number {
			const row = spendSinceStmt.get(sinceMs) as { total: number } | null;
			return row?.total ?? 0;
		},

		blendedRate(windowDays: number): BlendedRate | null {
			return computeBlendedRate(db, cfg, windowDays);
		},

		trust(slug: string): ModelTrust | null {
			const row = trustStmt.get(slug) as TrustRow | null;
			if (row === null || row.attempts === 0) return null;
			return toTrust(slug, row);
		},

		allTrust(): ModelTrust[] {
			const rows = allTrustStmt.all() as (TrustRow & { slug: string })[];
			return rows.map((row) => toTrust(row.slug, row));
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
