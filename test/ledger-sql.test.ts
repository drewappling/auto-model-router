/**
 * The unified ledger, on every engine it claims to support.
 *
 * SQLite runs always (a temp file); Postgres runs when AMR_ROUTER_TEST_PG
 * points at one, following the team edition's convention for store tests. The
 * same assertions run against both, because the reason this implementation
 * replaced two backends is that two implementations of one meaning drift
 * silently — a `SUM()` read as a string skewed a trust score by three points,
 * and a double-encoded JSON column made an escalation-cost term null, both
 * without raising anything.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { createSqlLedger } from "../src/cost/ledger-sql.ts";
import { createConversationStore } from "../src/router/state.ts";
import { migrateStore } from "../src/util/schema.ts";
import type { AsyncLedger, LedgerEntry } from "../src/cost/types.ts";
import { openSqlDb, type SqlDb } from "../src/util/sql.ts";

const DAY_MS = 86_400_000;
const PG = process.env.AMR_ROUTER_TEST_PG;

const engines: { name: string; url: string }[] = [
	{ name: "sqlite", url: `sqlite://${join(tmpdir(), `ledger-sql-${process.pid}-${Date.now()}.db`)}` },
	...(PG === undefined ? [] : [{ name: "postgres", url: PG }]),
];

function cfgWith(over: Partial<RouterConfig["filters"]> = {}): RouterConfig {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.filters = { ...cfg.filters, trustWindowDays: 0, feedbackWeight: 1, ...over };
	return cfg;
}

function entry(over: Partial<LedgerEntry> & { id: string; slug: string }): LedgerEntry {
	return {
		createdAtMs: Date.now(),
		conversationKey: `conv-${over.id}`,
		// `LedgerEntry.sessionId` is a string and the column is NOT NULL: a null
		// here only ever passed because the second bootstrap declared the column
		// laxer than the nineteen shipped migrations do.
		sessionId: `sess-${over.id}`,
		turn: 1,
		requestedModel: "auto",
		harnessId: "",
		ompSessionId: "",
		servedSlug: over.slug,
		tier: "simple",
		classificationSource: "forced",
		reasons: ["because"],
		predictedUsd: 0,
		reportedUsd: null,
		usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, images: 0 },
		attempt: 0,
		escalationSignal: null,
		latencyMs: 100,
		ttftMs: 50,
		finishReason: "stop",
		wasted: false,
		upstreamGenerationId: null,
		error: null,
		features: null,
		score: null,
		confidence: null,
		task: null,
		classifierReasons: null,
		exploredFrom: null,
		holdArm: null,
		promptTokensSaved: null,
		...over,
	} as LedgerEntry;
}

for (const engine of engines) {
	describe(`ledger on ${engine.name}`, () => {
		// ONE handle per engine. A `SqlDb` is a connection pool, and opening one
		// per test exhausts a default Postgres (`sorry, too many clients
		// already`) — the same limit a host packed with many small tenants hits.
		let db: SqlDb;

		beforeAll(async () => {
			db = openSqlDb(engine.url);
			await migrateStore(db);
		});

		afterAll(async () => {
			await db.close();
		});

		// Tables are emptied rather than dropped: these tests assert over global
		// aggregates (allTrust, recentEntries, unscoped spend), so leftovers from
		// a neighbour would couple them.
		beforeEach(async () => {
			for (const table of ["ledger", "feedback", "token_calibration", "ollama_meter_samples"]) {
				await db.sql.unsafe(`DELETE FROM ${table}`);
			}
		});

		const setup = async (cfg = cfgWith()): Promise<{ db: SqlDb; ledger: AsyncLedger }> => ({
			db,
			ledger: createSqlLedger(db, cfg, { findModel: () => null }),
		});

		test("a write is visible to a second handle on the same store, so a shared cap holds", async () => {
			const cfg = cfgWith();
			const { db, ledger: a } = await setup(cfg);
			// A second ledger over the same store is what a second router replica
			// is. With a per-process file, B would read 0 for A's spend.
			const b = createSqlLedger(db, cfg, { findModel: () => null });

			expect(await b.spendSince(0, "h1")).toBe(0);
			await a.record(entry({ id: "a1", slug: "x/m", harnessId: "h1", predictedUsd: 4 }));
			expect(await b.spendSince(0, "h1")).toBeCloseTo(4, 9);

			await b.record(entry({ id: "b1", slug: "x/m", harnessId: "h1", predictedUsd: 3 }));
			// $7 between them breaches a $5 cap that neither replica's own share
			// would have reached.
			expect(await a.spendSince(0, "h1")).toBeCloseTo(7, 9);

			// Harness scoping still isolates one user's spend from another's.
			await a.record(entry({ id: "a2", slug: "x/m", harnessId: "h2", predictedUsd: 50 }));
			expect(await b.spendSince(0, "h1")).toBeCloseTo(7, 9);
			expect(await b.spendSince(0)).toBeCloseTo(57, 9);
		});

		test("reported spend beats predicted, and a window excludes older rows", async () => {
			const { ledger } = await setup(cfgWith());
			await ledger.record(entry({ id: "w1", slug: "y/m", harnessId: "hw", predictedUsd: 1, reportedUsd: 9 }));
			await ledger.record(entry({ id: "w2", slug: "y/m", harnessId: "hw", predictedUsd: 2, createdAtMs: Date.now() - 3 * DAY_MS }));
			expect(await ledger.spendSince(0, "hw")).toBeCloseTo(11, 9);
			expect(await ledger.spendSince(Date.now() - DAY_MS, "hw")).toBeCloseTo(9, 9);
			expect(await ledger.conversationSpend("conv-w1")).toBeCloseTo(9, 9);
		});

		test("trust counts escalations and upstream errors but forgives client aborts", async () => {
			const { ledger } = await setup(cfgWith());
			const slug = "t/model";
			for (let i = 0; i < 6; i++) await ledger.record(entry({ id: `t${i}`, slug, harnessId: "ht" }));
			await ledger.record(entry({ id: "te1", slug, harnessId: "ht", escalationSignal: "probe_failed" }));
			await ledger.record(entry({ id: "te2", slug, harnessId: "ht", error: "upstream_5xx: boom" }));
			// An aborted turn is the client's doing, not the model's: errorKindOf
			// recovers the kind and ATTRIBUTABLE_ERROR excludes that set
			// ('aborted', 'auth', 'moderation', 'model_unavailable', 'quota').
			await ledger.record(entry({ id: "te3", slug, harnessId: "ht", error: "request aborted" }));

			const trust = await ledger.trust(slug, "ht");
			expect(trust?.attempts).toBe(9);
			expect(trust?.escalations).toBe(1);
			expect(trust?.errors).toBe(1);
			// Numbers, not Postgres' aggregate strings: toTrust does arithmetic on
			// these, so a string skews the score instead of failing.
			expect(typeof trust?.attempts).toBe("number");
			expect(typeof trust?.successRate).toBe("number");
			expect(trust?.successRate).toBeGreaterThan(0.5);
			expect(trust?.successRate).toBeLessThan(1);

			const all = await ledger.allTrust();
            expect(all.find((t) => t.slug === slug)?.attempts).toBe(9);
		});

		test("signals batch trust and latency for a candidate set", async () => {
			const { ledger } = await setup(cfgWith({ latencyMinSamples: 1 }));
			await ledger.record(entry({ id: "s1", slug: "a/one", harnessId: "hs", ttftMs: 100, latencyMs: 1100 }));
			await ledger.record(entry({ id: "s2", slug: "a/one", harnessId: "hs", ttftMs: 300, latencyMs: 1300 }));
			// Errored rows carry no usable timing and must not drag the mean.
			await ledger.record(entry({ id: "s3", slug: "a/one", harnessId: "hs", ttftMs: 9000, latencyMs: 9900, error: "upstream_5xx: x" }));
			await ledger.record(entry({ id: "s4", slug: "b/two", harnessId: "hs", ttftMs: 40, latencyMs: 540 }));

			const signals = await ledger.signals(["a/one", "b/two", "c/absent"], "hs");
			expect(signals.get("a/one")?.latency?.samples).toBe(2);
			expect(signals.get("a/one")?.latency?.ttftMs).toBeCloseTo(200, 6);
			expect(signals.get("a/one")?.latency?.tokensPerSec).toBeGreaterThan(0);
			expect(signals.get("b/two")?.trust?.attempts).toBe(1);
			// A slug the ledger has never seen yields an entry with no signals,
			// not a missing key: candidate scoring reads it either way.
			expect(signals.get("c/absent")).toEqual({ trust: null, latency: null });
			expect(await ledger.latency("b/two", "hs")).not.toBeNull();
		});

		test("escalation cost needs enough samples before it reports a rate", async () => {
			const cfg = cfgWith();
			const { db, ledger } = await setup(cfg);
			for (let i = 0; i < 4; i++) {
				await ledger.record(entry({ id: `e${i}`, slug: "e/model", harnessId: "he", attempt: 1, predictedUsd: 1 }));
			}
			expect(await ledger.escalationCost(30)).toBeNull();

			for (let i = 4; i < 14; i++) {
				await ledger.record(entry({ id: `e${i}`, slug: "e/model", harnessId: "he", attempt: 1, predictedUsd: 1 }));
			}
			// A fresh handle: the result is memoised per instance for a minute.
			const fresh = createSqlLedger(db, cfg, { findModel: () => null });
			const cost = await fresh.escalationCost(30);
			expect(cost?.samples).toBe(14);
			// 14 rows × $1 over 14 × 100 prompt tokens. Reads inside the usage
			// JSON, which yields NULL when the column is stored double-encoded.
			expect(cost?.usdPerPromptToken).toBeCloseTo(0.01, 9);
		});

		test("entries round-trip, including the JSON columns", async () => {
			const { ledger } = await setup(cfgWith());
			await ledger.record(
				entry({
					id: "r1",
					slug: "r/model",
					harnessId: "hr",
					ompSessionId: "sess-1",
					reasons: ["cheapest", "warm cache"],
					classifierReasons: ["short prompt"],
					usage: { promptTokens: 11, completionTokens: 22, cachedTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5, images: 0 },
					scope: "team/proj",
					redactions: 0,
				}),
			);
			const recent = await ledger.recentEntries(5);
			const row = recent.find((e) => e.id === "r1");
			expect(row?.reasons).toEqual(["cheapest", "warm cache"]);
			expect(row?.classifierReasons).toEqual(["short prompt"]);
			expect(row?.usage.promptTokens).toBe(11);
			expect(row?.usage.cachedTokens).toBe(3);
			expect(row?.scope).toBe("team/proj");
			expect(row?.redactions).toBe(0);
			expect(row?.wasted).toBe(false);

			expect((await ledger.latestForSession("sess-1"))?.id).toBe("r1");
			expect((await ledger.entriesForSession("sess-1", 3)).length).toBe(1);
			// A wasted row is excluded from the session view.
			await ledger.markWasted("r1");
			expect(await ledger.latestForSession("sess-1")).toBeNull();
		});

		test("prune deletes past retention, keeps newer rows, and reports the oldest kept", async () => {
			const { ledger } = await setup(cfgWith());
			await ledger.record(entry({ id: "p_old", slug: "p/m", harnessId: "hp", predictedUsd: 5, createdAtMs: Date.now() - 10 * DAY_MS }));
			await ledger.record(entry({ id: "p_new", slug: "p/m", harnessId: "hp", predictedUsd: 7 }));
			expect(await ledger.spendSince(0, "hp")).toBeCloseTo(12, 9);

			// null and 0 both mean "keep everything", and still report the age.
			expect((await ledger.prune(null)).deleted).toBe(0);
			expect((await ledger.prune(0)).oldestKeptMs).not.toBeNull();

			const result = await ledger.prune(1);
			expect(result.deleted).toBe(1);
			expect(await ledger.spendSince(0, "hp")).toBeCloseTo(7, 9);
		});

		test("provider spend matches on the served slug's prefix", async () => {
			const { ledger } = await setup(cfgWith());
			await ledger.record(entry({ id: "pv1", slug: "ollama/glm", harnessId: "hv", predictedUsd: 2 }));
			await ledger.record(entry({ id: "pv2", slug: "openrouter/glm", harnessId: "hv", predictedUsd: 5 }));
			// Attribution follows served_slug, which is what actually billed.
			await ledger.record(entry({ id: "pv3", slug: "auto", servedSlug: "ollama/other", harnessId: "hv", predictedUsd: 1 }));
			expect(await ledger.providerSpendSince("ollama/", 0)).toBeCloseTo(3, 9);
		});

		test("soft-failure spikes need a rate, a floor of failures, and a worse-than-baseline ratio", async () => {
			const { ledger } = await setup(cfgWith());
			const now = Date.now();
			const recentMs = 15 * 60_000;
			const baselineMs = 6 * 60 * 60_000;
			// Baseline: healthy. Recent: mostly failing. Enough of both to clear
			// SPIKE_MIN_DISPATCHES and SPIKE_MIN_FAILURES.
			for (let i = 0; i < 20; i++) {
				await ledger.record(entry({ id: `sb${i}`, slug: "sp/model", createdAtMs: now - recentMs - 60_000 }));
			}
			for (let i = 0; i < 6; i++) {
				await ledger.record(entry({ id: `sr${i}`, slug: "sp/model", createdAtMs: now - 60_000, error: "upstream_5xx: boom" }));
			}
			const spikes = await ledger.softFailureSpikes(now, recentMs, baselineMs);
			const spike = spikes.find((s) => s.slug === "sp/model");
			expect(spike?.recentFailures).toBe(6);
			expect(spike?.recentRate).toBeCloseTo(1, 6);
			expect(spike?.baselineRate).toBeCloseTo(0, 6);
		});

		test("token calibration accumulates and stays unreported until enough samples", async () => {
			const { ledger } = await setup(cfgWith());
			// No pending estimate was registered for these conversations, so
			// nothing calibrates: the ratio must stay unknown rather than guess.
			await ledger.record(entry({ id: "c1", slug: "cal/model" }));
			expect(await ledger.tokenRatio("gpt")).toBeNull();
		});

		test("blended rate stays null until the window has enough priced samples", async () => {
			const { ledger } = await setup(cfgWith());
			// findModel returns null here, so no cost_breakdown is written and the
			// blend has nothing to apportion — null, not a fabricated rate.
			await ledger.record(entry({ id: "bl1", slug: "bl/model", reportedUsd: 1 }));
			expect(await ledger.blendedRate(30)).toBeNull();
		});

		// Two replicas, one store. Everything below is about a SECOND handle
		// seeing what the first one wrote, because that is what a cap and a warm
		// cache depend on once the store stops being a local file.
		test("a concurrent bootstrap does not lose the race", async () => {
			// `CREATE TABLE IF NOT EXISTS` is not atomic on Postgres: two replicas
			// booting together both pass the existence check, and the loser used
			// to die on the unique index over pg_type. Measured: one of two
			// replicas started at once exited with "duplicate key value violates
			// unique constraint pg_type_typname_nsp_index".
			const url = engine.name === "sqlite" ? `sqlite://${join(tmpdir(), `boot-race-${process.pid}-${Date.now()}.db`)}` : engine.url;
			const a = openSqlDb(url);
			const b = openSqlDb(url);
			try {
				await Promise.all([migrateStore(a), migrateStore(b)]);
				// Both handles land on a usable store, not a half-created one.
				for (const handle of [a, b]) await handle.sql.unsafe("SELECT COUNT(*) FROM ledger");
			} finally {
				await a.close();
				await b.close();
			}
		});

		test("a second handle reads the spend and the warm conversation the first one wrote", async () => {
			// The fixture bootstraps the ledger's own tables; the conversation
			// store is the other half of the shared state.
			await migrateStore(db);
			const writer = createSqlLedger(db, cfgWith(), { findModel: () => null });
			const writerConvs = createConversationStore(db);
			const now = Date.now();
			await writer.record(entry({ id: "sh1", slug: "warm/model", harnessId: "u_a", reportedUsd: 0.25, createdAtMs: now }));
			const state = await writerConvs.load("shared-conv");
			state.currentSlug = "warm/model";
			state.currentTier = "moderate";
			state.cacheWarmSlug = "warm/model";
			state.cacheWarmAtMs = now;
			state.turn = 1;
			await writerConvs.save(state);

			// A replica that has never seen this conversation or this spend.
			const reader = createSqlLedger(db, cfgWith(), { findModel: () => null });
			const readerConvs = createConversationStore(db);
			expect(await reader.spendSince(0)).toBeCloseTo(0.25, 9);
			expect(await reader.spendSince(0, "u_a")).toBeCloseTo(0.25, 9);
			const seen = await readerConvs.load("shared-conv");
			expect([seen.turn, seen.currentSlug, seen.currentTier, seen.cacheWarmSlug]).toEqual([1, "warm/model", "moderate", "warm/model"]);
		});
	});
}
