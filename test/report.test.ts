import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createLedger } from "../src/cost/ledger.ts";
import { buildUsageReport, renderUsageReport } from "../src/cost/report.ts";
import type { LedgerEntry } from "../src/cost/types.ts";
import { openDb } from "../src/util/sqlite.ts";

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

function seeded() {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.ledger.path = ":memory:";
	const db = openDb(":memory:");
	const ledger = createLedger(db, cfg);
	return { db, ledger };
}

describe("buildUsageReport", () => {
	test("totals, providers, models and tiers over a mixed window", () => {
		const { db, ledger } = seeded();
		// Two OpenRouter turns on one model (one with a warm cache), one Ollama
		// turn served by a different slug than decided, one escalation, one error.
		ledger.record(entry({ conversationKey: "a", turn: 1, reportedUsd: 0.01 }));
		ledger.record(
			entry({
				conversationKey: "a",
				turn: 2,
				reportedUsd: 0.005,
				usage: { promptTokens: 1000, cachedTokens: 800, cacheWriteTokens: 0, completionTokens: 100, reasoningTokens: 0, images: 0 },
			}),
		);
		ledger.record(
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
		ledger.record(entry({ conversationKey: "c", tier: "hard", escalationSignal: "refusal", wasted: true, reportedUsd: 0.002 }));
		ledger.record(entry({ conversationKey: "c", tier: "hard", error: "request aborted", reportedUsd: 0, ttftMs: null }));

		const r = buildUsageReport(db, { windowDays: 7, nowMs: NOW });
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

	test("counts a model switch only between consecutive kept rows of one conversation", () => {
		const { db, ledger } = seeded();
		ledger.record(entry({ conversationKey: "a", turn: 1, slug: "x/one", createdAtMs: NOW - 3 * HOUR }));
		ledger.record(entry({ conversationKey: "a", turn: 2, slug: "x/two", createdAtMs: NOW - 2 * HOUR }));
		ledger.record(entry({ conversationKey: "a", turn: 3, slug: "x/two", createdAtMs: NOW - 1 * HOUR }));
		// A wasted probe on another slug is not a switch.
		ledger.record(entry({ conversationKey: "a", turn: 3, slug: "x/three", wasted: true, createdAtMs: NOW - 1 * HOUR + 1 }));
		// A different conversation starting on another model is not a switch either.
		ledger.record(entry({ conversationKey: "b", turn: 1, slug: "x/three", createdAtMs: NOW - HOUR }));
		const r = buildUsageReport(db, { windowDays: 1, nowMs: NOW });
		expect(r.totals.modelSwitches).toBe(1);
		db.close();
	});

	test("window and harness scope exclude rows", () => {
		const { db, ledger } = seeded();
		ledger.record(entry({ harnessId: "omp", createdAtMs: NOW - HOUR }));
		ledger.record(entry({ harnessId: "hermes", createdAtMs: NOW - HOUR }));
		ledger.record(entry({ harnessId: "omp", createdAtMs: NOW - 10 * 24 * HOUR }));
		expect(buildUsageReport(db, { windowDays: 7, nowMs: NOW }).totals.dispatches).toBe(2);
		expect(buildUsageReport(db, { windowDays: 30, nowMs: NOW }).totals.dispatches).toBe(3);
		const scoped = buildUsageReport(db, { windowDays: 30, harnessId: "omp", nowMs: NOW });
		expect(scoped.totals.dispatches).toBe(2);
		expect(scoped.harnessId).toBe("omp");
		db.close();
	});

	test("empty ledger yields zeroed totals and null speeds", () => {
		const { db } = seeded();
		const r = buildUsageReport(db, { windowDays: 7, nowMs: NOW });
		expect(r.totals).toEqual({
			dispatches: 0,
			conversations: 0,
			spendUsd: 0,
			cacheHitRate: 0,
			promptTokens: 0,
			completionTokens: 0,
			escalations: 0,
			failovers: 0,
			errors: 0,
			aborted: 0,
			modelSwitches: 0,
		});
		expect(r.providers).toEqual([]);
		expect(r.models).toEqual([]);
		db.close();
	});

	test("speed ignores errored and non-streamed rows", () => {
		const { db, ledger } = seeded();
		ledger.record(entry({ ttftMs: null }));
		ledger.record(entry({ error: "boom" }));
		const r = buildUsageReport(db, { windowDays: 7, nowMs: NOW });
		expect(r.providers[0]!.avgTtftMs).toBeNull();
		expect(r.providers[0]!.tokensPerSec).toBeNull();
		db.close();
	});
});

describe("renderUsageReport", () => {
	test("renders every section as plain fixed-width text", () => {
		const { db, ledger } = seeded();
		ledger.record(entry({ reportedUsd: 1.25, createdAtMs: NOW - HOUR }));
		ledger.record(entry({ slug: "ollama/kimi", servedSlug: "ollama/kimi", tier: "hard", reportedUsd: 0.5, createdAtMs: NOW - 30 * HOUR }));
		const text = renderUsageReport(buildUsageReport(db, { windowDays: 7, nowMs: NOW }));
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

	test("caps the model table and says so", () => {
		const { db, ledger } = seeded();
		for (let i = 0; i < 5; i++) ledger.record(entry({ slug: `v/m${i}`, servedSlug: `v/m${i}` }));
		const text = renderUsageReport(buildUsageReport(db, { windowDays: 7, nowMs: NOW }), { maxModels: 2 });
		expect(text).toContain("models (top 2 of 5 by spend)");
		db.close();
	});
});
