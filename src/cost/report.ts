/**
 * Usage analytics over the ledger, for `/router report` in omp and the
 * `auto-model-router report` CLI (and `GET /v1/router/report`).
 *
 * Everything here is SQL over the `ledger` table the router already writes;
 * nothing is sampled or estimated beyond what the rows carry. Costs are the
 * ledger's own rule: reported when the provider gave one, else the
 * usage-priced figure the orchestrator computed, else the forecast.
 */

import type { Database } from "bun:sqlite";
import { createFeedbackStore, type FeedbackCounts } from "./feedback.ts";

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
const PT = "json_extract(usage, '$.promptTokens')";
const CT = "json_extract(usage, '$.cachedTokens')";
const COMP = "json_extract(usage, '$.completionTokens')";
const PROVIDER = "CASE WHEN slug LIKE 'ollama/%' THEN 'ollama' ELSE 'openrouter' END";
const STREAMED = "ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL";
const EST = "json_extract(usage, '$.cachedEstimated') = 1";

const ROW_SELECT = `
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

interface RawRow {
	key: string;
	dispatches: number;
	spend: number;
	prompt_tokens: number;
	cached_tokens: number;
	estimated_rows: number | null;
	avg_prompt_tokens: number;
	ttft_ms: number | null;
	ctok_sum: number | null;
	elapsed_ms: number | null;
	escalations: number;
	errors: number;
}

function toRow(r: RawRow, windowSpend: number): ReportRow {
	return {
		key: r.key,
		dispatches: r.dispatches,
		spendUsd: r.spend,
		share: windowSpend > 0 ? r.spend / windowSpend : 0,
		cacheHitRate: r.prompt_tokens > 0 ? r.cached_tokens / r.prompt_tokens : 0,
		cacheEstimated: (r.estimated_rows ?? 0) > 0,
		avgPromptTokens: Math.round(r.avg_prompt_tokens),
		avgTtftMs: r.ttft_ms === null ? null : Math.round(r.ttft_ms),
		tokensPerSec: r.elapsed_ms !== null && r.elapsed_ms > 0 && r.ctok_sum !== null ? (r.ctok_sum * 1000) / r.elapsed_ms : null,
		escalations: r.escalations,
		errors: r.errors,
	};
}

/**
 * Builds the report for the last `windowDays`. `harnessId` narrows to one
 * harness (the `X-Omp-Harness` header); empty means everything.
 */
export function buildUsageReport(
	db: Database,
	opts: { windowDays: number; harnessId?: string; nowMs?: number; baselines?: readonly BaselinePrice[] },
): UsageReport {
	const nowMs = opts.nowMs ?? Date.now();
	const windowDays = Math.max(1, opts.windowDays);
	const sinceMs = nowMs - windowDays * 86_400_000;
	const harnessId = opts.harnessId ?? "";
	const where = harnessId === "" ? "created_at_ms >= $since" : "created_at_ms >= $since AND harness_id = $harness";
	const bind = harnessId === "" ? { $since: sinceMs } : { $since: sinceMs, $harness: harnessId };

	const t = db
		.query(
			`SELECT COUNT(*) AS dispatches,
				COUNT(DISTINCT conversation_key) AS conversations,
				COALESCE(SUM(${USD}), 0) AS spend,
				COALESCE(SUM(${PT}), 0) AS prompt_tokens,
				COALESCE(SUM(${CT}), 0) AS cached_tokens,
				COALESCE(SUM(${COMP}), 0) AS completion_tokens,
				SUM(CASE WHEN ${EST} THEN 1 ELSE 0 END) AS estimated_rows,
				SUM(CASE WHEN json_extract(features, '$.isSubagent') = 1 THEN 1 ELSE 0 END) AS subagent_rows,
				COALESCE(SUM(CASE WHEN json_extract(features, '$.isSubagent') = 1 THEN ${USD} ELSE 0 END), 0) AS subagent_spend,
				SUM(CASE WHEN requested_model = 'digest' THEN 1 ELSE 0 END) AS digests,
				COALESCE(SUM(CASE WHEN requested_model = 'digest' THEN ${USD} ELSE 0 END), 0) AS digest_spend,
				COALESCE(SUM(CASE WHEN requested_model = 'digest' THEN ${PT} ELSE 0 END), 0) AS digest_input,
				SUM(CASE WHEN escalation_signal IS NOT NULL THEN 1 ELSE 0 END) AS escalations,
				SUM(CASE WHEN instr(reasons, 'failover:') > 0 THEN 1 ELSE 0 END) AS failovers,
				SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS errors,
				SUM(CASE WHEN error = 'request aborted' THEN 1 ELSE 0 END) AS aborted
			 FROM ledger WHERE ${where}`,
		)
		.get(bind) as {
		dispatches: number;
		conversations: number;
		spend: number;
		prompt_tokens: number;
		cached_tokens: number;
		completion_tokens: number;
		estimated_rows: number | null;
		subagent_rows: number | null;
		subagent_spend: number;
		digests: number | null;
		digest_spend: number;
		digest_input: number;
		escalations: number | null;
		failovers: number | null;
		errors: number | null;
		aborted: number | null;
	};

	// Model switches: consecutive non-wasted rows of one conversation on
	// different slugs. Computed in JS over a slim projection; the window is
	// bounded, and SQLite window functions would make the query less portable.
	const seq = db
		.query(`SELECT conversation_key AS ck, slug FROM ledger WHERE ${where} AND wasted = 0 ORDER BY conversation_key, created_at_ms`)
		.all(bind) as { ck: string; slug: string }[];
	let switches = 0;
	for (let i = 1; i < seq.length; i++) {
		const a = seq[i - 1]!;
		const b = seq[i]!;
		if (a.ck === b.ck && a.slug !== b.slug) switches++;
	}

	const windowSpend = t.spend;
	const providers = (
		db.query(`SELECT ${PROVIDER} AS key, ${ROW_SELECT} FROM ledger WHERE ${where} GROUP BY key ORDER BY spend DESC`).all(bind) as RawRow[]
	).map((r) => toRow(r, windowSpend));

	const modelRows = db
		.query(`SELECT COALESCE(served_slug, slug) AS key, ${ROW_SELECT} FROM ledger WHERE ${where} GROUP BY key ORDER BY spend DESC`)
		.all(bind) as RawRow[];
	const tierMix = db
		.query(`SELECT COALESCE(served_slug, slug) AS key, tier, COUNT(*) AS n FROM ledger WHERE ${where} GROUP BY key, tier`)
		.all(bind) as { key: string; tier: string; n: number }[];
	const mixByModel = new Map<string, Record<string, number>>();
	for (const m of tierMix) {
		const rec = mixByModel.get(m.key) ?? {};
		rec[m.tier] = m.n;
		mixByModel.set(m.key, rec);
	}
	const feedbackBySlug = createFeedbackStore(db).countsBySlug(sinceMs, harnessId);
	const models: ModelRow[] = modelRows.map((r) => ({
		...toRow(r, windowSpend),
		provider: r.key.startsWith("ollama/") ? "ollama" : "openrouter",
		tiers: mixByModel.get(r.key) ?? {},
		feedback: feedbackBySlug.get(r.key) ?? { good: 0, bad: 0 },
	}));

	const tiers = (
		db.query(`SELECT tier AS key, ${ROW_SELECT} FROM ledger WHERE ${where} GROUP BY key ORDER BY spend DESC`).all(bind) as RawRow[]
	).map((r) => toRow(r, windowSpend));

	const days = (
		db
			.query(
				`SELECT date(created_at_ms / 1000, 'unixepoch') AS day, COUNT(*) AS dispatches, COALESCE(SUM(${USD}), 0) AS spend,
					COALESCE(SUM(${PT}), 0) AS prompt_tokens, COALESCE(SUM(${CT}), 0) AS cached_tokens
				 FROM ledger WHERE ${where} GROUP BY day ORDER BY day`,
			)
			.all(bind) as { day: string; dispatches: number; spend: number; prompt_tokens: number; cached_tokens: number }[]
	).map((d) => ({
		day: d.day,
		dispatches: d.dispatches,
		spendUsd: d.spend,
		cacheHitRate: d.prompt_tokens > 0 ? d.cached_tokens / d.prompt_tokens : 0,
	}));

	const an = db
		.query(
			`SELECT COUNT(*) AS rows, AVG(json_extract(features, '$.anatomy.messages')) AS msgs,
				AVG(json_extract(features, '$.anatomy.systemBytes')) AS sys, AVG(json_extract(features, '$.anatomy.userBytes')) AS usr,
				AVG(json_extract(features, '$.anatomy.assistantBytes')) AS asst, AVG(json_extract(features, '$.anatomy.toolBytes')) AS tool,
				AVG(json_extract(features, '$.toolSchemaBytes')) AS schemas,
				AVG(json_extract(features, '$.anatomy.olderHalfBytes')) AS older, AVG(json_extract(features, '$.anatomy.staleToolBytes')) AS stale
			 FROM ledger WHERE ${where} AND json_extract(features, '$.anatomy.messages') IS NOT NULL`,
		)
		.get(bind) as { rows: number; msgs: number | null; sys: number | null; usr: number | null; asst: number | null; tool: number | null; schemas: number | null; older: number | null; stale: number | null };
	let anatomy: AnatomyShare | null = null;
	if (an.rows > 0) {
		const total = (an.sys ?? 0) + (an.usr ?? 0) + (an.asst ?? 0) + (an.tool ?? 0);
		const share = (v: number | null): number => (total > 0 ? (v ?? 0) / total : 0);
		anatomy = {
			rows: an.rows,
			avgMessages: Math.round(an.msgs ?? 0),
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
		const fresh = Math.max(0, t.prompt_tokens - t.cached_tokens);
		const usd = fresh * b.prompt + t.cached_tokens * (b.cacheRead ?? b.prompt) + t.completion_tokens * b.completion;
		return { slug: b.slug, usd, savedShare: usd > 0 ? 1 - t.spend / usd : 0 };
	});

	return {
		generatedAtMs: nowMs,
		windowDays,
		sinceMs,
		harnessId,
		totals: {
			dispatches: t.dispatches,
			conversations: t.conversations,
			spendUsd: t.spend,
			cacheHitRate: t.prompt_tokens > 0 ? t.cached_tokens / t.prompt_tokens : 0,
			promptTokens: t.prompt_tokens,
			completionTokens: t.completion_tokens,
			escalations: t.escalations ?? 0,
			failovers: t.failovers ?? 0,
			errors: t.errors ?? 0,
			aborted: t.aborted ?? 0,
			modelSwitches: switches,
			cacheEstimated: (t.estimated_rows ?? 0) > 0,
			subagentDispatches: t.subagent_rows ?? 0,
			subagentSpendUsd: t.subagent_spend,
			digests: t.digests ?? 0,
			digestSpendUsd: t.digest_spend,
			digestInputTokens: t.digest_input,
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
		summary.push(`digests: ${num(t.digests)} tool results condensed (${num(t.digestInputTokens)} tok read by a cheap model) for ${usd(t.digestSpendUsd)}`);
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
