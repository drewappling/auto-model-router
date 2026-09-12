/**
 * Ledger views that a front door (the team edition, a dashboard, a script)
 * needs at a scope the report does not offer: spend since an instant over a
 * set of harnesses, feedback verdicts with the harness that gave them, and a
 * cost export by day, harness and model. Served by `/v1/router/spend`,
 * `GET /v1/router/feedback` and `/v1/router/export`, exported from lib.ts, and
 * behind `auto-model-router export`. All of them read only long-stable ledger
 * columns, and they run on either engine through `util/sql.ts`: a front door
 * may be reading a local file while the router writes a shared database.
 */

import { providerOfSlug } from "./report.ts";
import { num, type SqlDb } from "../util/sql.ts";
import { entriesOf } from "./ledger-sql.ts";
import { harnessFilter } from "./report.ts";
import type { LedgerEntry } from "./types.ts";

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
	/** The agentdox context scope the turns carried; "" for rows that carried none (every row before v18). */
	scope: string;
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

/** A ledger entry as the decision explorer shows it: the entry itself plus the verdicts given on it. */
export type DecisionEntry = LedgerEntry & { feedback: { verdict: "good" | "bad"; note: string; createdAtMs: number }[] };

export interface DecisionFilter {
	/** Entries at or after this instant; 0 for everything the ledger still holds. */
	sinceMs: number;
	/** The harness set; null for every harness, an empty list for none. */
	harness: HarnessScope;
	/** At most this many, newest first; 1..1000. */
	limit?: number;
	/** Only turns dispatched to (or served by) this slug. */
	slug?: string;
	/** Only turns classified at this tier. */
	tier?: string;
	/** Only one omp session (`/router why`). */
	ompSessionId?: string;
}

/**
 * Turns, newest first, over a harness set: what `GET /v1/router/decisions` serves and what a
 * front door reads from the ledger file. Every field the decision trail needs is here — the
 * reasons, the classifier's view, the cost forecast against the bill, the escalation signal —
 * and the verdicts `/router good|bad` recorded against each turn ride along.
 */
export async function decisionEntries(db: SqlDb, filter: DecisionFilter): Promise<DecisionEntry[]> {
	const s = scope(filter.harness, "harness_id");
	if (s === null) return [];
	const where = ["created_at_ms >= $since", ...s.sql];
	const bind: Record<string, string | number> = { $since: filter.sinceMs, ...s.bind };
	if (filter.slug !== undefined && filter.slug !== "") {
		where.push("(slug = $slug OR served_slug = $slug)");
		bind.$slug = filter.slug;
	}
	if (filter.tier !== undefined && filter.tier !== "") {
		where.push("tier = $tier");
		bind.$tier = filter.tier;
	}
	if (filter.ompSessionId !== undefined && filter.ompSessionId !== "") {
		where.push("omp_session_id = $session");
		bind.$session = filter.ompSessionId;
	}
	const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1_000);
	const rows = await db.query<unknown>(
		`SELECT * FROM ledger WHERE ${where.join(" AND ")} ORDER BY created_at_ms DESC LIMIT ${limit}`,
		bind,
	);
	const entries = entriesOf(rows);
	if (entries.length === 0) return [];
	// Verdicts, when the feedback table exists (it does not on a ledger no one has judged).
	const verdicts = new Map<string, DecisionEntry["feedback"]>();
	if (await db.tableExists("feedback")) {
		const ids = entries.map((e) => e.id);
		const marks = ids.map((_, i) => `$f${i}`).join(", ");
		const fb: Record<string, string> = {};
		ids.forEach((id, i) => (fb[`$f${i}`] = id));
		const rows = await db.query<{ ledger_id: string; verdict: string; note: string; created_at_ms: number }>(
			`SELECT ledger_id, verdict, note, created_at_ms FROM feedback WHERE ledger_id IN (${marks}) ORDER BY created_at_ms ASC`,
			fb,
		);
		for (const r of rows) {
			const list = verdicts.get(r.ledger_id) ?? [];
			list.push({ verdict: r.verdict === "good" ? "good" : "bad", note: r.note, createdAtMs: num(r.created_at_ms) });
			verdicts.set(r.ledger_id, list);
		}
	}
	return entries.map((e) => ({ ...e, feedback: verdicts.get(e.id) ?? [] }));
}

/**
 * Spend (reported where present, predicted otherwise) since `sinceMs`, digest calls included
 * as the ledger counts them. `contextScope`, when given, narrows to the turns that carried
 * exactly that agentdox scope — what a front door charges back to one project.
 */
export async function spendUsdSince(db: SqlDb, sinceMs: number, harness: HarnessScope, contextScope?: string): Promise<number> {
	const s = scope(harness, "harness_id");
	if (s === null) return 0;
	const where = ["created_at_ms >= $since", ...s.sql];
	const bind: Record<string, string | number> = { $since: sinceMs, ...s.bind };
	if (contextScope !== undefined && contextScope !== "") {
		where.push("scope = $scope");
		bind.$scope = contextScope;
	}
	const row = await db.one<{ usd: unknown }>(
		`SELECT COALESCE(SUM(${USD}), 0) AS usd FROM ledger WHERE ${where.join(" AND ")}`,
		bind,
	);
	return num(row?.usd);
}

/** Verdicts since `sinceMs`, by model and the most recent 200, joined to the ledger for the judging harness. */
export async function feedbackView(db: SqlDb, sinceMs: number, harness: HarnessScope): Promise<FeedbackView> {
	if (!(await db.tableExists("feedback"))) return { byModel: [], recent: [] };
	const s = scope(harness, "l.harness_id");
	if (s === null) return { byModel: [], recent: [] };
	const where = ["f.created_at_ms >= $since", ...s.sql].join(" AND ");
	const bind = { $since: sinceMs, ...s.bind };
	const recent = (
		await db.query<{ at_ms: number; slug: string; tier: string; verdict: string; note: string; harness_id: string }>(
			`SELECT f.created_at_ms AS at_ms, f.slug, f.tier, f.verdict, f.note, COALESCE(l.harness_id, '') AS harness_id
			 FROM feedback f LEFT JOIN ledger l ON l.id = f.ledger_id WHERE ${where} ORDER BY f.created_at_ms DESC LIMIT 200`,
			bind,
		)
	).map((r) => ({
		atMs: num(r.at_ms),
		slug: r.slug,
		tier: r.tier,
		verdict: (r.verdict === "good" ? "good" : "bad") as "good" | "bad",
		note: r.note,
		harnessId: r.harness_id,
	}));
	const byModel = (
		await db.query<{ slug: string; good: unknown; bad: unknown; judges: unknown }>(
			`SELECT f.slug, SUM(CASE WHEN f.verdict = 'good' THEN 1 ELSE 0 END) AS good, SUM(CASE WHEN f.verdict = 'bad' THEN 1 ELSE 0 END) AS bad,
				COUNT(DISTINCT COALESCE(l.harness_id, '')) AS judges
			 FROM feedback f LEFT JOIN ledger l ON l.id = f.ledger_id WHERE ${where} GROUP BY f.slug ORDER BY bad DESC, good DESC, f.slug ASC`,
			bind,
		)
	).map((r) => ({ slug: r.slug, good: num(r.good), bad: num(r.bad), judges: num(r.judges) }));
	return { byModel, recent };
}

/**
 * One row per UTC day, harness, served model and context scope since `sinceMs`; digest calls
 * are excluded as in the report. The scope splits a harness's day by project, so a front door
 * can charge each project its own share; rows from before v18 (and turns that carried no
 * scope) group under "".
 */
export async function exportRows(db: SqlDb, sinceMs: number, harness: HarnessScope): Promise<ExportRow[]> {
	const s = scope(harness, "harness_id");
	if (s === null) return [];
	const where = ["created_at_ms >= $since", "requested_model <> 'digest'", ...s.sql].join(" AND ");
	// GROUP BY names the day expression rather than its alias: Postgres does not
	// allow a select alias in GROUP BY, and repeating it keeps one statement for
	// both engines.
	const day = db.utcDay("created_at_ms");
	const rows = await db.query<{
		day: string;
		harness_id: string;
		slug: string;
		scope: string;
		dispatches: unknown;
		prompt_tokens: unknown;
		cached_tokens: unknown;
		completion_tokens: unknown;
		spend: unknown;
		escalations: unknown;
		errors: unknown;
	}>(
		`SELECT ${day} AS day, harness_id, COALESCE(served_slug, slug) AS slug, COALESCE(scope, '') AS scope,
				COUNT(*) AS dispatches,
				COALESCE(SUM(${db.jsonNum("usage", "promptTokens")}), 0) AS prompt_tokens,
				COALESCE(SUM(${db.jsonNum("usage", "cachedTokens")}), 0) AS cached_tokens,
				COALESCE(SUM(${db.jsonNum("usage", "completionTokens")}), 0) AS completion_tokens,
				COALESCE(SUM(${USD}), 0) AS spend,
				SUM(CASE WHEN escalation_signal IS NOT NULL THEN 1 ELSE 0 END) AS escalations,
				SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors
			 FROM ledger WHERE ${where}
			 GROUP BY ${day}, harness_id, COALESCE(served_slug, slug), COALESCE(scope, '')
			 ORDER BY 1 ASC, harness_id ASC, spend DESC`,
		{ $since: sinceMs, ...s.bind },
	);
	return rows.map((r) => ({
		day: r.day,
		harnessId: r.harness_id,
		slug: r.slug,
		scope: r.scope,
		provider: providerOfSlug(r.slug),
		dispatches: num(r.dispatches),
		promptTokens: num(r.prompt_tokens),
		cachedTokens: num(r.cached_tokens),
		completionTokens: num(r.completion_tokens),
		spendUsd: num(r.spend),
		escalations: num(r.escalations),
		errors: num(r.errors),
	}));
}

export const EXPORT_COLUMNS = ["day", "harness", "model", "provider", "dispatches", "prompt_tokens", "cached_tokens", "completion_tokens", "spend_usd", "escalations", "errors", "scope"] as const;

export function csvCell(v: string | number): string {
	const s = String(v);
	return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** CSV of export rows; spend to 6 decimals so sub-cent rows survive. */
export function exportCsv(rows: readonly ExportRow[]): string {
	const lines = [EXPORT_COLUMNS.join(",")];
	for (const r of rows) lines.push([r.day, r.harnessId, r.slug, r.provider, r.dispatches, r.promptTokens, r.cachedTokens, r.completionTokens, r.spendUsd.toFixed(6), r.escalations, r.errors, r.scope].map(csvCell).join(","));
	return `${lines.join("\n")}\n`;
}

/** `?harness=a,b` → scope; absent or empty → everything. */
export function harnessScopeParam(raw: string | null): HarnessScope {
	if (raw === null) return null;
	const ids = raw.split(",").map((s) => s.trim()).filter((s) => s !== "");
	return ids.length === 0 ? null : ids;
}
