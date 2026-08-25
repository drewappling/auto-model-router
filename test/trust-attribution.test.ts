import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config/load.ts";
import { createLedger } from "../src/cost/ledger.ts";
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
				"auth: Request blocked: prompt injection patterns detected",
				"auth: This model requires 18+ age confirmation",
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

describe("v4 migration", () => {
	test("backfills error_kind from stored error text", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			ledger.record(entry({ error: "request aborted" }));
			ledger.record(entry({ error: "auth: nope" }));
			ledger.record(entry({ error: "model_unavailable: guardrail" }));
			ledger.record(entry({ error: "upstream_error: boom" }));
			ledger.record(entry({ error: null }));

			const rows = db
				.query("SELECT error, error_kind FROM ledger ORDER BY rowid")
				.all() as Array<{ error: string | null; error_kind: string | null }>;
			expect(rows.map((r) => r.error_kind)).toEqual([
				"aborted",
				"auth",
				"model_unavailable",
				"upstream_error",
				null,
			]);
		} finally {
			db.close();
		}
	});

	test("schema is at user_version 5", () => {
		const db = openDb(":memory:");
		try {
			const row = db.query("PRAGMA user_version").get() as { user_version: number };
			expect(row.user_version).toBe(5);
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
