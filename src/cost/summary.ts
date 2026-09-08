/**
 * The daily summary: what the router did in the last 24 hours, in a few
 * lines. Posted into the transcript once a day at omp session start
 * (`report.dailySummary`) and on demand via `/router summary` or
 * `GET /v1/router/summary`.
 *
 * Built from the same `buildUsageReport` the report hub uses, over a 1-day
 * window, with the preceding day for comparison, plus the two live signals the
 * report cannot carry: soft-failure spikes (the last hour) and the Ollama
 * meter. The once-a-day gate is a marker in `router_kv`, keyed per harness, so
 * several omp windows on one router share it and a restart does not repeat it.
 */

import type { Database } from "bun:sqlite";
import { TIER_ORDER } from "../router/types.ts";
import { buildUsageReport, harnessFilter, type BaselinePrice, type BaselineRow, type UsageReport } from "./report.ts";
import type { SoftFailureSpike } from "./types.ts";

/** One 24-hour window's headline numbers. */
export interface SummaryWindow {
	spendUsd: number;
	dispatches: number;
	conversations: number;
	cacheHitRate: number;
	cacheEstimated: boolean;
	escalations: number;
	errors: number;
	modelSwitches: number;
	digests: number;
	digestSpendUsd: number;
	digestReruns: number;
	subagentSpendUsd: number;
}

export interface SummaryModel {
	slug: string;
	spendUsd: number;
	share: number;
	dispatches: number;
}

export interface SummaryOllama {
	plan: string | null;
	usedUsd: number;
	creditsUsd: number;
	/** Days of credits left at the recent burn; null when the burn is zero. */
	runwayDays: number | null;
}

export interface DailySummary {
	generatedAtMs: number;
	sinceMs: number;
	/** Empty ⇒ every harness. */
	harnessId: string;
	current: SummaryWindow;
	/** The 24 hours before `sinceMs`. */
	previous: SummaryWindow;
	/** Top models by spend in the current window. */
	topModels: SummaryModel[];
	/** Tier moves between consecutive kept turns of one conversation. */
	tierChanges: { up: number; down: number };
	/** The first configured baseline the catalog knew, when any. */
	baseline: BaselineRow | null;
	spikes: SoftFailureSpike[];
	ollama: SummaryOllama | null;
}

const DAY_MS = 86_400_000;
/** How many top models the summary names. */
const TOP_MODELS = 3;

function windowOf(r: UsageReport): SummaryWindow {
	const t = r.totals;
	return {
		spendUsd: t.spendUsd,
		dispatches: t.dispatches,
		conversations: t.conversations,
		cacheHitRate: t.cacheHitRate,
		cacheEstimated: t.cacheEstimated,
		escalations: t.escalations,
		errors: t.errors,
		modelSwitches: t.modelSwitches,
		digests: t.digests,
		digestSpendUsd: t.digestSpendUsd,
		digestReruns: t.digestReruns,
		subagentSpendUsd: t.subagentSpendUsd,
	};
}

/** Counts tier moves up and down between consecutive kept turns of each conversation since `sinceMs`. */
export function countTierChanges(db: Database, sinceMs: number, harnessId: string): { up: number; down: number } {
	const hf = harnessFilter(harnessId);
	const where = ["created_at_ms >= $since", ...hf.sql].join(" AND ");
	const bind = { $since: sinceMs, ...hf.bind };
	const seq = db
		.query(`SELECT conversation_key AS ck, tier FROM ledger WHERE ${where} AND wasted = 0 AND requested_model <> 'digest' ORDER BY conversation_key, created_at_ms`)
		.all(bind) as { ck: string; tier: string }[];
	let up = 0;
	let down = 0;
	for (let i = 1; i < seq.length; i++) {
		const a = seq[i - 1]!;
		const b = seq[i]!;
		if (a.ck !== b.ck) continue;
		const ra = TIER_ORDER.indexOf(a.tier as (typeof TIER_ORDER)[number]);
		const rb = TIER_ORDER.indexOf(b.tier as (typeof TIER_ORDER)[number]);
		if (ra < 0 || rb < 0 || ra === rb) continue;
		if (rb > ra) up++;
		else down++;
	}
	return { up, down };
}

export function buildDailySummary(
	db: Database,
	opts: {
		harnessId?: string;
		nowMs?: number;
		baselines?: readonly BaselinePrice[];
		spikes?: readonly SoftFailureSpike[];
		ollama?: SummaryOllama | null;
	} = {},
): DailySummary {
	const nowMs = opts.nowMs ?? Date.now();
	const harnessId = opts.harnessId ?? "";
	const baselines = opts.baselines ?? [];
	const current = buildUsageReport(db, { windowDays: 1, harnessId, nowMs, baselines });
	const previous = buildUsageReport(db, { windowDays: 1, harnessId, nowMs: nowMs - DAY_MS, untilMs: current.sinceMs });
	return {
		generatedAtMs: nowMs,
		sinceMs: current.sinceMs,
		harnessId,
		current: windowOf(current),
		previous: windowOf(previous),
		topModels: current.models.slice(0, TOP_MODELS).map((m) => ({ slug: m.key, spendUsd: m.spendUsd, share: m.share, dispatches: m.dispatches })),
		tierChanges: countTierChanges(db, current.sinceMs, harnessId),
		baseline: current.baselines[0] ?? null,
		spikes: [...(opts.spikes ?? [])],
		ollama: opts.ollama ?? null,
	};
}

/** Whether the once-a-day auto summary is worth posting: something happened, or something is wrong. */
export function summaryHasNews(s: DailySummary): boolean {
	return s.current.dispatches > 0 || s.spikes.length > 0;
}

const usd = (v: number): string => (v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
const pct = (v: number, estimated = false): string => `${estimated ? "~" : ""}${Math.round(v * 100)}%`;

function delta(current: number, previous: number): string {
	if (previous <= 0) return current > 0 ? " (prev 24h: none)" : "";
	const change = (current - previous) / previous;
	const sign = change >= 0 ? "+" : "−";
	return ` (prev 24h ${usd(previous)}, ${sign}${Math.round(Math.abs(change) * 100)}%)`;
}

/** Renders the summary as a few plain lines for the transcript. */
export function renderDailySummary(s: DailySummary): string {
	const scope = s.harnessId === "" ? "all harnesses" : s.harnessId.includes(",") ? `${s.harnessId.split(",").length} harnesses` : `harness ${s.harnessId}`;
	const out: string[] = [`auto-model-router daily summary — last 24h (${scope})`];
	const c = s.current;
	if (c.dispatches === 0) {
		out.push("no routed turns in the last 24h");
	} else {
		out.push(
			`spend ${usd(c.spendUsd)}${delta(c.spendUsd, s.previous.spendUsd)} · ${c.dispatches} turns · ${c.conversations} conversations · ${usd(c.spendUsd / c.dispatches)}/turn`,
		);
		const moves = c.modelSwitches > 0 ? ` (${s.tierChanges.up} tier up, ${s.tierChanges.down} down)` : "";
		out.push(`cache hit ${pct(c.cacheHitRate, c.cacheEstimated)} · ${c.escalations} escalations · ${c.errors} errors · ${c.modelSwitches} model switches${moves}`);
		if (s.topModels.length > 0) {
			out.push(`top models: ${s.topModels.map((m) => `${m.slug} ${usd(m.spendUsd)} (${pct(m.share)}, ${m.dispatches} turns)`).join(" · ")}`);
		}
		if (s.baseline !== null && s.baseline.usd > 0) {
			const b = s.baseline;
			out.push(b.savedShare >= 0 ? `saved ${pct(b.savedShare)} vs ${b.slug} (${usd(b.usd)} at list)` : `cost ${pct(-b.savedShare)} MORE than ${b.slug} (${usd(b.usd)} at list)`);
		}
		const extras: string[] = [];
		if (c.digests > 0) extras.push(`${c.digests} digests for ${usd(c.digestSpendUsd)} (re-run rate ${pct(c.digestReruns / c.digests)})`);
		if (c.subagentSpendUsd > 0) extras.push(`subagents ${usd(c.subagentSpendUsd)}`);
		if (extras.length > 0) out.push(extras.join(" · "));
	}
	if (s.spikes.length === 0) out.push("soft failures: no model spiking in the last hour");
	else {
		out.push(`soft failures SPIKING (${s.spikes.length}):`);
		for (const sp of s.spikes) {
			out.push(`  ${sp.slug}: ${pct(sp.recentRate)} of ${sp.recentDispatches} failed in the last 1h (7d baseline ${pct(sp.baselineRate)} of ${sp.baselineDispatches})`);
		}
	}
	const o = s.ollama;
	if (o !== null) {
		const runway = o.runwayDays === null ? "" : ` · ~${Math.round(o.runwayDays)} days of credits left`;
		out.push(`ollama: ${o.plan === null ? "plan" : `${o.plan} plan`} $${o.usedUsd.toFixed(2)} of $${o.creditsUsd}${runway}`);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Once-a-day gate
// ---------------------------------------------------------------------------

/** A summary posted less than this long ago is not due again. */
export const DAILY_SUMMARY_INTERVAL_MS = 20 * 3_600_000;

export interface KeyValueStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
}

/** A tiny durable key/value store over the `router_kv` table. */
export function createKv(db: Database): KeyValueStore {
	const getStmt = db.query("SELECT value FROM router_kv WHERE key = $key");
	const setStmt = db.query("INSERT INTO router_kv (key, value, updated_at_ms) VALUES ($key, $value, $at) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms");
	return {
		get(key) {
			const row = getStmt.get({ $key: key }) as { value: string } | null;
			return row === null ? null : row.value;
		},
		set(key, value) {
			setStmt.run({ $key: key, $value: value, $at: Date.now() });
		},
	};
}

const shownKey = (harnessId: string): string => `daily_summary_shown:${harnessId}`;

/** True when no auto summary has been posted for this harness within the interval. */
export function summaryDue(kv: KeyValueStore, harnessId: string, nowMs = Date.now()): boolean {
	const last = Number(kv.get(shownKey(harnessId)) ?? "0");
	return !(Number.isFinite(last) && nowMs - last < DAILY_SUMMARY_INTERVAL_MS);
}

export function markSummaryShown(kv: KeyValueStore, harnessId: string, nowMs = Date.now()): void {
	kv.set(shownKey(harnessId), String(nowMs));
}
