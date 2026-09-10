import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createFeedbackStore } from "../src/cost/feedback.ts";
import { createLedger } from "../src/cost/ledger.ts";
import type { LedgerEntry } from "../src/cost/types.ts";
import { exportCsv, exportRows, feedbackView, harnessScopeParam, spendUsdSince } from "../src/cost/views.ts";
import { startServer, type StartedServer } from "../src/server/http.ts";
import { openDb } from "../src/util/sqlite.ts";

/**
 * The ledger views a front door reads instead of the ledger file: spend over
 * a harness set, feedback with the judging harness, and the day × harness ×
 * model export. Pinned over the public functions and over the HTTP routes.
 */

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 7, 12, 0, 0);

function entry(over: Partial<LedgerEntry>): LedgerEntry {
	return {
		id: crypto.randomUUID(),
		createdAtMs: NOW - 3_600_000,
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
		usage: { promptTokens: 1000, cachedTokens: 400, cacheWriteTokens: 0, completionTokens: 50, reasoningTokens: 0, images: 0 },
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
	const feedback = createFeedbackStore(db);
	ledger.record(entry({ id: "l1", harnessId: "u_ada", slug: "anthropic/claude-sonnet-5", servedSlug: "anthropic/claude-sonnet-5", predictedUsd: 0.01, reportedUsd: 0.012 }));
	ledger.record(entry({ id: "l2", harnessId: "u_ada", slug: "anthropic/claude-sonnet-5", servedSlug: null, predictedUsd: 0.01, reportedUsd: null, escalationSignal: "circular" }));
	ledger.record(entry({ id: "l3", harnessId: "u_bob", slug: "ollama/glm-5.3-flash", servedSlug: "ollama/glm-5.3-flash", predictedUsd: 0.001, reportedUsd: 0.001, error: "boom" }));
	ledger.record(entry({ id: "l4", harnessId: "u_bob", requestedModel: "digest", slug: "ollama/glm-5.3-flash", servedSlug: "ollama/glm-5.3-flash", predictedUsd: 0.5, reportedUsd: 0.5 }));
	ledger.record(entry({ id: "l5", harnessId: "u_bob", createdAtMs: NOW - 40 * DAY, slug: "ollama/glm-5.3-flash", predictedUsd: 5, reportedUsd: 5 }));
	feedback.record({ ledgerId: "l1", ompSessionId: "s", slug: "anthropic/claude-sonnet-5", tier: "simple", verdict: "good", note: "" }, NOW - 1000);
	feedback.record({ ledgerId: "l2", ompSessionId: "s", slug: "anthropic/claude-sonnet-5", tier: "simple", verdict: "bad", note: "" }, NOW - 900);
	feedback.record({ ledgerId: "l3", ompSessionId: "s", slug: "ollama/glm-5.3-flash", tier: "simple", verdict: "bad", note: "looped" }, NOW - 800);
	return db;
}

describe("ledger views", () => {
	const db = seeded();
	const since = NOW - DAY;

	test("spend over a harness set, everything, or nothing", () => {
		expect(spendUsdSince(db, since, ["u_ada"])).toBeCloseTo(0.022, 6); // reported where present, predicted otherwise
		expect(spendUsdSince(db, since, ["u_ada", "u_bob"])).toBeCloseTo(0.523, 6); // the digest row counts as spend
		expect(spendUsdSince(db, since, null)).toBeCloseTo(0.523, 6);
		expect(spendUsdSince(db, NOW - 60 * DAY, null)).toBeCloseTo(5.523, 6);
		expect(spendUsdSince(db, since, [])).toBe(0);
	});

	test("feedback by model with distinct judges, scoped by harness", () => {
		const all = feedbackView(db, since, null);
		expect(all.byModel).toEqual([
			{ slug: "anthropic/claude-sonnet-5", good: 1, bad: 1, judges: 1 },
			{ slug: "ollama/glm-5.3-flash", good: 0, bad: 1, judges: 1 },
		]);
		expect(all.recent.map((r) => [r.harnessId, r.verdict, r.note])).toEqual([
			["u_bob", "bad", "looped"],
			["u_ada", "bad", ""],
			["u_ada", "good", ""],
		]);
		expect(feedbackView(db, since, ["u_bob"]).byModel).toEqual([{ slug: "ollama/glm-5.3-flash", good: 0, bad: 1, judges: 1 }]);
		expect(feedbackView(db, since, []).recent).toEqual([]);
	});

	test("export rows by day, harness and served model; digest and old rows out; CSV quoting", () => {
		const rows = exportRows(db, since, null);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ day: "2026-09-07", harnessId: "u_ada", slug: "anthropic/claude-sonnet-5", provider: "openrouter", dispatches: 2, promptTokens: 2000, cachedTokens: 800, completionTokens: 100, escalations: 1, errors: 0 });
		expect(rows[0]!.spendUsd).toBeCloseTo(0.022, 6);
		expect(rows[1]).toMatchObject({ harnessId: "u_bob", provider: "ollama", dispatches: 1, errors: 1 });
		expect(exportRows(db, since, ["u_bob"])).toHaveLength(1);
		expect(exportRows(db, since, [])).toEqual([]);
		const csv = exportCsv([{ ...rows[0]!, harnessId: 'ada, "L"' }]);
		expect(csv.split("\n")[0]).toBe("day,harness,model,provider,dispatches,prompt_tokens,cached_tokens,completion_tokens,spend_usd,escalations,errors");
		expect(csv.split("\n")[1]).toBe('2026-09-07,"ada, ""L""",anthropic/claude-sonnet-5,openrouter,2,2000,800,100,0.022000,1,0');
		expect(harnessScopeParam(null)).toBeNull();
		expect(harnessScopeParam(" , ")).toBeNull();
		expect(harnessScopeParam("a, b")).toEqual(["a", "b"]);
	});
});

describe("view routes", () => {
	let handle: StartedServer;
	const dir = mkdtempSync(join(tmpdir(), "amr-views-"));
	beforeAll(() => {
		const cfg = structuredClone(DEFAULT_CONFIG);
		cfg.server.host = "127.0.0.1";
		cfg.server.port = 0;
		cfg.server.apiKey = "k";
		cfg.ledger.path = join(dir, "router.db");
		// Seed through the ledger on the same file before the server opens it.
		const db = openDb(cfg.ledger.path);
		createLedger(db, cfg).record(entry({ id: "r1", createdAtMs: Date.now() - 1000, harnessId: "u_x", predictedUsd: 0.2, reportedUsd: 0.25 }));
		db.close();
		handle = startServer(cfg);
	});
	afterAll(async () => {
		await handle.stop();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* Windows may hold the WAL briefly */
		}
	});
	const get = (path: string) => fetch(`http://127.0.0.1:${handle.server.port}${path}`, { headers: { authorization: "Bearer k" } });

	test("spend, feedback and export answer with the auth every router route needs", async () => {
		expect((await fetch(`http://127.0.0.1:${handle.server.port}/v1/router/spend?sinceMs=0`)).status).toBe(401);
		expect((await get("/v1/router/spend")).status).toBe(400);
		expect(((await (await get(`/v1/router/spend?sinceMs=${Date.now() - DAY}&harness=u_x`)).json()) as { usd: number }).usd).toBeCloseTo(0.25, 6);
		// The decision trail over a harness set: a team asks with its user or group ids and sees only theirs.
		const mine = (await (await get("/v1/router/decisions?harness=u_x&days=1")).json()) as { entries: { id: string; feedback: unknown[] }[] };
		expect(mine.entries.map((e) => e.id)).toEqual(["r1"]);
		expect(mine.entries[0]?.feedback).toEqual([]);
		expect((((await (await get("/v1/router/decisions?harness=u_other&days=1")).json()) as { entries: unknown[] }).entries)).toEqual([]);
		expect((((await (await get("/v1/router/decisions?limit=1")).json()) as { entries: { id: string }[] }).entries.map((e) => e.id))).toEqual(["r1"]); // no filter: everything, as before
		expect(((await (await get(`/v1/router/spend?sinceMs=${Date.now() - DAY}&harness=u_other`)).json()) as { usd: number }).usd).toBe(0);
		const fb = (await (await get("/v1/router/feedback?days=7")).json()) as { days: number; byModel: unknown[]; recent: unknown[] };
		expect(fb).toEqual({ days: 7, byModel: [], recent: [] });
		const csv = await get("/v1/router/export?days=1");
		expect(csv.headers.get("content-type")).toContain("text/csv");
		expect((await csv.text()).split("\n")[1]).toContain("u_x,vendor/model,openrouter,1,1000,400,50,0.250000,0,0");
		const js = (await (await get("/v1/router/export?days=1&format=json&harness=u_x")).json()) as { days: number; rows: { harnessId: string }[] };
		expect(js.days).toBe(1);
		expect(js.rows[0]?.harnessId).toBe("u_x");
	});
});

describe("decision entries", () => {
	const db = seeded();
	const since = NOW - DAY;

	test("newest first over a harness set, with the verdicts given on each turn", () => {
		const { decisionEntries } = require("../src/cost/views.ts") as typeof import("../src/cost/views.ts");
		const ada = decisionEntries(db, { sinceMs: since, harness: ["u_ada"] });
		expect(ada.map((e) => e.id)).toEqual(["l1", "l2"]); // same instant in the fixture; insertion order within it is stable
		expect(ada.find((e) => e.id === "l1")?.feedback).toEqual([{ verdict: "good", note: "", createdAtMs: NOW - 1000 }]);
		expect(ada.find((e) => e.id === "l2")?.escalationSignal).toBe("circular");
		// Everyone, within the window: the 40-day-old row stays out; the digest row is a turn like any other.
		expect(decisionEntries(db, { sinceMs: since, harness: null }).map((e) => e.id).sort()).toEqual(["l1", "l2", "l3", "l4"]);
		expect(decisionEntries(db, { sinceMs: 0, harness: null }).length).toBe(5);
		// A model, a tier, nobody, and a cap.
		expect(decisionEntries(db, { sinceMs: since, harness: null, slug: "ollama/glm-5.3-flash" }).map((e) => e.id).sort()).toEqual(["l3", "l4"]);
		expect(decisionEntries(db, { sinceMs: since, harness: null, tier: "hard" })).toEqual([]);
		expect(decisionEntries(db, { sinceMs: since, harness: [] })).toEqual([]);
		expect(decisionEntries(db, { sinceMs: since, harness: null, limit: 1 }).length).toBe(1);
		// The error on l3 and its note ride along, so an explorer can show why a turn went wrong.
		const bob = decisionEntries(db, { sinceMs: since, harness: ["u_bob"], slug: "ollama/glm-5.3-flash" });
		expect(bob.find((e) => e.id === "l3")?.error).toBe("boom");
		expect(bob.find((e) => e.id === "l3")?.feedback[0]?.note).toBe("looped");
	});
});
