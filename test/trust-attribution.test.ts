import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateStore } from "../src/util/schema.ts";
import { num, openSqlDb } from "../src/util/sql.ts";
import { openDb } from "../src/util/sqlite.ts";
import { createFeedbackStore } from "../src/cost/feedback.ts";

import { loadConfig } from "../src/config/load.ts";
import { LATENCY_WINDOW_ROWS } from "../src/cost/ledger.ts";
import { createSqlLedger } from "../src/cost/ledger-sql.ts";
import { EMPTY_USAGE, type LedgerEntry } from "../src/cost/types.ts";
import { createConversationStore } from "../src/router/state.ts";

const cfg = loadConfig({});

function entry(over: Partial<LedgerEntry>): LedgerEntry {
	return {
		id: crypto.randomUUID(),
		createdAtMs: Date.now(),
		conversationKey: "k",
		sessionId: "omp-k",
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
		usage: EMPTY_USAGE,
		attempt: 0,
		escalationSignal: null,
		latencyMs: 100,
		ttftMs: 50,
		finishReason: "stop",
		wasted: false,
		upstreamGenerationId: null,
		error: null,
		promptTokensSaved: 0,
		...over,
	};
}

/**
 * Trust must reflect the MODEL's reliability. A client hanging up, an
 * account-level auth/policy refusal, or a guardrail excluding the endpoint say
 * nothing about model quality, and counting them shrinks the candidate pool
 * onto whichever models happened to avoid those conditions.
 */
describe("trust attribution", () => {
	async function trustAfter(errors: Array<string | null>): Promise<number> {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			for (const error of errors) await ledger.record(entry({ error }));
			const trust = await ledger.trust("vendor/model");
			expect(trust).not.toBeNull();
			return trust?.successRate ?? 0;
		} finally {
			await db.close();
		}
	}

	// A clean run's rate, recomputed per test: a describe body cannot await.
	const clean = async (): Promise<number> => await trustAfter([null, null, null, null]);

	test("client aborts do not count against the model", async () => {
		expect(await trustAfter([null, null, "request aborted", "request aborted"])).toBe((await clean()));
	});

	test("account-level auth refusals do not count against the model", async () => {
		expect(
			await trustAfter([
				null,
				null,
				"auth: No auth credentials found",
				"auth: Insufficient credits",
			]),
		).toBe((await clean()));
	});

	test("provider moderation/policy blocks do not count against the model", async () => {
		expect(
			await trustAfter([
				null,
				null,
				"moderation: Request blocked: prompt injection patterns detected",
				"moderation: This model requires 18+ age confirmation",
			]),
		).toBe((await clean()));
	});

	test("guardrail model_unavailable does not count against the model", async () => {
		expect(
			await trustAfter([null, null, "model_unavailable: No endpoints available matching your guardrail", null]),
		).toBeGreaterThan(0.7);
	});

	test("a genuine upstream error DOES count against the model", async () => {
		const withError = await trustAfter([null, null, "upstream_error: Upstream request failed", "upstream_error: boom"]);
		expect(withError).toBeLessThan((await clean()));
	});

	test("an unclassifiable legacy error stays attributable", async () => {
		// No "<kind>: " prefix and not the known abort text: we cannot prove it
		// was blameless, so it keeps counting (the stricter reading).
		const withError = await trustAfter([null, null, "something odd happened", "another"]);
		expect(withError).toBeLessThan((await clean()));
	});

	test("errors field still records the raw text regardless of attribution", async () => {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await ledger.record(entry({ error: "request aborted" }));
			const row = await db.one<{ error: string | null; error_kind: string | null }>(
				"SELECT error, error_kind FROM ledger",
			);
			expect(row).not.toBeNull();
			expect(row?.error).toBe("request aborted");
			expect(row?.error_kind).toBe("aborted");
		} finally {
			await db.close();
		}
	});

	test("escalations still count as failures independently of errors", async () => {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await ledger.record(entry({ error: null }));
			await ledger.record(entry({ error: null }));
			await ledger.record(entry({ escalationSignal: "empty_completion" }));
			const trust = await ledger.trust("vendor/model");
			expect(trust?.escalations).toBe(1);
			expect(trust?.successRate).toBeLessThan((await clean()));
		} finally {
			await db.close();
		}
	});

	test("aborted rows are still counted as attempts", async () => {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await ledger.record(entry({ error: "request aborted" }));
			await ledger.record(entry({ error: null }));
			expect((await ledger.trust("vendor/model"))?.attempts).toBe(2);
			// ...but not as errors.
			expect((await ledger.trust("vendor/model"))?.errors).toBe(0);
		} finally {
			await db.close();
		}
	});
});

describe("latency signal", () => {
	async function latencyOf(rows: Array<Partial<LedgerEntry>>): Promise<{ samples: number; ttftMs: number; tokensPerSec: number } | null> {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			for (const r of rows) await ledger.record(entry(r));
			const l = await ledger.latency("vendor/model");
			return l === null ? null : { samples: l.samples, ttftMs: l.ttftMs, tokensPerSec: l.tokensPerSec };
		} finally {
			await db.close();
		}
	}

	test("averages TTFT over streamed, non-errored turns", async () => {
		expect(await latencyOf([{ ttftMs: 50 }, { ttftMs: 100 }, { ttftMs: 150 }])).toEqual({ samples: 3, ttftMs: 100, tokensPerSec: 0 });
	});

	test("excludes errored, aborted, and non-streamed (null TTFT) rows", async () => {
		expect(
			await latencyOf([
				{ ttftMs: 100 },
				{ ttftMs: 9999, error: "upstream_error: boom" },
				{ ttftMs: 9999, error: "request aborted" },
				{ ttftMs: null },
			]),
		).toEqual({ samples: 1, ttftMs: 100, tokensPerSec: 0 });
	});

	test("null when no streamed sample exists", async () => {
		expect(await latencyOf([{ ttftMs: null }, { ttftMs: 0 }])).toBeNull();
	});

	test("throughput is aggregate completion tokens per post-TTFT second", async () => {
		const l = await latencyOf([
			{ ttftMs: 1000, latencyMs: 3000, usage: { ...EMPTY_USAGE, completionTokens: 200 } },
			{ ttftMs: 1000, latencyMs: 3000, usage: { ...EMPTY_USAGE, completionTokens: 200 } },
		]);
		// 400 completion tokens over 4000ms of post-TTFT time = 100 tok/s.
		expect(l?.tokensPerSec).toBeCloseTo(100, 5);
		expect(l?.samples).toBe(2);
	});

	test("throughput and ttft track a recent window, not the lifetime average", async () => {
		// Old rows are fast; the recent window is slow. Latency must reflect the
		// recent (slow) behaviour so a degraded model is penalised, not masked by
		// its history. Lifetime blend here would be ~57 tok/s; the window is 10.
		const rows: Array<Partial<LedgerEntry>> = [];
		let t = 1;
		for (let i = 0; i < 50; i++)
			rows.push({ createdAtMs: t++, ttftMs: 200, latencyMs: 1200, usage: { ...EMPTY_USAGE, completionTokens: 1000 } });
		for (let i = 0; i < LATENCY_WINDOW_ROWS; i++)
			rows.push({ createdAtMs: t++, ttftMs: 4000, latencyMs: 14000, usage: { ...EMPTY_USAGE, completionTokens: 100 } });
		const l = await latencyOf(rows);
		expect(l?.samples).toBe(LATENCY_WINDOW_ROWS);
		expect(l?.tokensPerSec).toBeCloseTo(10, 0);
		expect(l?.ttftMs).toBeCloseTo(4000, 5);
	});
});

describe("v4 migration", () => {
	test("backfills error_kind from stored error text", async () => {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await ledger.record(entry({ error: "request aborted" }));
			await ledger.record(entry({ error: "auth: nope" }));
			await ledger.record(entry({ error: "moderation: Request blocked: prompt injection" }));
			await ledger.record(entry({ error: "model_unavailable: guardrail" }));
			await ledger.record(entry({ error: "upstream_error: boom" }));
			await ledger.record(entry({ error: null }));

			const rows = (await db.query<unknown>("SELECT error, error_kind FROM ledger ORDER BY created_at_ms")) as Array<{ error: string | null; error_kind: string | null }>;
			expect(rows.map((r) => r.error_kind)).toEqual([
				"aborted",
				"auth",
				"moderation",
				"model_unavailable",
				"upstream_error",
				null,
			]);
		} finally {
			await db.close();
		}
	});

	test("a deferred upgrade tier survives a save/load round trip", async () => {
		const db = openSqlDb(join(tmpdir(), `trust-${process.pid}-${Date.now()}.db`));
		await migrateStore(db);
		const store = createConversationStore(db);
		const st = await store.load("conv-defer");
		st.upgradeDeferredTier = "hard";
		await store.save(st);
		expect((await store.load("conv-defer")).upgradeDeferredTier).toBe("hard");
		st.upgradeDeferredTier = null;
		await store.save(st);
		expect((await store.load("conv-defer")).upgradeDeferredTier).toBeNull();
		await db.close();
	});

	test("schema is at user_version 19", () => {
		// `PRAGMA user_version` is SQLite's own migration marker, so this reads
		// through the bootstrap handle rather than the engine-agnostic one.
		const path = join(tmpdir(), `uv-${process.pid}-${Date.now()}.db`);
		const db = openDb(path);
		try {
			// Our own pragma against our own file; the shape is fixed by SQLite.
			const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
			expect(row?.user_version).toBe(19);
		} finally {
			db.close();
		}
	});

	test("persists omp_session_id and returns it via recentEntries", async () => {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await ledger.record(entry({ ompSessionId: "sess-a" }));
			await ledger.record(entry({ ompSessionId: "" }));
			const got = (await ledger.recentEntries(10)).map((e) => e.ompSessionId).sort();
			expect(got).toEqual(["", "sess-a"]);
		} finally {
			await db.close();
		}
	});
});

describe("v6 classifier instrumentation", () => {
	const FEATURES = {
		promptTokens: 1234,
		isToolResultContinuation: true,
		toolLoopDepth: 3,
		complexityKeywords: ["race", "debug"],
	};

	test("round-trips the feature vector and classifier outputs", async () => {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await ledger.record(
				entry({
					features: FEATURES,
					score: 0.42,
					confidence: 0.75,
					task: "coding",
					classifierReasons: ["-0.28 tool-result continuation"],
				}),
			);

			const got = (await ledger.recentEntries(1))[0];
			expect(got?.features).toEqual(FEATURES);
			expect(got?.score).toBe(0.42);
			expect(got?.confidence).toBe(0.75);
			expect(got?.task).toBe("coding");
			expect(got?.classifierReasons).toEqual(["-0.28 tool-result continuation"]);
		} finally {
			await db.close();
		}
	});

	test("an uninstrumented row reads back as null, not as invented data", async () => {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await ledger.record(entry({}));
			const got = (await ledger.recentEntries(1))[0];
			expect(got?.features).toBeNull();
			expect(got?.score).toBeNull();
			expect(got?.confidence).toBeNull();
			expect(got?.task).toBeNull();
			expect(got?.classifierReasons).toBeNull();
		} finally {
			await db.close();
		}
	});

	test("records which tier exploration dropped from, and NULL otherwise", async () => {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await ledger.record(entry({ tier: "simple", exploredFrom: "moderate" }));
			await ledger.record(entry({ tier: "moderate" }));

			const got = await ledger.recentEntries(10);
			expect(got.map((e) => e.exploredFrom).sort()).toEqual(["moderate", null] as unknown as string[]);

			// The counterfactual query this whole column exists to make possible:
			// of the turns we deliberately under-routed, how many had to escalate?
			const counted = await db.one<{ n: unknown }>("SELECT COUNT(*) n FROM ledger WHERE explored_from IS NOT NULL");
			expect(num(counted?.n)).toBe(1);
		} finally {
			await db.close();
		}
	});
	test("features land in the column as queryable JSON", async () => {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await ledger.record(entry({ features: FEATURES, score: 0.9, confidence: 0.1, task: "vision" }));
			// SQLite json_extract proves the blob is real JSON, not a stringified object.
			// The blob is real JSON, not a stringified object: read a member back
			// through whichever accessor the engine uses.
			const row = await db.one<{ depth: unknown; score: unknown; task: string }>(
				`SELECT ${db.jsonNum("features", "toolLoopDepth")} AS depth, score, task FROM ledger`,
			);
			expect(num(row?.depth)).toBe(3);
			expect(num(row?.score)).toBe(0.9);
			expect(row?.task).toBe("vision");
		} finally {
			await db.close();
		}
	});
});

describe("cache reliability signal", () => {
	// Observed hit rate when a warm cache was expected: the previous kept turn
	// of the conversation was on the same model within the warm TTL.
	async function seed(rows: Array<Partial<LedgerEntry>>) {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		const ledger = createSqlLedger(db, cfg, { findModel: () => null });
		for (const r of rows) await ledger.record(entry(r));
		return { db, ledger };
	}
	const t0 = Date.UTC(2026, 8, 7, 12);
	const usage = (prompt: number, cached: number, estimated = false) => ({ ...EMPTY_USAGE, promptTokens: prompt, cachedTokens: cached, ...(estimated ? { cachedEstimated: true } : {}) });

	test("a model that hits when warm scores 1; one that misses scores 0; the first turn never counts", async () => {
		const { db, ledger } = await seed([
			{ conversationKey: "a", slug: "good/m", servedSlug: "good/m", createdAtMs: t0, usage: usage(50_000, 0) }, // first turn: no expectation
			{ conversationKey: "a", slug: "good/m", servedSlug: "good/m", createdAtMs: t0 + 60_000, usage: usage(60_000, 50_000) },
			{ conversationKey: "a", slug: "good/m", servedSlug: "good/m", createdAtMs: t0 + 120_000, usage: usage(70_000, 60_000) },
			{ conversationKey: "b", slug: "flaky/m", servedSlug: "flaky/m", createdAtMs: t0, usage: usage(50_000, 0) },
			{ conversationKey: "b", slug: "flaky/m", servedSlug: "flaky/m", createdAtMs: t0 + 60_000, usage: usage(60_000, 0) },
			{ conversationKey: "b", slug: "flaky/m", servedSlug: "flaky/m", createdAtMs: t0 + 120_000, usage: usage(70_000, 30_000) },
		]);
		expect((await ledger.cacheReliability(["good/m"])).get("good/m")).toEqual({ slug: "good/m", samples: 2, hitRate: 1 });
		const flaky = (await ledger.cacheReliability(["flaky/m"])).get("flaky/m");
		expect(flaky?.samples).toBe(2);
		expect(flaky?.hitRate).toBeCloseTo(0.25, 6); // (0 + 30k/60k) / 2
		expect((await ledger.cacheReliability(["never/m"])).has("never/m")).toBe(false);
		await db.close();
	});

	test("a switch, an idle gap past the TTL, or a router-estimated count is not a warm-expected sample", async () => {
		const { db, ledger } = await seed([
			{ conversationKey: "a", slug: "x/m", servedSlug: "x/m", createdAtMs: t0, usage: usage(50_000, 0) },
			{ conversationKey: "a", slug: "y/m", servedSlug: "y/m", createdAtMs: t0 + 60_000, usage: usage(60_000, 0) }, // switch
			{ conversationKey: "a", slug: "y/m", servedSlug: "y/m", createdAtMs: t0 + 60_000 + cfg.hysteresis.cacheWarmTtlMs + 1, usage: usage(70_000, 0) }, // gap
			{ conversationKey: "a", slug: "y/m", servedSlug: "y/m", createdAtMs: t0 + 60_000 + cfg.hysteresis.cacheWarmTtlMs + 2, usage: usage(80_000, 70_000, true) }, // estimated
		]);
		expect((await ledger.cacheReliability(["x/m"])).has("x/m")).toBe(false);
		expect((await ledger.cacheReliability(["y/m"])).has("y/m")).toBe(false);
		await db.close();
	});
});

describe("feedback in trust", () => {
	// A user verdict counts as filters.feedbackWeight attempts of that outcome.
	async function trustWith(weight: number, verdicts: Array<"good" | "bad">): Promise<{ rate: number; good: number; bad: number }> {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const c = structuredClone(cfg);
			c.filters.feedbackWeight = weight;
			const ledger = createSqlLedger(db, c, { findModel: () => null });
			const fb = createFeedbackStore(db);
			let last = "";
			for (let i = 0; i < 10; i++) {
				const e = entry({ error: null });
				last = e.id;
				await ledger.record(e);
			}
			for (const v of verdicts) {
				await fb.record({ ledgerId: last, ompSessionId: "s", slug: "vendor/model", tier: "simple", verdict: v, note: "" });
			}
			const trust = await ledger.trust("vendor/model");
			expect(trust).not.toBeNull();
			return { rate: trust?.successRate ?? 0, good: trust?.feedbackGood ?? -1, bad: trust?.feedbackBad ?? -1 };
		} finally {
			await db.close();
		}
	}

	test("weight 0 records verdicts without moving the rate", async () => {
		const base = await trustWith(0, []);
		expect(base.rate).toBeCloseTo(11 / 12, 6); // (10 - 0 + 1) / (10 + 2)
		expect((await trustWith(0, ["bad", "bad"])).rate).toBeCloseTo(base.rate, 6);
	});

	test("a bad verdict counts as `weight` failures, a good one as `weight` successes", async () => {
		// 10 clean attempts + one bad verdict at weight 3: attempts 13, failures 3.
		const bad = await trustWith(3, ["bad"]);
		expect(bad.rate).toBeCloseTo((13 - 3 + 1) / (13 + 2), 6);
		expect(bad.bad).toBe(1);
		const good = await trustWith(3, ["good"]);
		expect(good.rate).toBeCloseTo((13 - 0 + 1) / (13 + 2), 6);
		expect(good.good).toBe(1);
		// allTrust and signals agree with trust().
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		const c = structuredClone(cfg);
		c.filters.feedbackWeight = 3;
		const ledger = createSqlLedger(db, c, { findModel: () => null });
		const fb = createFeedbackStore(db);
		const e = entry({ error: null });
		await ledger.record(e);
		await fb.record({ ledgerId: e.id, ompSessionId: "s", slug: "vendor/model", tier: "simple", verdict: "bad", note: "" });
		// One reference rate: allTrust, trust and signals must agree on it.
		const rate = (await ledger.trust("vendor/model"))?.successRate ?? 0;
		expect((await ledger.allTrust())[0]?.successRate).toBeCloseTo(rate, 9);
		expect((await ledger.signals(["vendor/model"])).get("vendor/model")?.trust?.successRate).toBeCloseTo(rate, 9);
		await db.close();
	});
});

describe("task-scoped feedback (filters.feedbackByTask)", () => {
	test("a verdict counts only for its task type; an untasked verdict counts everywhere", async () => {
		const db = openSqlDb(join(tmpdir(), `t-trust-attribution.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const c = structuredClone(cfg);
			c.filters.feedbackWeight = 3;
			c.filters.feedbackByTask = true;
			const ledger = createSqlLedger(db, c, { findModel: () => null });
			const fb = createFeedbackStore(db);
			for (let i = 0; i < 10; i++) await ledger.record(entry({ error: null, task: "coding" }));
			const prose = entry({ error: null, task: "documentation" });
			await ledger.record(prose);
			const untasked = entry({ error: null, task: null });
			await ledger.record(untasked);
			await fb.record({ ledgerId: prose.id, ompSessionId: "s", slug: "vendor/model", tier: "simple", verdict: "bad", note: "" });
			// 12 clean attempts, weight 3, one bad verdict on a documentation turn.
			const pooled = (12 - 0 + 1) / (12 + 2);
			const withBad = (15 - 3 + 1) / (15 + 2);
			expect((await ledger.trust("vendor/model", undefined, "coding"))?.successRate).toBeCloseTo(pooled, 9);
			expect((await ledger.trust("vendor/model", undefined, "documentation"))?.successRate).toBeCloseTo(withBad, 9);
			// No task given (allTrust, reports): pooled behaviour, the verdict counts.
			expect((await ledger.trust("vendor/model"))?.successRate).toBeCloseTo(withBad, 9);
			expect((await ledger.allTrust())[0]?.successRate).toBeCloseTo(withBad, 9);
			// signals() honours the task the same way.
			expect((await ledger.signals(["vendor/model"], undefined, "coding")).get("vendor/model")!.trust!.successRate).toBeCloseTo(pooled, 9);
			// A verdict on a turn that recorded no task counts for every task.
			await fb.record({ ledgerId: untasked.id, ompSessionId: "s", slug: "vendor/model", tier: "simple", verdict: "bad", note: "" });
			expect((await ledger.trust("vendor/model", undefined, "coding"))?.successRate).toBeCloseTo(withBad, 9);
			// Off: task is ignored and every verdict pools.
			c.filters.feedbackByTask = false;
			expect((await ledger.trust("vendor/model", undefined, "coding"))?.successRate).toBeCloseTo((18 - 6 + 1) / (18 + 2), 9);
		} finally {
			await db.close();
		}
	});
});
