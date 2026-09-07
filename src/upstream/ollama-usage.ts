/**
 * Ollama Cloud plan usage, read from `GET https://ollama.com/api/usage`.
 *
 * The endpoint is what ollama.com's own dashboard reads. It is not in the
 * public docs (two open feature requests ask for exactly this), so everything
 * here is defensive: unknown shape ⇒ null, never a throw, and the raw value is
 * surfaced on /health so an operator can check it against the dashboard.
 *
 * Observed shape (2026-09-06, a Pro account):
 *
 *   { activity: { cost: "0.00000", period: {type: "last_4_weeks", …}, models: [] },
 *     limits:   { monthly: { usage: 0, models: [{ name, request_count }] } } }
 *
 * `limits.monthly.usage` is the share of the plan's included monthly credits
 * consumed. It is reported relative to the plan, which is the point: the
 * router never needs to know whether the account is Pro ($60) or Max ($300)
 * to know how close it is to the edge. `request_count` moves immediately;
 * `usage` and `activity.cost` are aggregated with a lag and round to whole
 * units, so a few cents of test traffic reads as 0.
 *
 * The scale of `usage` is inferred, not documented: a value above 1 is a
 * percentage; 0 is 0; a non-integer at or below 1 is a fraction. The one
 * ambiguous reading, exactly 1, is taken as 1% (dashboards show whole
 * percents) rather than 100%, which errs toward keeping the bias on.
 */

import type { Logger } from "../util/log.ts";

export interface OllamaUsage {
	/** Share of the plan's included monthly credits used, 0-1. Null when the payload lacks it. */
	monthlyUsedFraction: number | null;
	/** `limits.monthly.usage` exactly as reported, for the dashboard cross-check. */
	monthlyUsageRaw: number | null;
	/** `activity.cost` (rolling 4 weeks, USD) as reported, or null. */
	activityCostUsd: number | null;
	/** Requests this billing month, summed over models. */
	requestsThisMonth: number;
	fetchedAtMs: number;
}

function asRec(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** See the module comment for the scale inference. */
export function usageFraction(raw: number): number {
	if (!Number.isFinite(raw) || raw <= 0) return 0;
	if (raw > 1) return Math.min(1, raw / 100);
	if (raw === 1) return 0.01;
	return raw;
}

export function parseOllamaUsage(json: unknown, nowMs = Date.now()): OllamaUsage | null {
	const root = asRec(json);
	if (root === null) return null;
	const limits = asRec(root.limits);
	const monthly = limits === null ? null : asRec(limits.monthly);
	const usageRaw = monthly !== null && typeof monthly.usage === "number" && Number.isFinite(monthly.usage) ? monthly.usage : null;
	let requests = 0;
	if (monthly !== null && Array.isArray(monthly.models)) {
		for (const m of monthly.models) {
			const rec = asRec(m);
			if (rec !== null && typeof rec.request_count === "number") requests += rec.request_count;
		}
	}
	const activity = asRec(root.activity);
	const costRaw = activity?.cost;
	const cost = typeof costRaw === "number" ? costRaw : typeof costRaw === "string" ? Number(costRaw) : NaN;
	if (usageRaw === null && limits === null && activity === null) return null;
	return {
		monthlyUsedFraction: usageRaw === null ? null : usageFraction(usageRaw),
		monthlyUsageRaw: usageRaw,
		activityCostUsd: Number.isFinite(cost) ? cost : null,
		requestsThisMonth: requests,
		fetchedAtMs: nowMs,
	};
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaUsageSource {
	/** Latest usage, refreshed when older than the poll interval; last good value on failure. */
	get(): Promise<OllamaUsage | null>;
	/** Last fetched value without touching the network. */
	peek(): OllamaUsage | null;
}

/** Inert source for setups with no key (the daemon path without `/login ollama-cloud`). */
export const NO_USAGE: OllamaUsageSource = { get: async () => null, peek: () => null };

export function createOllamaUsageSource(
	opts: { apiKey: string; pollMs: number; timeoutMs: number; log: Logger; fetchImpl?: FetchLike; root?: string },
): OllamaUsageSource {
	if (opts.apiKey === "" || opts.pollMs <= 0) return NO_USAGE;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const root = (opts.root ?? "https://ollama.com").replace(/\/+$/, "");
	let current: OllamaUsage | null = null;
	let checkedAtMs = 0;
	let inflight: Promise<OllamaUsage | null> | null = null;
	let warned = false;

	async function refresh(): Promise<OllamaUsage | null> {
		try {
			const res = await fetchImpl(`${root}/api/usage`, {
				headers: { authorization: `Bearer ${opts.apiKey}` },
				signal: AbortSignal.timeout(opts.timeoutMs),
			});
			if (res.ok) {
				const parsed = parseOllamaUsage(await res.json());
				if (parsed !== null) {
					current = parsed;
					warned = false;
				} else if (!warned) {
					warned = true;
					opts.log.warn("ollama usage payload had no recognisable fields; credit-aware bias stays on its last reading");
				}
			} else if (!warned) {
				warned = true;
				opts.log.warn("ollama usage endpoint unavailable; credit-aware bias stays on its last reading", { status: res.status });
			}
		} catch (err) {
			if (!warned) {
				warned = true;
				opts.log.warn("ollama usage fetch failed; credit-aware bias stays on its last reading", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		checkedAtMs = Date.now();
		return current;
	}

	return {
		async get() {
			if (Date.now() - checkedAtMs < opts.pollMs) return current;
			inflight ??= refresh().finally(() => {
				inflight = null;
			});
			return inflight;
		},
		peek: () => current,
	};
}

/**
 * The cost multiplier to apply to Ollama candidates right now: `costBias`
 * while the plan's included credits are below `biasUntilUsage`, list price
 * (1) once they are exhausted. Unknown usage keeps the bias — the plan is far
 * more often under its allowance than over it, and a 402 still trips the
 * breaker if that guess is wrong.
 */
export function effectiveOllamaBias(costBias: number, biasUntilUsage: number, usage: OllamaUsage | null): number {
	if (costBias >= 1) return costBias;
	const used = usage?.monthlyUsedFraction ?? null;
	if (used === null) return costBias;
	return used >= biasUntilUsage ? 1 : costBias;
}

/** The dashboard's dollar reading: plan share × included credits, when both are known. */
export function ollamaMeter(usage: OllamaUsage | null, planCreditsUsd: number): { usedUsd: number; creditsUsd: number } | null {
	if (usage === null || usage.monthlyUsedFraction === null || !(planCreditsUsd > 0)) return null;
	return { usedUsd: Math.round(usage.monthlyUsedFraction * planCreditsUsd * 100) / 100, creditsUsd: planCreditsUsd };
}
