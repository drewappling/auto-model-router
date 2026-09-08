/**
 * Ledger views that a front door (the team edition, a dashboard, a script)
 * needs at a scope the report does not offer: spend since an instant over a
 * set of harnesses, feedback verdicts with the harness that gave them, and a
 * cost export by day, harness and model. Served by `/v1/router/spend`,
 * `GET /v1/router/feedback` and `/v1/router/export`, exported from lib.ts, and
 * behind `auto-model-router export`. All of them read only long-stable ledger
 * columns and accept a read-only database handle.
 */

import type { Database } from "bun:sqlite";
import { harnessFilter } from "./report.ts";

/** `null` means every harness; an empty set matches nothing. */
export type HarnessScope = readonly string[] | null;

export interface FeedbackRow {
	atMs: number;
	slug: string;
	tier: string;
	verdict: "good" | "bad";
	note: string;
	/** The harness id of the judged turn (a team user id), or empty. */
	harnessId: string;
}

export interface FeedbackByModel {
	slug: string;
	good: number;
	bad: number;
	/** Distinct harness ids that judged this model. */
	judges: number;
}

export interface FeedbackView {
	byModel: FeedbackByModel[];
	recent: FeedbackRow[];
}

export interface ExportRow {
	day: string;
	harnessId: string;
	slug: string;
	provider: string;
	dispatches: number;
	promptTokens: number;
	cachedTokens: number;
	completionTokens: number;
	spendUsd: number;
	escalations: number;
	errors: number;
}

const USD = "COALESCE(reported_usd, predicted_usd)";

function scope(harness: HarnessScope, column: string): { sql: string[]; bind: Record<string, string> } | null {
	if (harness === null) return { sql: [], bind: {} };
	if (harness.length === 0) return null;
	const f = harnessFilter(harness.join(","));
	return { sql: f.sql.map((s) => s.replace(/^harness_id/, column)), bind: f.bind };
}

/** Spend (reported where present, predicted otherwise) since `sinceMs`, digest calls included as the ledger counts them. */
export function spendUsdSince(db: Database, sinceMs: number, harness: HarnessScope): number {
	const s = scope(harness, "harness_id");
	if (s === null) return 0;
	const where = ["created_at_ms >= $since", ...s.sql].join(" AND ");
	const row = db.query(`SELECT COALESCE(SUM(${USD}), 0) AS usd FROM ledger WHERE ${where}`).get({ $since: sinceMs, ...s.bind }) as { usd: number };
	return row.usd;
}

/** Verdicts since `sinceMs`, by model and the most recent 200, joined to the ledger for the judging harness. */
export function feedbackView(db: Database, sinceMs: number, harness: HarnessScope): FeedbackView {
	const exists = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'feedback'").get() as { name: string } | null) !== null;
	if (!exists) return { byModel: [], recent: [] };
	const s = scope(harness, "l.harness_id");
	if (s === null) return { byModel: [], recent: [] };
	const where = ["f.created_at_ms >= $since", ...s.sql].join(" AND ");
	const bind = { $since: sinceMs, ...s.bind };
	const recent = (
		db.query(`SELECT f.created_at_ms AS at_ms, f.slug, f.tier, f.verdict, f.note, COALESCE(l.harness_id, '') AS harness_id FROM feedback f LEFT JOIN ledger l ON l.id = f.ledger_id WHERE ${where} ORDER BY f.created_at_ms DESC LIMIT 200`).all(bind) as {
			at_ms: number;
			slug: string;
			tier: string;
			verdict: string;
			note: string;
			harness_id: string;
		}[]
	).map((r) => ({ atMs: r.at_ms, slug: r.slug, tier: r.tier, verdict: (r.verdict === "good" ? "good" : "bad") as "good" | "bad", note: r.note, harnessId: r.harness_id }));
	const byModel = (
		db
			.query(
				`SELECT f.slug, SUM(CASE WHEN f.verdict = 'good' THEN 1 ELSE 0 END) AS good, SUM(CASE WHEN f.verdict = 'bad' THEN 1 ELSE 0 END) AS bad, COUNT(DISTINCT COALESCE(l.harness_id, '')) AS judges
				 FROM feedback f LEFT JOIN ledger l ON l.id = f.ledger_id WHERE ${where} GROUP BY f.slug ORDER BY bad DESC, good DESC, f.slug ASC`,
			)
			.all(bind) as { slug: string; good: number; bad: number; judges: number }[]
	).map((r) => ({ slug: r.slug, good: r.good, bad: r.bad, judges: r.judges }));
	return { byModel, recent };
}

/** One row per UTC day, harness and served model since `sinceMs`; digest calls are excluded as in the report. */
export function exportRows(db: Database, sinceMs: number, harness: HarnessScope): ExportRow[] {
	const s = scope(harness, "harness_id");
	if (s === null) return [];
	const where = ["created_at_ms >= $since", "requested_model <> 'digest'", ...s.sql].join(" AND ");
	const rows = db
		.query(
			`SELECT strftime('%Y-%m-%d', created_at_ms / 1000, 'unixepoch') AS day, harness_id, COALESCE(served_slug, slug) AS slug,
				COUNT(*) AS dispatches,
				COALESCE(SUM(json_extract(usage, '$.promptTokens')), 0) AS prompt_tokens,
				COALESCE(SUM(json_extract(usage, '$.cachedTokens')), 0) AS cached_tokens,
				COALESCE(SUM(json_extract(usage, '$.completionTokens')), 0) AS completion_tokens,
				COALESCE(SUM(${USD}), 0) AS spend,
				SUM(CASE WHEN escalation_signal IS NOT NULL THEN 1 ELSE 0 END) AS escalations,
				SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
			 FROM ledger WHERE ${where} GROUP BY day, harness_id, slug ORDER BY day ASC, harness_id ASC, spend DESC`,
		)
		.all({ $since: sinceMs, ...s.bind }) as { day: string; harness_id: string; slug: string; dispatches: number; prompt_tokens: number; cached_tokens: number; completion_tokens: number; spend: number; escalations: number; errors: number }[];
	return rows.map((r) => ({
		day: r.day,
		harnessId: r.harness_id,
		slug: r.slug,
		provider: r.slug.startsWith("ollama/") ? "ollama" : "openrouter",
		dispatches: r.dispatches,
		promptTokens: r.prompt_tokens,
		cachedTokens: r.cached_tokens,
		completionTokens: r.completion_tokens,
		spendUsd: r.spend,
		escalations: r.escalations,
		errors: r.errors,
	}));
}

export const EXPORT_COLUMNS = ["day", "harness", "model", "provider", "dispatches", "prompt_tokens", "cached_tokens", "completion_tokens", "spend_usd", "escalations", "errors"] as const;

export function csvCell(v: string | number): string {
	const s = String(v);
	return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** CSV of export rows; spend to 6 decimals so sub-cent rows survive. */
export function exportCsv(rows: readonly ExportRow[]): string {
	const lines = [EXPORT_COLUMNS.join(",")];
	for (const r of rows) lines.push([r.day, r.harnessId, r.slug, r.provider, r.dispatches, r.promptTokens, r.cachedTokens, r.completionTokens, r.spendUsd.toFixed(6), r.escalations, r.errors].map(csvCell).join(","));
	return `${lines.join("\n")}\n`;
}

/** `?harness=a,b` → scope; absent or empty → everything. */
export function harnessScopeParam(raw: string | null): HarnessScope {
	if (raw === null) return null;
	const ids = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
	return ids.length === 0 ? null : ids;
}
