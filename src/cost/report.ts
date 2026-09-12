/**
 * Usage analytics over the ledger, for `/router report` in omp and the
 * `auto-model-router report` CLI (and `GET /v1/router/report`).
 *
 * Everything here is SQL over the `ledger` table the router already writes;
 * nothing is sampled or estimated beyond what the rows carry. Costs are the
 * ledger's own rule: reported when the provider gave one, else the
 * usage-priced figure the orchestrator computed, else the forecast.
 */

// `num` here is the local thousands formatter for the rendered report, so the
// coercion helpers are aliased rather than renamed at 40 call sites.
import { num as asNum, numOrNull as asNumOrNull, type SqlDb } from "../util/sql.ts";
import type { FeedbackCounts } from "./feedback.ts";

export interface ReportTotals {
	dispatches: number;
	conversations: number;
	spendUsd: number;
	/** Cached prompt tokens over all prompt tokens, 0-1. */
	cacheHitRate: number;
	promptTokens: number;
	completionTokens: number;
	escalations: number;
	failovers: number;
	errors: number;
	aborted: number;
	/** Turns that switched model mid-conversation. */
	modelSwitches: number;
	/** Any row in the window carries an estimated cache count. */
	cacheEstimated: boolean;
	/** Turns from omp subagents (`features.isSubagent`), and their spend. */
	subagentDispatches: number;
	subagentSpendUsd: number;
	/** Tool-result digests (requestedModel "digest"): count, what they cost, bytes they condensed. */
	digests: number;
	digestSpendUsd: number;
	digestInputTokens: number;
	/** Digests the agent went back on: the same tool re-run with the same primary argument afterwards (row marked wasted). */
	digestReruns: number;
	/**
	 * Strings redaction removed from outgoing requests in the window, and how
	 * many turns at least one was removed from — "N turns had something
	 * removed", which is the sentence an operator has to be able to say. Both 0
	 * when redaction is off, and rows written before v0.21.0 count as 0.
	 */
	redactions: number;
	redactedTurns: number;
	/** Forecast accuracy over clean kept rows with a reported cost: mean |predicted − reported| ÷ reported, and the share over-predicted. */
	forecastSamples: number;
	forecastMeanError: number;
	forecastOverShare: number;
}

export interface ReportRow {
	key: string;
	dispatches: number;
	spendUsd: number;
	/** Share of window spend, 0-1. */
	share: number;
	cacheHitRate: number;
	/** Some rows carry router-estimated cache counts (Ollama); the rate is then an estimate. */
	cacheEstimated: boolean;
	avgPromptTokens: number;
	/** Mean time to first token, ms, over streamed non-error rows; null without samples. */
	avgTtftMs: number | null;
	/** Completion tokens per second after first token; null without samples. */
	tokensPerSec: number | null;
	escalations: number;
	errors: number;
}

export interface ModelRow extends ReportRow {
	provider: string;
	/** Dispatch counts per tier, e.g. `{ trivial: 12, moderate: 3 }`. */
	tiers: Record<string, number>;
	/** User verdicts from /router good|bad on turns this model served, in the window. */
	feedback: FeedbackCounts;
}

export interface DayRow {
	/** UTC calendar day, `YYYY-MM-DD`. */
	day: string;
	dispatches: number;
	spendUsd: number;
	cacheHitRate: number;
}

export interface UsageReport {
	generatedAtMs: number;
	windowDays: number;
	sinceMs: number;
	/** Restricted to one harness when given; empty ⇒ all. */
	harnessId: string;
	totals: ReportTotals;
	providers: ReportRow[];
	models: ModelRow[];
	tiers: ReportRow[];
	days: DayRow[];
	/** Mean prompt composition over rows that recorded it; null when none did. */
	anatomy: AnatomyShare | null;
	/** What the window would have cost on one model throughout, per configured baseline. */
	baselines: BaselineRow[];
}

export interface BaselineRow {
	slug: string;
	usd: number;
	/** 1 − routed spend ÷ baseline spend; negative when the router cost more. */
	savedShare: number;
}

/** Resolves configured baseline slugs against a catalog lookup; unknown slugs are skipped. */
export function baselinePrices(slugs: readonly string[], find: (slug: string) => { price: { prompt: number; completion: number; cacheRead?: number } } | undefined): BaselinePrice[] {
	const out: BaselinePrice[] = [];
	for (const slug of slugs) {
		const m = find(slug);
		if (m === undefined) continue;
		out.push({ slug, prompt: m.price.prompt, completion: m.price.completion, ...(m.price.cacheRead === undefined ? {} : { cacheRead: m.price.cacheRead }) });
	}
	return out;
}

/** A baseline's prices per token (the catalog's `Price`, or a subset of it). */
export interface BaselinePrice {
	slug: string;
	prompt: number;
	completion: number;
	cacheRead?: number;
}

/** Shares of prompt bytes, 0-1, averaged over the window's dispatches. */
export interface AnatomyShare {
	rows: number;
	avgMessages: number;
	system: number;
	user: number;
	assistant: number;
	tool: number;
	/** Tool schemas relative to prompt bytes (they ride in the tools param, not the messages). */
	schemas: number;
	olderHalf: number;
	staleTool: number;
}

const USD = "COALESCE(reported_usd, predicted_usd)";

/**
 * The usage members this report sums, spelled for the engine in front of it.
 * `json_extract` against `->>` is the whole difference, and getting the
 * BOOLEAN one wrong does not fail — it silently misclassifies every row.
 */
function fragments(db: SqlDb): { PT: string; CT: string; COMP: string; EST: string } {
	return {
		PT: db.jsonNum("usage", "promptTokens"),
		CT: db.jsonNum("usage", "cachedTokens"),
		COMP: db.jsonNum("usage", "completionTokens"),
		EST: `${db.jsonBool("usage", "cachedEstimated")} = 1`,
	};
}
/** Named upstream ids the ledger's provider derivation knows; set by createProviders from the live config. */
let knownUpstreamIds: () => readonly string[] = () => [];
/** Ids, or a getter read live so a hot-reloaded list applies; an embedder (the team edition) calls this too, since the registry is per process. */
export function setKnownUpstreamIds(ids: readonly string[] | (() => readonly string[])): void {
	const read = typeof ids === "function" ? ids : () => ids;
	knownUpstreamIds = () => read().filter((id) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(id));
}
export function knownUpstreams(): readonly string[] {
	return knownUpstreamIds();
}
/** The provider of a slug: its namespace when that names a known upstream, else OpenRouter's own. */
export function providerOfSlug(slug: string): string {
	if (slug.startsWith("ollama/")) return "ollama";
	const cut = slug.indexOf("/");
	if (cut > 0) {
		const head = slug.slice(0, cut);
		if (knownUpstreamIds().includes(head)) return head;
	}
	return "openrouter";
}
/** SQL twin of providerOfSlug; ids are validated to a slug alphabet so they can be inlined. */
function providerCase(): string {
	return `CASE WHEN slug LIKE 'ollama/%' THEN 'ollama' ${knownUpstreamIds().map((id) => `WHEN slug LIKE '${id}/%' THEN '${id}'`).join(" ")} ELSE 'openrouter' END`;
}
const STREAMED = "ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL";
/** Rows a forecast can be judged on: a reported cost, a prediction, clean and kept, not a side call. */
const FORECASTABLE = "reported_usd > 0 AND predicted_usd IS NOT NULL AND wasted = 0 AND error IS NULL AND requested_model <> 'digest'";

function rowSelect(db: SqlDb): string {
	const { PT, CT, COMP, EST } = fragments(db);
	return `
	COUNT(*) AS dispatches,
	COALESCE(SUM(${USD}), 0) AS spend,
	COALESCE(SUM(${PT}), 0) AS prompt_tokens,
	COALESCE(SUM(${CT}), 0) AS cached_tokens,
	SUM(CASE WHEN ${EST} THEN 1 ELSE 0 END) AS estimated_rows,
	COALESCE(AVG(${PT}), 0) AS avg_prompt_tokens,
	AVG(CASE WHEN ${STREAMED} THEN ttft_ms END) AS ttft_ms,
	SUM(CASE WHEN ${STREAMED} AND latency_ms > ttft_ms AND ${COMP} > 0 THEN ${COMP} END) AS ctok_sum,
	SUM(CASE WHEN ${STREAMED} AND latency_ms > ttft_ms AND ${COMP} > 0 THEN latency_ms - ttft_ms END) AS elapsed_ms,
	SUM(CASE WHEN escalation_signal IS NOT NULL THEN 1 ELSE 0 END) AS escalations,
	SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors`;
}

interface RawRow {
	key: string;
	dispatches: unknown;
	spend: unknown;
	prompt_tokens: unknown;
	cached_tokens: unknown;
	estimated_rows: unknown;
	avg_prompt_tokens: unknown;
	ttft_ms: unknown;
	ctok_sum: unknown;
	elapsed_ms: unknown;
	escalations: unknown;
	errors: unknown;
}

function toRow(raw: RawRow, windowSpend: number): ReportRow {
	// Every numeric field goes through `num`: Postgres returns COUNT(*) and
	// BIGINT sums as strings, and arithmetic on those is wrong rather than loud.
	const spend = asNum(raw.spend);
	const promptTokens = asNum(raw.prompt_tokens);
	const cachedTokens = asNum(raw.cached_tokens);
	const ttftMs = asNumOrNull(raw.ttft_ms);
	const elapsedMs = asNumOrNull(raw.elapsed_ms);
	const ctokSum = asNumOrNull(raw.ctok_sum);
	return {
		key: raw.key,
		dispatches: asNum(raw.dispatches),
		spendUsd: spend,
		share: windowSpend > 0 ? spend / windowSpend : 0,
		cacheHitRate: promptTokens > 0 ? cachedTokens / promptTokens : 0,
		cacheEstimated: asNum(raw.estimated_rows) > 0,
		avgPromptTokens: Math.round(asNum(raw.avg_prompt_tokens)),
		avgTtftMs: ttftMs === null ? null : Math.round(ttftMs),
		tokensPerSec: elapsedMs !== null && elapsedMs > 0 && ctokSum !== null ? (ctokSum * 1000) / elapsedMs : null,
		escalations: asNum(raw.escalations),
		errors: asNum(raw.errors),
	};
}

/** A harness filter: one id, or several comma-separated (a team's members); empty ⇒ everything. */
export function harnessFilter(harnessId: string, param = "$harness"): { sql: string[]; bind: Record<string, string> } {
	const ids = harnessId.split(",").map((s) => s.trim()).filter((s) => s !== "");
	if (ids.length === 0) return { sql: [], bind: {} };
	if (ids.length === 1) return { sql: [`harness_id = ${param}`], bind: { [param]: ids[0]! } };
	const bind: Record<string, string> = {};
	ids.forEach((id, i) => (bind[`${param}${i}`] = id));
	return { sql: [`harness_id IN (${ids.map((_, i) => `${param}${i}`).join(", ")})`], bind };
}

/**
 * Verdict counts per model, scoped to the judging harness.
 *
 * Read here rather than through `createFeedbackStore`, which still owns the
 * WRITE path on a bun:sqlite handle: the report only ever counted, and a
 * second engine would otherwise need the whole store ported to read two
 * columns. A ledger nobody has judged has no table at all.
 */
async function feedbackCounts(db: SqlDb, sinceMs: number, harnessId: string): Promise<Map<string, FeedbackCounts>> {
	const out = new Map<string, FeedbackCounts>();
	if (!(await db.tableExists("feedback"))) return out;
	const hf = harnessFilter(harnessId, "$fh");
	const where = ["f.created_at_ms >= $since", ...hf.sql.map((s) => s.replace(/^harness_id/, "l.harness_id"))].join(" AND ");
	const rows = await db.query<{ slug: string; good: unknown; bad: unknown }>(
		`SELECT f.slug,
			COALESCE(SUM(CASE WHEN f.verdict = 'good' THEN 1 ELSE 0 END), 0) AS good,
			COALESCE(SUM(CASE WHEN f.verdict = 'bad' THEN 1 ELSE 0 END), 0) AS bad
		 FROM feedback f LEFT JOIN ledger l ON l.id = f.ledger_id
		 WHERE ${where} GROUP BY f.slug`,
		{ $since: sinceMs, ...hf.bind },
	);
	for (const row of rows) out.set(row.slug, { good: asNum(row.good), bad: asNum(row.bad) });
	return out;
}

/**
 * Builds the report for the last `windowDays`. `harnessId` narrows to one
 * harness (the `X-Omp-Harness` header) or a comma-separated set of them (a
 * team edition group); empty means everything.
 */
export async function buildUsageReport(
	db: SqlDb,
	opts: { windowDays: number; harnessId?: string; nowMs?: number; baselines?: readonly BaselinePrice[]; /** Exclusive upper bound; default open-ended. */ untilMs?: number },
): Promise<UsageReport> {
	const { PT, CT, COMP, EST } = fragments(db);
	const ROW_SELECT = rowSelect(db);
	// A JSON BOOLEAN, like usage.cachedEstimated: the engines disagree on both
	// the accessor and the value's type.
	const subagent = `${db.jsonBool("features", "isSubagent")} = 1`;
	const nowMs = opts.nowMs ?? Date.now();
	const windowDays = Math.max(1, opts.windowDays);
	const sinceMs = nowMs - windowDays * 86_400_000;
	const harnessId = opts.harnessId ?? "";
	const untilMs = opts.untilMs;
	const hf = harnessFilter(harnessId);
	const where = ["created_at_ms >= $since", ...(untilMs === undefined ? [] : ["created_at_ms < $until"]), ...hf.sql].join(" AND ");
	const bind = { $since: sinceMs, ...(untilMs === undefined ? {} : { $until: untilMs }), ...hf.bind };

	const t = (await db.one<Record<string, unknown>>(
		`SELECT COUNT(*) AS dispatches,
				COUNT(DISTINCT conversation_key) AS conversations,
				COALESCE(SUM(${USD}), 0) AS spend,
				COALESCE(SUM(${PT}), 0) AS prompt_tokens,
				COALESCE(SUM(${CT}), 0) AS cached_tokens,
				COALESCE(SUM(${COMP}), 0) AS completion_tokens,
				SUM(CASE WHEN ${EST} THEN 1 ELSE 0 END) AS estimated_rows,
				SUM(CASE WHEN ${subagent} THEN 1 ELSE 0 END) AS subagent_rows,
				COALESCE(SUM(CASE WHEN ${subagent} THEN ${USD} ELSE 0 END), 0) AS subagent_spend,
				SUM(CASE WHEN requested_model = 'digest' THEN 1 ELSE 0 END) AS digests,
				COALESCE(SUM(CASE WHEN requested_model = 'digest' THEN ${USD} ELSE 0 END), 0) AS digest_spend,
				COALESCE(SUM(CASE WHEN requested_model = 'digest' THEN ${PT} ELSE 0 END), 0) AS digest_input,
				SUM(CASE WHEN requested_model = 'digest' AND wasted = 1 THEN 1 ELSE 0 END) AS digest_reruns,
				COALESCE(SUM(redactions), 0) AS redactions,
				SUM(CASE WHEN redactions > 0 THEN 1 ELSE 0 END) AS redacted_rows,
				SUM(CASE WHEN ${FORECASTABLE} THEN 1 ELSE 0 END) AS fc_n,
				COALESCE(SUM(CASE WHEN ${FORECASTABLE} THEN ABS(predicted_usd - reported_usd) / reported_usd END), 0) AS fc_err,
				SUM(CASE WHEN ${FORECASTABLE} AND predicted_usd > reported_usd THEN 1 ELSE 0 END) AS fc_over,
				SUM(CASE WHEN escalation_signal IS NOT NULL THEN 1 ELSE 0 END) AS escalations,
				SUM(CASE WHEN ${db.contains("reasons", "'failover:'")} THEN 1 ELSE 0 END) AS failovers,
				SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
				SUM(CASE WHEN error = 'request aborted' THEN 1 ELSE 0 END) AS aborted
			 FROM ledger WHERE ${where}`,
		bind,
	)) as unknown as {
		[key: string]: unknown;
	};

	// Model switches: consecutive non-wasted rows of one conversation on
	// different slugs. Computed in JS over a slim projection; the window is
	// bounded, and SQLite window functions would make the query less portable.
	const seq = await db.query<{ ck: string; slug: string }>(
		`SELECT conversation_key AS ck, slug FROM ledger WHERE ${where} AND wasted = 0 ORDER BY conversation_key, created_at_ms`,
		bind,
	);
	let switches = 0;
	for (let i = 1; i < seq.length; i++) {
		const a = seq[i - 1]!;
		const b = seq[i]!;
		if (a.ck === b.ck && a.slug !== b.slug) switches++;
	}

	const windowSpend = asNum(t.spend);
	// GROUP BY repeats the expression rather than the alias: Postgres does not
	// accept a select alias there.
	const providers = (
		await db.query<RawRow>(
			`SELECT ${providerCase()} AS key, ${ROW_SELECT} FROM ledger WHERE ${where} GROUP BY ${providerCase()} ORDER BY spend DESC`,
			bind,
		)
	).map((r) => toRow(r, windowSpend));

	const modelRows = await db.query<RawRow>(
		`SELECT COALESCE(served_slug, slug) AS key, ${ROW_SELECT} FROM ledger WHERE ${where} GROUP BY COALESCE(served_slug, slug) ORDER BY spend DESC`,
		bind,
	);
	const tierMix = await db.query<{ key: string; tier: string; n: unknown }>(
		`SELECT COALESCE(served_slug, slug) AS key, tier, COUNT(*) AS n FROM ledger WHERE ${where} GROUP BY COALESCE(served_slug, slug), tier`,
		bind,
	);
	const mixByModel = new Map<string, Record<string, number>>();
	for (const m of tierMix) {
		const rec = mixByModel.get(m.key) ?? {};
		rec[m.tier] = asNum(m.n);
		mixByModel.set(m.key, rec);
	}
	const feedbackBySlug = await feedbackCounts(db, sinceMs, harnessId);
	const models: ModelRow[] = modelRows.map((r) => ({
		...toRow(r, windowSpend),
		// `providerOfSlug`, not a two-way guess: a named upstream's namespace is a provider
		// too. Hardcoding ollama-or-openrouter reported every subscription and direct-provider
		// turn as OpenRouter — 87 Opus dispatches filed against a provider that never saw them.
		provider: providerOfSlug(r.key),
		tiers: mixByModel.get(r.key) ?? {},
		feedback: feedbackBySlug.get(r.key) ?? { good: 0, bad: 0 },
	}));

	const tiers = (
		await db.query<RawRow>(`SELECT tier AS key, ${ROW_SELECT} FROM ledger WHERE ${where} GROUP BY tier ORDER BY spend DESC`, bind)
	).map((r) => toRow(r, windowSpend));

	const dayExpr = db.utcDay("created_at_ms");
	const days = (
		await db.query<{ day: string; dispatches: unknown; spend: unknown; prompt_tokens: unknown; cached_tokens: unknown }>(
			`SELECT ${dayExpr} AS day, COUNT(*) AS dispatches, COALESCE(SUM(${USD}), 0) AS spend,
					COALESCE(SUM(${PT}), 0) AS prompt_tokens, COALESCE(SUM(${CT}), 0) AS cached_tokens
				 FROM ledger WHERE ${where} GROUP BY ${dayExpr} ORDER BY 1`,
			bind,
		)
	).map((d) => {
		const promptTokens = asNum(d.prompt_tokens);
		return {
			day: d.day,
			dispatches: asNum(d.dispatches),
			spendUsd: asNum(d.spend),
			cacheHitRate: promptTokens > 0 ? asNum(d.cached_tokens) / promptTokens : 0,
		};
	});

	const anat = (key: string): string => db.jsonPathNum("features", ["anatomy", key]);
	const an = (await db.one<Record<string, unknown>>(
		`SELECT COUNT(*) AS rows, AVG(${anat("messages")}) AS msgs,
				AVG(${anat("systemBytes")}) AS sys, AVG(${anat("userBytes")}) AS usr,
				AVG(${anat("assistantBytes")}) AS asst, AVG(${anat("toolBytes")}) AS tool,
				AVG(${db.jsonNum("features", "toolSchemaBytes")}) AS schemas,
				AVG(${anat("olderHalfBytes")}) AS older, AVG(${anat("staleToolBytes")}) AS stale
			 FROM ledger WHERE ${where} AND ${anat("messages")} IS NOT NULL`,
		bind,
	)) ?? {};
	let anatomy: AnatomyShare | null = null;
	if (asNum(an.rows) > 0) {
		const total = asNum(an.sys) + asNum(an.usr) + asNum(an.asst) + asNum(an.tool);
		const share = (v: unknown): number => (total > 0 ? asNum(v) / total : 0);
		anatomy = {
			rows: asNum(an.rows),
			avgMessages: Math.round(asNum(an.msgs)),
			system: share(an.sys),
			user: share(an.usr),
			assistant: share(an.asst),
			tool: share(an.tool),
			schemas: share(an.schemas),
			olderHalf: share(an.older),
			staleTool: share(an.stale),
		};
	}

	// Counterfactual: the window's tokens on one model throughout, at list
	// price with the window's own cache hit rate (cached tokens read at the
	// baseline's cache rate, or full price when it publishes none).
	const baselines: BaselineRow[] = (opts.baselines ?? []).map((b) => {
		const fresh = Math.max(0, asNum(t.prompt_tokens) - asNum(t.cached_tokens));
		const usd = fresh * b.prompt + asNum(t.cached_tokens) * (b.cacheRead ?? b.prompt) + asNum(t.completion_tokens) * b.completion;
		return { slug: b.slug, usd, savedShare: usd > 0 ? 1 - windowSpend / usd : 0 };
	});

	return {
		generatedAtMs: nowMs,
		windowDays,
		sinceMs,
		harnessId,
		totals: {
			dispatches: asNum(t.dispatches),
			conversations: asNum(t.conversations),
			spendUsd: windowSpend,
			cacheHitRate: asNum(t.prompt_tokens) > 0 ? asNum(t.cached_tokens) / asNum(t.prompt_tokens) : 0,
			promptTokens: asNum(t.prompt_tokens),
			completionTokens: asNum(t.completion_tokens),
			escalations: asNum(t.escalations),
			failovers: asNum(t.failovers),
			errors: asNum(t.errors),
			aborted: asNum(t.aborted),
			modelSwitches: switches,
			cacheEstimated: asNum(t.estimated_rows) > 0,
			subagentDispatches: asNum(t.subagent_rows),
			subagentSpendUsd: asNum(t.subagent_spend),
			digests: asNum(t.digests),
			digestSpendUsd: asNum(t.digest_spend),
			digestInputTokens: asNum(t.digest_input),
			digestReruns: asNum(t.digest_reruns),
			redactions: asNum(t.redactions),
			redactedTurns: asNum(t.redacted_rows),
			forecastSamples: asNum(t.fc_n),
			forecastMeanError: asNum(t.fc_n) > 0 ? asNum(t.fc_err) / asNum(t.fc_n) : 0,
			forecastOverShare: asNum(t.fc_n) > 0 ? asNum(t.fc_over) / asNum(t.fc_n) : 0,
		},
		providers,
		models,
		tiers,
		days,
		anatomy,
		baselines,
	};
}

// ---------------------------------------------------------------------------
// Rendering (shared by the omp command and the CLI)
// ---------------------------------------------------------------------------

const usd = (v: number): string => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);
const pct = (v: number, estimated = false): string => `${estimated ? "~" : ""}${(v * 100).toFixed(0)}%`;
const num = (v: number): string => v.toLocaleString("en-US");
const ms = (v: number | null): string => (v === null ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`);
const tps = (v: number | null): string => (v === null ? "–" : `${v.toFixed(0)} tok/s`);

/** One aligned table of a report: header row, then data rows. */
export interface ReportTable {
	/** Stable id: `providers` | `models` | `tiers` | `days`. */
	id: string;
	title: string;
	headers: string[];
	rows: string[][];
}

/** Everything a renderer needs, already formatted: summary lines and tables. */
export interface ReportView {
	/** `last 7d · harness omp · 2026-09-06 14:18Z`. */
	heading: string;
	summary: string[];
	tables: ReportTable[];
}

/**
 * Column-aligns a table into fixed-width lines: header, rule, rows. The first
 * column is left-aligned, the rest right-aligned. Cells are plain text, so
 * the caller can style whole lines without breaking the alignment.
 */
export function formatTable(headers: string[], rows: string[][]): string[] {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	const line = (cells: string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ");
	return [line(headers), line(widths.map((w) => "-".repeat(w))), ...rows.map(line)];
}

/** Formats a report into summary lines and tables, shared by every renderer. */
export function reportView(r: UsageReport, opts: { maxModels?: number } = {}): ReportView {
	const maxModels = opts.maxModels ?? 12;
	const t = r.totals;
	const heading = `last ${r.windowDays}d${r.harnessId === "" ? "" : ` · harness ${r.harnessId}`} · ${new Date(r.generatedAtMs).toISOString().slice(0, 16).replace("T", " ")}Z`;
	const summary = [
		`spend ${usd(t.spendUsd)} over ${num(t.dispatches)} dispatches in ${num(t.conversations)} conversations · ${usd(t.dispatches > 0 ? t.spendUsd / t.dispatches : 0)}/dispatch`,
		`prompt ${num(t.promptTokens)} tok (cache hit ${pct(t.cacheHitRate, t.cacheEstimated)}) · completion ${num(t.completionTokens)} tok · switches ${num(t.modelSwitches)} · escalations ${num(t.escalations)} · failovers ${num(t.failovers)} · errors ${num(t.errors)} (${num(t.aborted)} aborted)`,
	];
	if (r.baselines.length > 0 && t.dispatches > 0) {
		summary.push(
			`same traffic on one model: ${r.baselines
				.map((b) => `${b.slug} ${usd(b.usd)} (router ${b.savedShare >= 0 ? "saved" : "cost extra"} ${pct(Math.abs(b.savedShare))})`)
				.join(" · ")}`,
		);
	}
	if (t.digests > 0) {
		summary.push(
			`digests: ${num(t.digests)} tool results condensed (${num(t.digestInputTokens)} tok read by a cheap model) for ${usd(t.digestSpendUsd)} · re-run rate ${pct(t.digestReruns / t.digests)} (${num(t.digestReruns)} fetched again in full)`,
		);
	}
	if (t.forecastSamples > 0) {
		summary.push(`forecast: mean error ${pct(t.forecastMeanError)} of reported cost over ${num(t.forecastSamples)} turns · ${pct(t.forecastOverShare)} over-predicted`);
	}
	if (t.redactedTurns > 0) {
		// Counts only: the report is read out loud in front of people, and the
		// whole point of the feature is that the matched strings are gone.
		summary.push(`redaction: ${num(t.redactedTurns)} turns had something removed (${num(t.redactions)} strings)`);
	}
	if (t.subagentDispatches > 0) {
		summary.push(`subagents: ${num(t.subagentDispatches)} dispatches, ${usd(t.subagentSpendUsd)} (${pct(t.spendUsd > 0 ? t.subagentSpendUsd / t.spendUsd : 0)} of spend)`);
	}
	const a = r.anatomy;
	if (a !== null) {
		summary.push(
			`prompt anatomy (mean of ${num(a.rows)}): tool results ${pct(a.tool)} · assistant ${pct(a.assistant)} · user ${pct(a.user)} · system ${pct(a.system)} · tool schemas +${pct(a.schemas)} · older half ${pct(a.olderHalf)} · stale tool results ${pct(a.staleTool)} · ${num(a.avgMessages)} messages`,
		);
	}
	const tables: ReportTable[] = [];
	if (r.providers.length > 0) {
		tables.push({
			id: "providers",
			title: "providers",
			headers: ["provider", "dispatches", "spend", "share", "cache", "ttft", "speed", "esc", "err"],
			rows: r.providers.map((p) => [p.key, num(p.dispatches), usd(p.spendUsd), pct(p.share), pct(p.cacheHitRate, p.cacheEstimated), ms(p.avgTtftMs), tps(p.tokensPerSec), num(p.escalations), num(p.errors)]),
		});
	}
	if (r.models.length > 0) {
		tables.push({
			id: "models",
			title: `models (top ${Math.min(maxModels, r.models.length)} of ${r.models.length} by spend)`,
			headers: ["model", "dispatches", "spend", "share", "cache", "ttft", "speed", "feedback", "tiers"],
			rows: r.models.slice(0, maxModels).map((m) => [
				m.key,
				num(m.dispatches),
				usd(m.spendUsd),
				pct(m.share),
				pct(m.cacheHitRate, m.cacheEstimated),
				ms(m.avgTtftMs),
				tps(m.tokensPerSec),
				m.feedback.good + m.feedback.bad === 0 ? "" : `+${m.feedback.good}/-${m.feedback.bad}`,
				Object.entries(m.tiers)
					.sort((a, b) => b[1] - a[1])
					.map(([k, v]) => `${k}:${v}`)
					.join(" "),
			]),
		});
	}
	if (r.tiers.length > 0) {
		tables.push({
			id: "tiers",
			title: "tiers",
			headers: ["tier", "dispatches", "spend", "share", "cache", "avg prompt", "esc"],
			rows: r.tiers.map((x) => [x.key, num(x.dispatches), usd(x.spendUsd), pct(x.share), pct(x.cacheHitRate, x.cacheEstimated), num(x.avgPromptTokens), num(x.escalations)]),
		});
	}
	if (r.days.length > 1) {
		tables.push({
			id: "days",
			title: "by day (UTC)",
			headers: ["day", "dispatches", "spend", "cache"],
			rows: r.days.map((d) => [d.day, num(d.dispatches), usd(d.spendUsd), pct(d.cacheHitRate)]),
		});
	}
	return { heading, summary, tables };
}

/** Plain-text rendering: fixed-width tables, no markup, fits a TUI panel. */
export function renderUsageReport(r: UsageReport, opts: { maxModels?: number } = {}): string {
	const v = reportView(r, opts);
	const out: string[] = [`auto-model-router · ${v.heading}`, "", ...v.summary];
	for (const t of v.tables) out.push("", t.title, ...formatTable(t.headers, t.rows));
	return out.join("\n");
}
