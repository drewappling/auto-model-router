import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { createFeedbackStore } from "../src/cost/feedback.ts";
import { createLedger } from "../src/cost/ledger.ts";
import { createRetentionRunner, RETENTION_INTERVAL_MS } from "../src/cost/retention.ts";
import { EMPTY_USAGE, type Ledger, type LedgerEntry, type PruneResult } from "../src/cost/types.ts";
import { startServer, type StartedServer } from "../src/server/http.ts";
import { openDb } from "../src/util/sqlite.ts";

/**
 * Ledger retention: how long turns are kept, what goes with them, and the
 * route a front door asks through — the team edition holds a read-only handle
 * on the ledger and must never delete from it itself.
 */

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

function entry(over: Partial<LedgerEntry>): LedgerEntry {
	return {
		id: crypto.randomUUID(),
		createdAtMs: NOW,
		conversationKey: "conv",
		sessionId: "sess",
		turn: 1,
		requestedModel: "auto",
		harnessId: "",
		ompSessionId: "omp-1",
		slug: "a/b",
		servedSlug: "a/b",
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
		usage: { ...EMPTY_USAGE, promptTokens: 100, completionTokens: 10 },
		attempt: 0,
		escalationSignal: null,
		latencyMs: 10,
		ttftMs: 5,
		finishReason: "stop",
		wasted: false,
		upstreamGenerationId: null,
		error: null,
		promptTokensSaved: 0,
		...over,
	};
}

function seeded(path = ":memory:", base = NOW): { db: ReturnType<typeof openDb>; ledger: Ledger; ids: string[] } {
	const db = openDb(path);
	const cfg: RouterConfig = { ...DEFAULT_CONFIG, ledger: { ...DEFAULT_CONFIG.ledger, path } };
	const ledger = createLedger(db, cfg);
	// 400, 200 and 1 days old.
	const ids = [400, 200, 1].map((age) => {
		const e = entry({ createdAtMs: base - age * DAY });
		ledger.record(e);
		return e.id;
	});
	return { db, ledger, ids };
}

describe("prune", () => {
	test("rows past the window go, newer ones stay, and the oldest kept is reported", () => {
		const { db, ledger } = seeded();
		try {
			expect(ledger.prune?.(365, NOW)).toEqual({ deleted: 1, oldestKeptMs: NOW - 200 * DAY });
			expect(ledger.recentEntries(10)).toHaveLength(2);
			expect(ledger.prune?.(30, NOW)).toEqual({ deleted: 1, oldestKeptMs: NOW - DAY });
			expect(ledger.recentEntries(10)).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	test("a null window (the default) deletes nothing, and neither does 0", () => {
		const { db, ledger } = seeded();
		try {
			expect(DEFAULT_CONFIG.ledger.retentionDays).toBeNull();
			expect(ledger.prune?.(null, NOW)).toEqual({ deleted: 0, oldestKeptMs: NOW - 400 * DAY });
			expect(ledger.prune?.(0, NOW)).toEqual({ deleted: 0, oldestKeptMs: NOW - 400 * DAY });
			expect(ledger.recentEntries(10)).toHaveLength(3);
		} finally {
			db.close();
		}
	});

	test("feedback keyed to a deleted turn goes with it; a verdict on a kept turn stays", () => {
		const { db, ledger, ids } = seeded();
		try {
			const feedback = createFeedbackStore(db);
			const [old, mid, recent] = ids as [string, string, string];
			feedback.record({ ledgerId: old, ompSessionId: "omp-1", slug: "a/b", tier: "simple", verdict: "bad", note: "" }, NOW - 400 * DAY);
			feedback.record({ ledgerId: mid, ompSessionId: "omp-1", slug: "a/b", tier: "simple", verdict: "good", note: "" }, NOW - 200 * DAY);
			feedback.record({ ledgerId: recent, ompSessionId: "omp-1", slug: "a/b", tier: "simple", verdict: "good", note: "" }, NOW - DAY);
			expect(ledger.prune?.(365, NOW)?.deleted).toBe(1);
			expect(feedback.forLedgerId(old)).toHaveLength(0);
			expect(feedback.forLedgerId(mid)).toHaveLength(1);
			expect(feedback.forLedgerId(recent)).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	test("ollama meter samples age out with the rows they calibrate", () => {
		const { db, ledger } = seeded();
		try {
			db.run("INSERT INTO ollama_meter_samples (at_ms, meter_usd, ledger_usd) VALUES (?, 1, 1), (?, 2, 2)", [NOW - 400 * DAY, NOW - DAY]);
			ledger.prune?.(365, NOW);
			expect((db.query("SELECT COUNT(*) AS n FROM ollama_meter_samples").get() as { n: number }).n).toBe(1);
		} finally {
			db.close();
		}
	});

	test("an empty ledger reports no oldest row rather than a cutoff of its own", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, { ...DEFAULT_CONFIG, ledger: { ...DEFAULT_CONFIG.ledger, path: ":memory:" } });
			expect(ledger.prune?.(30, NOW)).toEqual({ deleted: 0, oldestKeptMs: null });
		} finally {
			db.close();
		}
	});
});

describe("the schedule", () => {
	function counting(): { ledger: Ledger; runs: number[] } {
		const runs: number[] = [];
		const ledger = {
			prune: (_days: number | null, nowMs?: number): PruneResult => {
				runs.push(nowMs ?? 0);
				return { deleted: 1, oldestKeptMs: null };
			},
		} as unknown as Ledger;
		return { ledger, runs };
	}

	test("the scheduled path runs at most once an hour, however often it is asked", () => {
		const { ledger, runs } = counting();
		const runner = createRetentionRunner({ ledger, retentionDays: () => 30 });
		// The first call is always due, so a lowered window applies at boot.
		expect(runner.maybeRun(NOW)?.deleted).toBe(1);
		// A minute timer ticking for an hour must not re-run it.
		for (let t = 60_000; t < RETENTION_INTERVAL_MS; t += 60_000) expect(runner.maybeRun(NOW + t)).toBeNull();
		expect(runs).toEqual([NOW]);
		expect(runner.maybeRun(NOW + RETENTION_INTERVAL_MS)?.deleted).toBe(1);
		expect(runs).toEqual([NOW, NOW + RETENTION_INTERVAL_MS]);
	});

	test("an explicit run always happens, and satisfies the schedule for the next hour", () => {
		const { ledger, runs } = counting();
		const runner = createRetentionRunner({ ledger, retentionDays: () => 30 });
		runner.runNow(NOW);
		runner.runNow(NOW + 1_000);
		expect(runs).toEqual([NOW, NOW + 1_000]);
		expect(runner.maybeRun(NOW + 2_000)).toBeNull();
		expect(runner.maybeRun(NOW + 1_000 + RETENTION_INTERVAL_MS)).not.toBeNull();
	});

	test("the window is read live, so a hot reload applies on the next run", () => {
		let days: number | null = null;
		const { ledger, runs } = counting();
		const runner = createRetentionRunner({ ledger, retentionDays: () => days });
		expect(runner.retentionDays()).toBeNull();
		days = 7;
		runner.runNow(NOW);
		expect(runner.retentionDays()).toBe(7);
		expect(runs).toHaveLength(1);
	});
});

describe("POST /v1/router/prune", () => {
	let handle: StartedServer;
	let baseUrl = "";
	let dir = "";
	let dbPath = "";
	// The route prunes against the real clock, so the fixture rows are placed
	// relative to it rather than to the fixed NOW the unit tests use.
	const realNow = Date.now();

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "amr-retention-"));
		dbPath = join(dir, "router.db");
		const { db } = seeded(dbPath, realNow);
		db.close();
		const cfg: RouterConfig = {
			...structuredClone(DEFAULT_CONFIG),
			server: { host: "127.0.0.1", port: 0, maxConcurrentTurns: 24, subagentProfile: "auto-sub" },
			ledger: { ...DEFAULT_CONFIG.ledger, path: dbPath, retentionDays: 365 },
			logLevel: "silent",
		};
		handle = startServer(cfg);
		baseUrl = `http://127.0.0.1:${handle.server.port}`;
	});

	afterAll(async () => {
		await handle.stop();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows holds the file until the statements are collected; the temp dir is disposable.
		}
	});

	test("the route deletes past the configured window and answers the counts", async () => {
		const res = await fetch(`${baseUrl}/v1/router/prune`, { method: "POST" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { deleted: number; oldestKeptMs: number | null; retentionDays: number | null };
		expect(body.deleted).toBe(1); // the 400-day-old row
		expect(body.oldestKeptMs).toBe(realNow - 200 * DAY);
		expect(body.retentionDays).toBe(365);
		// The rows are really gone from the file, not just from a view.
		const db = openDb(dbPath);
		try {
			expect((db.query("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n).toBe(2);
		} finally {
			db.close();
		}
	});

	test("a second call is idempotent: nothing left to delete, same oldest row", async () => {
		const body = (await (await fetch(`${baseUrl}/v1/router/prune`, { method: "POST" })).json()) as PruneResult;
		expect(body).toMatchObject({ deleted: 0, oldestKeptMs: realNow - 200 * DAY });
	});

	test("GET is not the prune route", async () => {
		expect((await fetch(`${baseUrl}/v1/router/prune`)).status).toBe(404);
	});
});
