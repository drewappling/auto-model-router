import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createLedger } from "../src/cost/ledger.ts";
import type { LedgerEntry } from "../src/cost/types.ts";
import { openDb } from "../src/util/sqlite.ts";

/**
 * `filters.trustWindowDays` bounds the per-slug trust aggregate, which otherwise
 * scans every row a model ever had — on every candidate, on every turn. Measured
 * on a real ledger it grows from 0.8 ms at 9k rows to 11.6 ms at 75k, so it
 * becomes a per-turn latency tax as history accumulates.
 *
 * It defaults to 0 (all-time) because narrowing it CHANGES ROUTING: smaller
 * denominators move success rates, which moves the demotion guard. These tests
 * pin both halves of that contract — off is byte-identical to the old behaviour,
 * and on genuinely excludes old rows.
 */

const DAY = 86_400_000;

function cfgWith(trustWindowDays: number) {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.filters.trustWindowDays = trustWindowDays;
	cfg.ledger.path = ":memory:";
	return cfg;
}

function entry(over: Partial<LedgerEntry>): LedgerEntry {
	return {
		id: crypto.randomUUID(),
		createdAtMs: Date.now(),
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
		usage: { promptTokens: 10, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 5, reasoningTokens: 0, images: 0 },
		attempt: 0,
		escalationSignal: null,
		latencyMs: 100,
		ttftMs: 50,
		finishReason: "stop",
		wasted: false,
		upstreamGenerationId: null,
		error: null,
		errorKind: null,
		promptTokensSaved: null,
		...over,
	} as LedgerEntry;
}

/** Old rows: half of them failures. Recent rows: all clean. */
function seed(windowDays: number) {
	const cfg = cfgWith(windowDays);
	const db = openDb(":memory:");
	const ledger = createLedger(db, cfg);
	const now = Date.now();
	for (let i = 0; i < 10; i++) {
		ledger.record(
			entry({
				createdAtMs: now - 30 * DAY,
				...(i % 2 === 0 ? { error: "server_error: boom", errorKind: "server_error" } : {}),
			}),
		);
	}
	for (let i = 0; i < 10; i++) ledger.record(entry({ createdAtMs: now - 1 * DAY }));
	return { db, ledger, cfg };
}

describe("filters.trustWindowDays", () => {
	test("0 means all-time: every row counts", () => {
		const { db, ledger } = seed(0);
		const trust = ledger.trust("vendor/model");
		expect(trust?.attempts).toBe(20);
		expect(trust?.errors).toBe(5);
		db.close();
	});

	test("a window excludes rows older than it", () => {
		const { db, ledger } = seed(7);
		const trust = ledger.trust("vendor/model");
		// Only the 10 recent, clean rows remain.
		expect(trust?.attempts).toBe(10);
		expect(trust?.errors).toBe(0);
		db.close();
	});

	test("the window moves the success rate, which is why it is opt-in", () => {
		const all = seed(0);
		const windowed = seed(7);
		const allTrust = all.ledger.trust("vendor/model");
		const winTrust = windowed.ledger.trust("vendor/model");
		expect(allTrust?.successRate).toBeLessThan(winTrust?.successRate ?? 0);
		all.db.close();
		windowed.db.close();
	});

	test("is read per call, so a hot-reloaded edit takes effect immediately", () => {
		const { db, ledger, cfg } = seed(0);
		expect(ledger.trust("vendor/model")?.attempts).toBe(20);
		// Hot reload mutates the shared config object in place.
		cfg.filters.trustWindowDays = 7;
		expect(ledger.trust("vendor/model")?.attempts).toBe(10);
		db.close();
	});

	test("allTrust honours the same window", () => {
		const { db, ledger } = seed(7);
		const rows = ledger.allTrust();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.attempts).toBe(10);
		db.close();
	});

	test("ships disabled, so the default install is unchanged", () => {
		// DEFAULT_CONFIG, not loadConfig: loadConfig reads the machine's real
		// config.yml, which has broken this suite before.
		expect(DEFAULT_CONFIG.filters.trustWindowDays).toBe(0);
	});
});
