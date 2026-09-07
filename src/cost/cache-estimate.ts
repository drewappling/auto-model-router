/**
 * Cache accounting for upstreams that cache but do not say so.
 *
 * Ollama Cloud caches prompt prefixes automatically and bills them at its
 * published cached-input rate, but neither its OpenAI-compatible usage nor
 * the native API carries a cached-token count. Measured 2026-09-07: twelve
 * identical 162k-token requests to glm-5.3-flash moved the plan meter by
 * $0.06 against $0.29 at the full input rate, and repeats answered in ~1.5s.
 * Pricing every token fresh overstated a week of Ollama spend 3.7x ($23.01
 * booked against $6.24 metered).
 *
 * The estimate reuses the rule the router already applies when it decides
 * whether staying on a model keeps a warm cache (select.ts step 4): the
 * previous turn's prompt is the cached prefix when the same model served the
 * previous turn within `cacheWarmTtlMs`. Tokens beyond that prefix are fresh.
 * A conversation's first turn, a model switch, or an idle gap past the TTL
 * count as fully cold — the same assumption the stay/switch comparison makes.
 *
 * Estimated counts are flagged (`cachedEstimated`) so reports can show them
 * as estimates and never be mistaken for provider-reported figures.
 */

import type { UsageCounts } from "./types.ts";

export interface CacheEstimateContext {
	/** Model that served the previous turn of this conversation, if any. */
	previousSlug: string | null;
	/** Prompt tokens of that previous turn (0 when unknown). */
	previousPromptTokens: number;
	/** When the previous turn settled, ms epoch. */
	previousAtMs: number;
	/** Model that served this turn. */
	servedSlug: string;
	nowMs: number;
	/** How long a warm prefix is assumed to survive; `hysteresis.cacheWarmTtlMs`. */
	cacheWarmTtlMs: number;
}

/**
 * Returns usage with `cachedTokens` filled in when the upstream reported no
 * cache activity and the router's warm-cache rule says a prefix was warm.
 * Reported cache counts (either field non-zero) are left untouched.
 */
export function estimateUnreportedCache(usage: UsageCounts, ctx: CacheEstimateContext): UsageCounts {
	if (usage.cachedTokens > 0 || usage.cacheWriteTokens > 0) return usage;
	if (usage.promptTokens <= 0) return usage;
	if (ctx.previousSlug === null || ctx.previousSlug !== ctx.servedSlug) return usage;
	if (ctx.previousPromptTokens <= 0) return usage;
	if (ctx.cacheWarmTtlMs <= 0 || ctx.nowMs - ctx.previousAtMs > ctx.cacheWarmTtlMs) return usage;
	const cachedTokens = Math.min(ctx.previousPromptTokens, usage.promptTokens);
	return { ...usage, cachedTokens, cachedEstimated: true };
}
