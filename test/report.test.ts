import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";


import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createSqlLedger } from "../src/cost/ledger-sql.ts";
import { migrateStore } from "../src/util/schema.ts";
import type { AsyncLedger } from "../src/cost/types.ts";
import { buildUsageReport, renderUsageReport } from "../src/cost/report.ts";
import type { LedgerEntry } from "../src/cost/types.ts";
import { openSqlDb, type SqlDb } from "../src/util/sql.ts";

/**
 * `buildUsageReport` is what `/router report`, the `report` CLI and
 * `GET /v1/router/report` all render. These pin the aggregation rules:
 * spend follows the ledger's reported-else-predicted rule, cache hit rate is
 * cached/prompt tokens, speed comes only from clean streamed rows, the
 * provider is derived from the served slug, and harness scoping works.
 */

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

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
		predictedUsd: 0.001,
		reportedUsd: 0.001,
		usage: { promptTokens: 1000, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 100, reasoningTokens: 0, images: 0 },
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

async function seeded(): Promise<{ db: SqlDb; ledger: AsyncLedger }> {
	const cfg = structuredClone(DEFAULT_CONFIG);
	// A file rather than `:memory:`: the report reads through its own handle on
	// the store, which an in-memory database cannot share.
	const path = join(tmpdir(), `report-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	cfg.ledger.path = path;
	const db = openSqlDb(path);
	await migrateStore(db);
	return { db, ledger: createSqlLedger(db, cfg, { findModel: () => null }) };
}

describe("buildUsageReport", () => {
	test("totals, providers, models and tiers over a mixed window", async () => {
		const { db, ledger } = await seeded();
		// Two OpenRouter turns on one model (one with a warm cache), one Ollama
		// turn served by a different slug than decided, one escalation, one error.
		await ledger.record(entry({ conversationKey: "a", turn: 1, reportedUsd: 0.01 }));
		await ledger.record(
			entry({
				conversationKey: "a",
				turn: 2,
				reportedUsd: 0.005,
				usage: { promptTokens: 1000, cachedTokens: 800, cacheWriteTokens: 0, completionTokens: 100, reasoningTokens: 0, images: 0 },
			}),
		);
		await ledger.record(
			entry({
				conversationKey: "b",
				slug: "ollama/glm-5.3-flash",
				servedSlug: "ollama/glm-5.3-flash",
				tier: "moderate",
				predictedUsd: 0.02,
				reportedUsd: null,
				latencyMs: 2_100,
				ttftMs: 100,
			}),
		);
		await ledger.record(entry({ conversationKey: "c", tier: "hard", escalationSignal: "refusal", wasted: true, reportedUsd: 0.002 }));
		await ledger.record(entry({ conversationKey: "c", tier: "hard", error: "request aborted", reportedUsd: 0, ttftMs: null }));

		const r = await buildUsageReport(db, { windowDays: 7, nowMs: NOW });
		expect(r.totals.dispatches).toBe(5);
		expect(r.totals.conversations).toBe(3);
		// 0.01 + 0.005 + 0.02 (predicted: no reported) + 0.002 + 0
		expect(r.totals.spendUsd).toBeCloseTo(0.037, 6);
		expect(r.totals.cacheHitRate).toBeCloseTo(800 / 5000, 6);
		expect(r.totals.escalations).toBe(1);
		expect(r.totals.errors).toBe(1);
		expect(r.totals.aborted).toBe(1);

		// Ordered by spend: the single Ollama turn (0.02 predicted) outspends OpenRouter (0.017).
		expect(r.providers.map((p) => p.key)).toEqual(["ollama", "openrouter"]);
		const or = r.providers[1]!;
		expect(or.dispatches).toBe(4);
		expect(or.spendUsd).toBeCloseTo(0.017, 6);
		expect(or.share).toBeCloseTo(0.017 / 0.037, 6);
		// Speed: 3 clean streamed rows × 100 completion tokens over (1100-100) ms each.
		expect(or.avgTtftMs).toBe(100);
		expect(or.tokensPerSec).toBeCloseTo(100, 3);

		const ollama = r.providers[0]!;
		expect(ollama.dispatches).toBe(1);
		expect(ollama.tokensPerSec).toBeCloseTo(50, 3);

		expect(r.models.map((m) => m.key)).toEqual(["ollama/glm-5.3-flash", "vendor/model"]);
		expect(r.models[0]!.provider).toBe("ollama");
		expect(r.models[1]!.tiers).toEqual({ simple: 2, hard: 2 });

		const tierKeys = r.tiers.map((t) => t.key).sort();
		expect(tierKeys).toEqual(["hard", "moderate", "simple"]);
		expect(r.tiers.find((t) => t.key === "hard")!.escalations).toBe(1);

		expect(r.days).toHaveLength(1);
		expect(r.days[0]!.day).toBe("2026-09-06");
		db.close();
	});

	test("counts a model switch only between consecutive kept rows of one conversation", async () => {
		const { db, ledger } = await seeded();
		await ledger.record(entry({ conversationKey: "a", turn: 1, slug: "x/one", createdAtMs: NOW - 3 * HOUR }));
		await ledger.record(entry({ conversationKey: "a", turn: 2, slug: "x/two", createdAtMs: NOW - 2 * HOUR }));
		await ledger.record(entry({ conversationKey: "a", turn: 3, slug: "x/two", createdAtMs: NOW - 1 * HOUR }));
		// A wasted probe on another slug is not a switch.
		await ledger.record(entry({ conversationKey: "a", turn: 3, slug: "x/three", wasted: true, createdAtMs: NOW - 1 * HOUR + 1 }));
		// A different conversation starting on another model is not a switch either.
		await ledger.record(entry({ conversationKey: "b", turn: 1, slug: "x/three", createdAtMs: NOW - HOUR }));
		const r = await buildUsageReport(db, { windowDays: 1, nowMs: NOW });
		expect(r.totals.modelSwitches).toBe(1);
		db.close();
	});

	test("window and harness scope exclude rows", async () => {
		const { db, ledger } = await seeded();
		await ledger.record(entry({ harnessId: "omp", createdAtMs: NOW - HOUR }));
		await ledger.record(entry({ harnessId: "hermes", createdAtMs: NOW - HOUR }));
		await ledger.record(entry({ harnessId: "omp", createdAtMs: NOW - 10 * 24 * HOUR }));
		expect((await buildUsageReport(db, { windowDays: 7, nowMs: NOW })).totals.dispatches).toBe(2);
		expect((await buildUsageReport(db, { windowDays: 30, nowMs: NOW })).totals.dispatches).toBe(3);
		const scoped = await buildUsageReport(db, { windowDays: 30, harnessId: "omp", nowMs: NOW });
		expect(scoped.totals.dispatches).toBe(2);
		expect(scoped.harnessId).toBe("omp");
		db.close();
	});

	test("a comma-separated harness list reports the union (a team group)", async () => {
		const { db, ledger } = await seeded();
		try {
			await ledger.record(entry({ harnessId: "u_a", reportedUsd: 1 }));
			await ledger.record(entry({ harnessId: "u_b", reportedUsd: 2 }));
			await ledger.record(entry({ harnessId: "u_c", reportedUsd: 4 }));
			expect((await buildUsageReport(db, { windowDays: 1, nowMs: NOW, harnessId: "u_a,u_b" })).totals.spendUsd).toBeCloseTo(3, 6);
			expect((await buildUsageReport(db, { windowDays: 1, nowMs: NOW, harnessId: " u_c , u_a " })).totals.spendUsd).toBeCloseTo(5, 6);
			expect((await buildUsageReport(db, { windowDays: 1, nowMs: NOW, harnessId: "u_b" })).totals.spendUsd).toBeCloseTo(2, 6);
		} finally {
			db.close();
		}
	});

	test("prompt anatomy averages the recorded byte shares", async () => {
		const { db, ledger } = await seeded();
		const feat = (tool: number, older: number, stale: number) => ({ toolSchemaBytes: 1000, anatomy: { messages: 30, systemBytes: 1000, userBytes: 500, assistantBytes: 500, toolBytes: tool, olderHalfBytes: older, staleToolBytes: stale } });
		await ledger.record(entry({ features: feat(8000, 5000, 4000) }));
		await ledger.record(entry({ features: feat(6000, 4000, 2000) }));
		await ledger.record(entry({ features: null })); // pre-anatomy row: ignored
		const r = await buildUsageReport(db, { windowDays: 7, nowMs: NOW });
		const a = r.anatomy!;
		expect(a.rows).toBe(2);
		// mean bytes: system 1000, user 500, assistant 500, tool 7000 ⇒ total 9000
		expect(a.tool).toBeCloseTo(7000 / 9000, 6);
		expect(a.system).toBeCloseTo(1000 / 9000, 6);
		expect(a.schemas).toBeCloseTo(1000 / 9000, 6);
		expect(a.olderHalf).toBeCloseTo(4500 / 9000, 6);
		expect(a.staleTool).toBeCloseTo(3000 / 9000, 6);
		expect(renderUsageReport(r)).toContain("prompt anatomy (mean of 2): tool results 78%");
		db.close();
	});

	test("baselines price the window on one model with its own cache hit rate", async () => {
		const { db, ledger } = await seeded();
		await ledger.record(entry({ reportedUsd: 0.5, usage: { promptTokens: 100_000, cachedTokens: 80_000, cacheWriteTokens: 0, completionTokens: 1_000, reasoningTokens: 0, images: 0 } }));
		const r = await buildUsageReport(db, {
			windowDays: 7,
			nowMs: NOW,
			baselines: [
				{ slug: "big/model", prompt: 15 / 1e6, completion: 75 / 1e6, cacheRead: 1.5 / 1e6 },
				{ slug: "nocache/model", prompt: 3 / 1e6, completion: 15 / 1e6 },
			],
		});
		// 20k fresh × $15/M + 80k cached × $1.5/M + 1k completion × $75/M = 0.30 + 0.12 + 0.075
		expect(r.baselines[0]!.usd).toBeCloseTo(0.495, 6);
		expect(r.baselines[0]!.savedShare).toBeCloseTo(1 - 0.5 / 0.495, 6);
		// No cache rate published: every prompt token at list price.
		expect(r.baselines[1]!.usd).toBeCloseTo(0.3 + 0.015, 6);
		const text = renderUsageReport(r);
		expect(text).toContain("same traffic on one model: big/model $0.4950 (router cost extra 1%)");
		expect(text).toContain("nocache/model $0.3150 (router cost extra 59%)");
		db.close();
	});

	test("subagent turns are counted with their spend", async () => {
		const { db, ledger } = await seeded();
		await ledger.record(entry({ reportedUsd: 0.01, features: { isSubagent: true } }));
		await ledger.record(entry({ reportedUsd: 0.03, features: { isSubagent: false } }));
		await ledger.record(entry({ reportedUsd: 0.06 }));
		const r = await buildUsageReport(db, { windowDays: 7, nowMs: NOW });
		expect(r.totals.subagentDispatches).toBe(1);
		expect(r.totals.subagentSpendUsd).toBeCloseTo(0.01, 6);
		expect(renderUsageReport(r)).toContain("subagents: 1 dispatches, $0.0100 (10% of spend)");
		db.close();
	});

	test("empty ledger yields zeroed totals and null speeds", async () => {
		const { db } = await seeded();
		const r = await buildUsageReport(db, { windowDays: 7, nowMs: NOW });
		expect(r.totals).toEqual({
			dispatches: 0,
			conversations: 0,
			spendUsd: 0,
			cacheHitRate: 0,
			promptTokens: 0,
			completionTokens: 0,
			redactions: 0,
			redactedTurns: 0,
			escalations: 0,
			failovers: 0,
			errors: 0,
			aborted: 0,
			modelSwitches: 0,
			cacheEstimated: false,
			subagentDispatches: 0,
			subagentSpendUsd: 0,
			digests: 0,
			digestSpendUsd: 0,
			digestInputTokens: 0, digestReruns: 0, forecastSamples: 0, forecastMeanError: 0, forecastOverShare: 0,
		});
		expect(r.providers).toEqual([]);
		expect(r.models).toEqual([]);
		expect(r.anatomy).toBeNull();
		expect(r.baselines).toEqual([]);
		db.close();
	});

	test("speed ignores errored and non-streamed rows", async () => {
		const { db, ledger } = await seeded();
		await ledger.record(entry({ ttftMs: null }));
		await ledger.record(entry({ error: "boom" }));
		const r = await buildUsageReport(db, { windowDays: 7, nowMs: NOW });
		expect(r.providers[0]!.avgTtftMs).toBeNull();
		expect(r.providers[0]!.tokensPerSec).toBeNull();
		db.close();
	});
});

describe("renderUsageReport", () => {
	test("router-estimated cache counts render as an estimate", async () => {
		const { db, ledger } = await seeded();
		await ledger.record(entry({ slug: "ollama/glm", servedSlug: "ollama/glm", usage: { promptTokens: 1000, cachedTokens: 900, cacheWriteTokens: 0, completionTokens: 10, reasoningTokens: 0, images: 0, cachedEstimated: true } }));
		await ledger.record(entry({ usage: { promptTokens: 1000, cachedTokens: 500, cacheWriteTokens: 0, completionTokens: 10, reasoningTokens: 0, images: 0 } }));
		const r = await buildUsageReport(db, { windowDays: 7, nowMs: NOW });
		expect(r.totals.cacheEstimated).toBe(true);
		expect(r.providers.find((p) => p.key === "ollama")!.cacheEstimated).toBe(true);
		expect(r.providers.find((p) => p.key === "openrouter")!.cacheEstimated).toBe(false);
		const text = renderUsageReport(r);
		expect(text).toContain("(cache hit ~70%)");
		expect(text).toMatch(/ollama\s+1\s+\S+\s+\S+\s+~90%/);
		expect(text).toMatch(/openrouter\s+1\s+\S+\s+\S+\s+50%/);
		db.close();
	});

	test("renders every section as plain fixed-width text", async () => {
		const { db, ledger } = await seeded();
		await ledger.record(entry({ reportedUsd: 1.25, createdAtMs: NOW - HOUR }));
		await ledger.record(entry({ slug: "ollama/kimi", servedSlug: "ollama/kimi", tier: "hard", reportedUsd: 0.5, createdAtMs: NOW - 30 * HOUR }));
		const text = renderUsageReport(await buildUsageReport(db, { windowDays: 7, nowMs: NOW }));
		expect(text).toContain("last 7d");
		expect(text).toContain("spend $1.75 over 2 dispatches");
		expect(text).toContain("providers");
		expect(text).toContain("openrouter");
		expect(text).toContain("ollama/kimi");
		expect(text).toContain("tiers");
		expect(text).toContain("by day (UTC)");
		expect(text).toContain("2026-09-05");
		// No markdown or ANSI: it goes into a code block as-is.
		expect(text).not.toMatch(/[|*`]/);
		db.close();
	});

	test("caps the model table and says so", async () => {
		const { db, ledger } = await seeded();
		for (let i = 0; i < 5; i++) await ledger.record(entry({ slug: `v/m${i}`, servedSlug: `v/m${i}` }));
		const text = renderUsageReport(await buildUsageReport(db, { windowDays: 7, nowMs: NOW }), { maxModels: 2 });
		expect(text).toContain("models (top 2 of 5 by spend)");
		db.close();
	});
});

describe("digest re-runs and forecast accuracy", () => {
	test("wasted digest rows count as re-runs; forecast error is judged on clean kept rows only", async () => {
		const { db, ledger } = await seeded();
		try {
			await ledger.record(entry({ requestedModel: "digest", conversationKey: "d1", reportedUsd: 0.001, predictedUsd: 0.001 }));
			await ledger.record(entry({ requestedModel: "digest", conversationKey: "d2", reportedUsd: 0.001, predictedUsd: 0.001, wasted: true }));
			// Two clean turns: one predicted double, one predicted half.
			await ledger.record(entry({ predictedUsd: 0.02, reportedUsd: 0.01 }));
			await ledger.record(entry({ predictedUsd: 0.005, reportedUsd: 0.01 }));
			// Excluded from the forecast judgement: wasted, errored, no reported cost.
			await ledger.record(entry({ predictedUsd: 1, reportedUsd: 0.01, wasted: true }));
			await ledger.record(entry({ predictedUsd: 1, reportedUsd: 0.01, error: "upstream_error: 500" }));
			await ledger.record(entry({ predictedUsd: 1, reportedUsd: null }));
			const t = (await buildUsageReport(db, { windowDays: 1, nowMs: NOW })).totals;
			expect(t.digests).toBe(2);
			expect(t.digestReruns).toBe(1);
			expect(t.forecastSamples).toBe(2);
			expect(t.forecastMeanError).toBeCloseTo((1 + 0.5) / 2, 6);
			expect(t.forecastOverShare).toBeCloseTo(0.5, 6);
			const text = renderUsageReport(await buildUsageReport(db, { windowDays: 1, nowMs: NOW }));
			expect(text).toContain("re-run rate 50% (1 fetched again in full)");
			expect(text).toContain("forecast: mean error 75% of reported cost over 2 turns · 50% over-predicted");
		} finally {
			db.close();
		}
	});
});
