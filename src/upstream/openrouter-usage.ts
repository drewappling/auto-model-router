/**
 * OpenRouter credit balance, polled on a slow interval and read without
 * network on every routing decision (`GET /api/v1/credits`: management-key
 * scope, `data.total_credits - data.total_usage` = the balance that gates a
 * dispatch — OpenRouter reserves credits per in-flight request, so the
 * UNRESERVED balance is what a 402 means).
 *
 * Mirrors the Ollama usage source: a key that is empty now may be set from
 * the dashboard later, so the reader stays live and idles until it is not.
 * A failed or unparseable poll keeps the last reading — the balance moves
 * slowly, and hiding a provider on a poll glitch would route around it for
 * nothing.
 */

import type { Logger } from "../util/log.ts";

/** Minimal fetch surface, injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OpenRouterCredits {
	/** Balance in USD: total_credits − total_usage. Null when the payload lacks it. */
	remainingUsd: number | null;
	/** Lifetime credits bought and used, for the dashboard. */
	totalCreditsUsd: number | null;
	totalUsageUsd: number | null;
	fetchedAtMs: number;
}

export interface OpenRouterUsageSource {
	/** Latest reading, refreshed when older than the poll interval; last good value on failure. */
	get(): Promise<OpenRouterCredits | null>;
	/** Last fetched value without touching the network. */
	peek(): OpenRouterCredits | null;
}

export const NO_OPENROUTER_USAGE: OpenRouterUsageSource = { get: async () => null, peek: () => null };

function parseCredits(json: unknown): OpenRouterCredits | null {
	if (typeof json !== "object" || json === null || !("data" in json)) return null;
	const data: unknown = json.data;
	if (typeof data !== "object" || data === null) return null;
	const d = data as Record<string, unknown>; // narrowed above; cast names the wire shape once
	const total = typeof d.total_credits === "number" ? d.total_credits : null;
	const used = typeof d.total_usage === "number" ? d.total_usage : null;
	if (total === null || used === null) return null;
	return { remainingUsd: total - used, totalCreditsUsd: total, totalUsageUsd: used, fetchedAtMs: Date.now() };
}

export function createOpenRouterUsageSource(opts: {
	apiKey: () => string;
	pollMs: number;
	timeoutMs: number;
	log: Logger;
	fetchImpl?: FetchLike;
	root?: string;
}): OpenRouterUsageSource {
	if (opts.pollMs <= 0) return NO_OPENROUTER_USAGE;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const root = (opts.root ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
	let current: OpenRouterCredits | null = null;
	let checkedAtMs = 0;
	let inflight: Promise<OpenRouterCredits | null> | null = null;
	let warned = false;

	async function refresh(): Promise<OpenRouterCredits | null> {
		try {
			const res = await fetchImpl(`${root}/credits`, {
				headers: { authorization: `Bearer ${opts.apiKey()}` },
				signal: AbortSignal.timeout(opts.timeoutMs),
			});
			if (res.ok) {
				const parsed = parseCredits(await res.json());
				if (parsed !== null) {
					current = parsed;
					warned = false;
				} else if (!warned) {
					warned = true;
					opts.log.warn("openrouter credits payload had no recognisable fields; credit gate keeps its last reading");
				}
			} else if (!warned) {
				warned = true;
				opts.log.warn("openrouter credits endpoint unavailable; credit gate keeps its last reading", { status: res.status });
			}
		} catch (err) {
			if (!warned) {
				warned = true;
				opts.log.warn("openrouter credits fetch failed; credit gate keeps its last reading", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		checkedAtMs = Date.now();
		return current;
	}

	return {
		async get() {
			if (opts.apiKey() === "") return null;
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
 * True while OpenRouter may serve: the balance is strictly above the floor, or
 * unknown (a poll that has not landed yet, no key for the endpoint, a payload
 * change). Hiding on unknown would take a provider down for a dashboard's
 * missing field — fail open instead; the 402 breaker still catches the real
 * thing.
 */
export function openRouterServing(credits: OpenRouterCredits | null, minCreditsUsd: number): boolean {
	if (minCreditsUsd <= 0) return true;
	if (credits === null || credits.remainingUsd === null) return true;
	return credits.remainingUsd > minCreditsUsd;
}