import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config/load.ts";
import { createLedger, LATENCY_WINDOW_ROWS } from "../src/cost/ledger.ts";
import { EMPTY_USAGE, type LedgerEntry } from "../src/cost/types.ts";
import { openDb } from "../src/util/sqlite.ts";

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
	function trustAfter(errors: Array<string | null>): number {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			for (const error of errors) ledger.record(entry({ error }));
			const trust = ledger.trust("vendor/model");
			expect(trust).not.toBeNull();
			return trust?.successRate ?? 0;
		} finally {
			db.close();
		}
	}

	const CLEAN = trustAfter([null, null, null, null]);

	test("client aborts do not count against the model", () => {
		expect(trustAfter([null, null, "request aborted", "request aborted"])).toBe(CLEAN);
	});

	test("account-level auth refusals do not count against the model", () => {
		expect(
			trustAfter([
				null,
				null,
				"auth: No auth credentials found",
				"auth: Insufficient credits",
			]),
		).toBe(CLEAN);
	});

	test("provider moderation/policy blocks do not count against the model", () => {
		expect(
			trustAfter([
				null,
				null,
				"moderation: Request blocked: prompt injection patterns detected",
				"moderation: This model requires 18+ age confirmation",
			]),
		).toBe(CLEAN);
	});

	test("guardrail model_unavailable does not count against the model", () => {
		expect(
			trustAfter([null, null, "model_unavailable: No endpoints available matching your guardrail", null]),
		).toBeGreaterThan(0.7);
	});

	test("a genuine upstream error DOES count against the model", () => {
		const withError = trustAfter([null, null, "upstream_error: Upstream request failed", "upstream_error: boom"]);
		expect(withError).toBeLessThan(CLEAN);
	});

	test("an unclassifiable legacy error stays attributable", () => {
		// No "<kind>: " prefix and not the known abort text: we cannot prove it
		// was blameless, so it keeps counting (the stricter reading).
		const withError = trustAfter([null, null, "something odd happened", "another"]);
		expect(withError).toBeLessThan(CLEAN);
	});

	test("errors field still records the raw text regardless of attribution", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			ledger.record(entry({ error: "request aborted" }));
			const row = db.query("SELECT error, error_kind FROM ledger").get() as {
				error: string | null;
				error_kind: string | null;
			};
			expect(row.error).toBe("request aborted");
			expect(row.error_kind).toBe("aborted");
		} finally {
			db.close();
		}
	});

	test("escalations still count as failures independently of errors", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			ledger.record(entry({ error: null }));
			ledger.record(entry({ error: null }));
			ledger.record(entry({ escalationSignal: "empty_completion" }));
			const trust = ledger.trust("vendor/model");
			expect(trust?.escalations).toBe(1);
			expect(trust?.successRate).toBeLessThan(CLEAN);
		} finally {
			db.close();
		}
	});

	test("aborted rows are still counted as attempts", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			ledger.record(entry({ error: "request aborted" }));
			ledger.record(entry({ error: null }));
			expect(ledger.trust("vendor/model")?.attempts).toBe(2);
			// ...but not as errors.
			expect(ledger.trust("vendor/model")?.errors).toBe(0);
		} finally {
			db.close();
		}
	});
});

describe("latency signal", () => {
	function latencyOf(rows: Array<Partial<LedgerEntry>>): { samples: number; ttftMs: number; tokensPerSec: number } | null {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			for (const r of rows) ledger.record(entry(r));
			const l = ledger.latency("vendor/model");
			return l === null ? null : { samples: l.samples, ttftMs: l.ttftMs, tokensPerSec: l.tokensPerSec };
		} finally {
			db.close();
		}
	}

	test("averages TTFT over streamed, non-errored turns", () => {
		expect(latencyOf([{ ttftMs: 50 }, { ttftMs: 100 }, { ttftMs: 150 }])).toEqual({ samples: 3, ttftMs: 100, tokensPerSec: 0 });
	});

	test("excludes errored, aborted, and non-streamed (null TTFT) rows", () => {
		expect(
			latencyOf([
				{ ttftMs: 100 },
				{ ttftMs: 9999, error: "upstream_error: boom" },
				{ ttftMs: 9999, error: "request aborted" },
				{ ttftMs: null },
			]),
		).toEqual({ samples: 1, ttftMs: 100, tokensPerSec: 0 });
	});

	test("null when no streamed sample exists", () => {
		expect(latencyOf([{ ttftMs: null }, { ttftMs: 0 }])).toBeNull();
	});

	test("throughput is aggregate completion tokens per post-TTFT second", () => {
		const l = latencyOf([
			{ ttftMs: 1000, latencyMs: 3000, usage: { ...EMPTY_USAGE, completionTokens: 200 } },
			{ ttftMs: 1000, latencyMs: 3000, usage: { ...EMPTY_USAGE, completionTokens: 200 } },
		]);
		// 400 completion tokens over 4000ms of post-TTFT time = 100 tok/s.
		expect(l?.tokensPerSec).toBeCloseTo(100, 5);
		expect(l?.samples).toBe(2);
	});

	test("throughput and ttft track a recent window, not the lifetime average", () => {
		// Old rows are fast; the recent window is slow. Latency must reflect the
		// recent (slow) behaviour so a degraded model is penalised, not masked by
		// its history. Lifetime blend here would be ~57 tok/s; the window is 10.
		const rows: Array<Partial<LedgerEntry>> = [];
		let t = 1;
		for (let i = 0; i < 50; i++)
			rows.push({ createdAtMs: t++, ttftMs: 200, latencyMs: 1200, usage: { ...EMPTY_USAGE, completionTokens: 1000 } });
		for (let i = 0; i < LATENCY_WINDOW_ROWS; i++)
			rows.push({ createdAtMs: t++, ttftMs: 4000, latencyMs: 14000, usage: { ...EMPTY_USAGE, completionTokens: 100 } });
		const l = latencyOf(rows);
		expect(l?.samples).toBe(LATENCY_WINDOW_ROWS);
		expect(l?.tokensPerSec).toBeCloseTo(10, 0);
		expect(l?.ttftMs).toBeCloseTo(4000, 5);
	});
});

describe("v4 migration", () => {
	test("backfills error_kind from stored error text", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			ledger.record(entry({ error: "request aborted" }));
			ledger.record(entry({ error: "auth: nope" }));
			ledger.record(entry({ error: "moderation: Request blocked: prompt injection" }));
			ledger.record(entry({ error: "model_unavailable: guardrail" }));
			ledger.record(entry({ error: "upstream_error: boom" }));
			ledger.record(entry({ error: null }));

			const rows = db
				.query("SELECT error, error_kind FROM ledger ORDER BY rowid")
				.all() as Array<{ error: string | null; error_kind: string | null }>;
			expect(rows.map((r) => r.error_kind)).toEqual([
				"aborted",
				"auth",
				"moderation",
				"model_unavailable",
				"upstream_error",
				null,
			]);
		} finally {
			db.close();
		}
	});

	test("schema is at user_version 13", () => {
		const db = openDb(":memory:");
		try {
			const row = db.query("PRAGMA user_version").get() as { user_version: number };
			expect(row.user_version).toBe(13);
		} finally {
			db.close();
		}
	});

	test("persists omp_session_id and returns it via recentEntries", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			ledger.record(entry({ ompSessionId: "sess-a" }));
			ledger.record(entry({ ompSessionId: "" }));
			const got = ledger.recentEntries(10).map((e) => e.ompSessionId).sort();
			expect(got).toEqual(["", "sess-a"]);
		} finally {
			db.close();
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

	test("round-trips the feature vector and classifier outputs", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			ledger.record(
				entry({
					features: FEATURES,
					score: 0.42,
					confidence: 0.75,
					task: "coding",
					classifierReasons: ["-0.28 tool-result continuation"],
				}),
			);

			const got = ledger.recentEntries(1)[0];
			expect(got?.features).toEqual(FEATURES);
			expect(got?.score).toBe(0.42);
			expect(got?.confidence).toBe(0.75);
			expect(got?.task).toBe("coding");
			expect(got?.classifierReasons).toEqual(["-0.28 tool-result continuation"]);
		} finally {
			db.close();
		}
	});

	test("an uninstrumented row reads back as null, not as invented data", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			ledger.record(entry({}));
			const got = ledger.recentEntries(1)[0];
			expect(got?.features).toBeNull();
			expect(got?.score).toBeNull();
			expect(got?.confidence).toBeNull();
			expect(got?.task).toBeNull();
			expect(got?.classifierReasons).toBeNull();
		} finally {
			db.close();
		}
	});

	test("records which tier exploration dropped from, and NULL otherwise", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			ledger.record(entry({ tier: "simple", exploredFrom: "moderate" }));
			ledger.record(entry({ tier: "moderate" }));

			const got = ledger.recentEntries(10);
			expect(got.map((e) => e.exploredFrom).sort()).toEqual(["moderate", null] as unknown as string[]);

			// The counterfactual query this whole column exists to make possible:
			// of the turns we deliberately under-routed, how many had to escalate?
			const counted = db
				.query("SELECT COUNT(*) n FROM ledger WHERE explored_from IS NOT NULL")
				.get() as { n: number };
			expect(counted.n).toBe(1);
		} finally {
			db.close();
		}
	});
	test("features land in the column as queryable JSON", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			ledger.record(entry({ features: FEATURES, score: 0.9, confidence: 0.1, task: "vision" }));
			// SQLite json_extract proves the blob is real JSON, not a stringified object.
			const row = db
				.query("SELECT json_extract(features, '$.toolLoopDepth') AS depth, score, task FROM ledger")
				.get() as { depth: number; score: number; task: string };
			expect(row.depth).toBe(3);
			expect(row.score).toBe(0.9);
			expect(row.task).toBe("vision");
		} finally {
			db.close();
		}
	});
});
