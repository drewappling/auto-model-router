import { describe, expect, test } from "bun:test";

import { estimateUnreportedCache } from "../src/cost/cache-estimate.ts";
import { EMPTY_USAGE, type UsageCounts } from "../src/cost/types.ts";

/**
 * Ollama Cloud caches prompt prefixes and bills them at its cached rate but
 * reports no count (measured 2026-09-07: 12 identical 162k-token requests
 * moved the plan meter $0.06 against $0.29 at the full rate). The estimate
 * follows the router's warm-cache rule: same model as the previous turn
 * within the TTL ⇒ the previous prompt is the cached prefix.
 */

const base = (over: Partial<UsageCounts> = {}): UsageCounts => ({ ...EMPTY_USAGE, promptTokens: 120_000, completionTokens: 300, ...over });
const ctx = { previousSlug: "ollama/glm", previousPromptTokens: 100_000, previousAtMs: 1_000_000, servedSlug: "ollama/glm", nowMs: 1_060_000, cacheWarmTtlMs: 300_000 };

describe("estimateUnreportedCache", () => {
	test("same model within the TTL: the previous prompt is the cached prefix, flagged as estimated", () => {
		const out = estimateUnreportedCache(base(), ctx);
		expect(out.cachedTokens).toBe(100_000);
		expect(out.cachedEstimated).toBe(true);
		expect(out.promptTokens).toBe(120_000);
	});

	test("a shorter prompt than the previous one caps the cached count at the prompt", () => {
		expect(estimateUnreportedCache(base({ promptTokens: 40_000 }), ctx).cachedTokens).toBe(40_000);
	});

	test("first turn, model switch, or idle past the TTL count as cold", () => {
		expect(estimateUnreportedCache(base(), { ...ctx, previousSlug: null }).cachedTokens).toBe(0);
		expect(estimateUnreportedCache(base(), { ...ctx, previousSlug: "ollama/other" }).cachedTokens).toBe(0);
		expect(estimateUnreportedCache(base(), { ...ctx, nowMs: ctx.previousAtMs + 300_001 }).cachedTokens).toBe(0);
		expect(estimateUnreportedCache(base(), { ...ctx, previousPromptTokens: 0 }).cachedTokens).toBe(0);
		expect(estimateUnreportedCache(base(), { ...ctx, cacheWarmTtlMs: 0 }).cachedTokens).toBe(0);
	});

	test("provider-reported cache counts are never overwritten", () => {
		const reported = base({ cachedTokens: 5_000 });
		expect(estimateUnreportedCache(reported, ctx)).toBe(reported);
		const written = base({ cacheWriteTokens: 5_000 });
		expect(estimateUnreportedCache(written, ctx)).toBe(written);
	});

	test("no prompt tokens: nothing to estimate", () => {
		const empty = base({ promptTokens: 0 });
		expect(estimateUnreportedCache(empty, ctx)).toBe(empty);
	});
});
