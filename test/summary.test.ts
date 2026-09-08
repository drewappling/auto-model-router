import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createLedger } from "../src/cost/ledger.ts";
import { buildDailySummary, countTierChanges, createKv, DAILY_SUMMARY_INTERVAL_MS, markSummaryShown, renderDailySummary, summaryDue, summaryHasNews } from "../src/cost/summary.ts";
import type { LedgerEntry } from "../src/cost/types.ts";
import { openDb } from "../src/util/sqlite.ts";
import { fetchSummary } from "../omp-extension/report-logic.ts";

/**
 * The daily summary: the last 24h against the day before, top models, tier
 * moves, the once-a-day gate in router_kv, and the text the transcript gets.
 */

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 7, 9, 0, 0);

function entry(over: Partial<LedgerEntry>): LedgerEntry {
	return {
		id: crypto.randomUUID(),
		createdAtMs: NOW - HOUR,
		conversationKey: "k",
		sessionId: "s",
		turn: 1,
		requestedModel: "auto",
		harnessId: "",
		ompSessionId: "",
		slug: "vendor/model",
		servedSlug: "vendor/model",
		tier: "simple",
		classificationSource: "heuristic",
		reasons: [],
		features: null,
		score: null,
		confidence: null,
		task: null,
		classifierReasons: null,
		exploredFrom: null,
		holdArm: null,
		predictedUsd: 0.01,
		reportedUsd: 0.01,
		usage: { promptTokens: 1000, cachedTokens: 500, cacheWriteTokens: 0, completionTokens: 100, reasoningTokens: 0, images: 0 },
		attempt: 0,
		escalationSignal: null,
		latencyMs: 1_100,
		ttftMs: 100,
		finishReason: "stop",
		wasted: false,
		upstreamGenerationId: null,
		error: null,
		promptTokensSaved: null,
		...over,
	} as LedgerEntry;
}

function seeded() {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.ledger.path = ":memory:";
	const db = openDb(":memory:");
	const ledger = createLedger(db, cfg);
	return { db, ledger };
}

describe("buildDailySummary", () => {
	test("compares the last 24h with the day before and names the top models and tier moves", () => {
		const { db, ledger } = seeded();
		try {
			// Yesterday: one conversation climbing simple → hard, then dropping to moderate; a second model.
			ledger.record(entry({ createdAtMs: NOW - 5 * HOUR, tier: "simple", turn: 1 }));
			ledger.record(entry({ createdAtMs: NOW - 4 * HOUR, tier: "hard", turn: 2, slug: "vendor/big", servedSlug: "vendor/big", reportedUsd: 0.5 }));
			ledger.record(entry({ createdAtMs: NOW - 3 * HOUR, tier: "moderate", turn: 3, escalationSignal: "empty_completion", wasted: true }));
			ledger.record(entry({ createdAtMs: NOW - 3 * HOUR + 1, tier: "moderate", turn: 3, attempt: 1 }));
			ledger.record(entry({ createdAtMs: NOW - 2 * HOUR, requestedModel: "digest", slug: "vendor/tiny", servedSlug: "vendor/tiny", conversationKey: "d", reportedUsd: 0.001 }));
			// The day before: pricier.
			for (let i = 0; i < 4; i++) ledger.record(entry({ createdAtMs: NOW - 30 * HOUR - i, conversationKey: "old", reportedUsd: 0.4 }));
			const s = buildDailySummary(db, { nowMs: NOW, baselines: [{ slug: "anthropic/claude-opus-5", prompt: 15e-6, completion: 75e-6, cacheRead: 1.5e-6 }] });
			expect(s.current.dispatches).toBe(5);
			expect(s.current.spendUsd).toBeCloseTo(0.531, 6);
			expect(s.current.escalations).toBe(1);
			expect(s.current.digests).toBe(1);
			expect(s.current.modelSwitches).toBe(2);
			expect(s.previous.dispatches).toBe(4);
			expect(s.previous.spendUsd).toBeCloseTo(1.6, 6);
			expect(s.topModels[0]).toMatchObject({ slug: "vendor/big", dispatches: 1 });
			expect(s.topModels[0]!.share).toBeCloseTo(0.5 / 0.531, 3);
			expect(s.tierChanges).toEqual({ up: 1, down: 1 });
			expect(s.baseline?.slug).toBe("anthropic/claude-opus-5");
			expect(summaryHasNews(s)).toBe(true);

			const text = renderDailySummary({ ...s, spikes: [{ slug: "vendor/big", recentDispatches: 8, recentFailures: 4, recentRate: 0.5, baselineDispatches: 90, baselineFailures: 3, baselineRate: 3 / 90 }], ollama: { plan: "pro", usedUsd: 25.2, creditsUsd: 60, runwayDays: 23.4 } });
			expect(text).toContain("auto-model-router daily summary — last 24h (all harnesses)");
			expect(text).toContain("spend $0.531 (prev 24h $1.60, −67%) · 5 turns · 2 conversations · $0.106/turn");
			expect(text).toContain("cache hit 50% · 1 escalations · 0 errors · 2 model switches (1 tier up, 1 down)");
			expect(text).toContain("top models: vendor/big $0.500 (94%, 1 turns)");
			// Tiny seeded turns cost more than Opus would have at list price: the honest branch renders.
			expect(text).toContain("cost 574% MORE than anthropic/claude-opus-5 ($0.079 at list)");
			expect(renderDailySummary({ ...s, baseline: { slug: "anthropic/claude-opus-5", usd: 2.5, savedShare: 0.7876 } })).toContain("saved 79% vs anthropic/claude-opus-5 ($2.50 at list)");
			expect(text).toContain("1 digests for $0.001 (re-run rate 0%)");
			expect(text).toContain("soft failures SPIKING (1):\n  vendor/big: 50% of 8 failed in the last 1h (7d baseline 3% of 90)");
			expect(text).toContain("ollama: pro plan $25.20 of $60 · ~23 days of credits left");
		} finally {
			db.close();
		}
	});

	test("an empty day renders as such and carries no news unless a model is spiking", () => {
		const { db } = seeded();
		try {
			const s = buildDailySummary(db, { nowMs: NOW });
			expect(summaryHasNews(s)).toBe(false);
			const text = renderDailySummary(s);
			expect(text).toContain("no routed turns in the last 24h");
			expect(text).toContain("soft failures: no model spiking in the last hour");
			expect(text).not.toContain("ollama:");
			expect(summaryHasNews({ ...s, spikes: [{ slug: "a/b", recentDispatches: 5, recentFailures: 3, recentRate: 0.6, baselineDispatches: 0, baselineFailures: 0, baselineRate: 0 }] })).toBe(true);
			expect(countTierChanges(db, 0, "")).toEqual({ up: 0, down: 0 });
		} finally {
			db.close();
		}
	});

	test("harness scope narrows both windows", () => {
		const { db, ledger } = seeded();
		try {
			ledger.record(entry({ harnessId: "a" }));
			ledger.record(entry({ harnessId: "b", reportedUsd: 5 }));
			expect(buildDailySummary(db, { nowMs: NOW, harnessId: "a" }).current).toMatchObject({ dispatches: 1, spendUsd: 0.01 });
			expect(buildDailySummary(db, { nowMs: NOW }).current.dispatches).toBe(2);
		} finally {
			db.close();
		}
	});
});

describe("once-a-day gate", () => {
	test("router_kv marks the summary shown per harness for 20h, surviving a reopen", () => {
		const db = openDb(":memory:");
		try {
			const kv = createKv(db);
			expect(summaryDue(kv, "", NOW)).toBe(true);
			markSummaryShown(kv, "", NOW);
			expect(summaryDue(kv, "", NOW + HOUR)).toBe(false);
			expect(summaryDue(kv, "other", NOW + HOUR)).toBe(true);
			expect(summaryDue(kv, "", NOW + DAILY_SUMMARY_INTERVAL_MS)).toBe(true);
			// Same table, fresh handle: the marker is durable.
			expect(summaryDue(createKv(db), "", NOW + HOUR)).toBe(false);
			kv.set("k", "v1");
			kv.set("k", "v2");
			expect(kv.get("k")).toBe("v2");
			expect(kv.get("missing")).toBeNull();
		} finally {
			db.close();
		}
	});
});

describe("fetchSummary", () => {
	test("passes harness and auto through and surfaces the router's verdict", async () => {
		const calls: string[] = [];
		const fetchImpl = async (url: string): Promise<Response> => {
			calls.push(url);
			return new Response(JSON.stringify({ due: false, reason: "posted in the last 20h", summary: null }), { status: 200 });
		};
		const r = await fetchSummary("http://h", "omp", true, {}, fetchImpl);
		expect(r).toEqual({ due: false, reason: "posted in the last 20h", summary: null });
		expect(calls).toEqual(["http://h/v1/router/summary?harness=omp&auto=1"]);
		await fetchSummary("http://h", "", false, {}, fetchImpl);
		expect(calls[1]).toBe("http://h/v1/router/summary");
		await expect(fetchSummary("http://h", "", false, {}, async () => new Response("no", { status: 503 }))).rejects.toThrow("router returned 503");
	});
});
