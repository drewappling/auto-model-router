import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { LedgerEntry } from "../src/cost/types.ts";
import { exportCsv, exportRows, feedbackView, harnessScopeParam, spendUsdSince } from "../src/cost/views.ts";
import { startServer, type StartedServer } from "../src/server/http.ts";
import { jsonParam, openSqlDb, type SqlDb } from "../src/util/sql.ts";
import { createSqlLedger } from "../src/cost/ledger-sql.ts";
import { migrateStore } from "../src/util/schema.ts";

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

async function seeded(): Promise<SqlDb> {
	const cfg = structuredClone(DEFAULT_CONFIG);
	// A file, not :memory:, because the views read through their OWN handle on
	// the same store — which is the arrangement in a real deployment, and what
	// an in-memory database cannot represent.
	const path = join(tmpdir(), `views-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	cfg.ledger.path = path;
	const db = openSqlDb(path);
	await migrateStore(db);
	const ledger = createSqlLedger(db, cfg, { findModel: () => null });
	const feedback = {
		record: async (
			f: { ledgerId: string; ompSessionId: string; slug: string; tier: string; verdict: string; note: string },
			atMs: number,
		): Promise<void> => {
			await db.sql`INSERT INTO feedback (id, ledger_id, omp_session_id, slug, tier, verdict, note, created_at_ms)
				VALUES (${crypto.randomUUID()}, ${f.ledgerId}, ${f.ompSessionId}, ${f.slug}, ${f.tier}, ${f.verdict}, ${f.note}, ${atMs})`;
		},
	};
	await ledger.record(entry({ id: "l1", harnessId: "u_ada", scope: "acme.api", slug: "anthropic/claude-sonnet-5", servedSlug: "anthropic/claude-sonnet-5", predictedUsd: 0.01, reportedUsd: 0.012 }));
	await ledger.record(entry({ id: "l2", harnessId: "u_ada", scope: "acme.web", slug: "anthropic/claude-sonnet-5", servedSlug: null, predictedUsd: 0.01, reportedUsd: null, escalationSignal: "circular" }));
	await ledger.record(entry({ id: "l3", harnessId: "u_bob", scope: "acme.api", slug: "ollama/glm-5.3-flash", servedSlug: "ollama/glm-5.3-flash", predictedUsd: 0.001, reportedUsd: 0.001, error: "boom" }));
	await ledger.record(entry({ id: "l4", harnessId: "u_bob", requestedModel: "digest", slug: "ollama/glm-5.3-flash", servedSlug: "ollama/glm-5.3-flash", predictedUsd: 0.5, reportedUsd: 0.5 }));
	await ledger.record(entry({ id: "l5", harnessId: "u_bob", createdAtMs: NOW - 40 * DAY, slug: "ollama/glm-5.3-flash", predictedUsd: 5, reportedUsd: 5 }));
	await feedback.record({ ledgerId: "l1", ompSessionId: "s", slug: "anthropic/claude-sonnet-5", tier: "simple", verdict: "good", note: "" }, NOW - 1000);
	await feedback.record({ ledgerId: "l2", ompSessionId: "s", slug: "anthropic/claude-sonnet-5", tier: "simple", verdict: "bad", note: "" }, NOW - 900);
	await feedback.record({ ledgerId: "l3", ompSessionId: "s", slug: "ollama/glm-5.3-flash", tier: "simple", verdict: "bad", note: "looped" }, NOW - 800);
	return db;
}

describe("ledger views", () => {
	let db: SqlDb;
	beforeAll(async () => {
		db = await seeded();
	});
	const since = NOW - DAY;

	test("spend over a harness set, everything, or nothing", async () => {
		expect(await spendUsdSince(db, since, ["u_ada"])).toBeCloseTo(0.022, 6); // reported where present, predicted otherwise
		expect(await spendUsdSince(db, since, ["u_ada", "u_bob"])).toBeCloseTo(0.523, 6); // the digest row counts as spend
		expect(await spendUsdSince(db, since, null)).toBeCloseTo(0.523, 6);
		expect(await spendUsdSince(db, NOW - 60 * DAY, null)).toBeCloseTo(5.523, 6);
		expect(await spendUsdSince(db, since, [])).toBe(0);
	});

	test("spend narrowed to one context scope, so a front door charges a project", async () => {
		// l1 (0.012, u_ada) and l3 (0.001, u_bob) carried acme.api; l2 (0.01 predicted) carried acme.web.
		expect(await spendUsdSince(db, since, null, "acme.api")).toBeCloseTo(0.013, 6);
		expect(await spendUsdSince(db, since, null, "acme.web")).toBeCloseTo(0.01, 6);
		expect(await spendUsdSince(db, since, ["u_ada"], "acme.api")).toBeCloseTo(0.012, 6); // harness and scope compose
		expect(await spendUsdSince(db, since, ["u_bob"], "acme.web")).toBe(0);
		expect(await spendUsdSince(db, since, null, "nope")).toBe(0);
		expect(await spendUsdSince(db, since, null, "")).toBeCloseTo(0.523, 6); // no scope given: every turn, scoped or not
		expect(await spendUsdSince(db, since, [], "acme.api")).toBe(0);
	});

	test("feedback by model with distinct judges, scoped by harness", async () => {
		const all = await feedbackView(db, since, null);
		expect(all.byModel).toEqual([
			{ slug: "anthropic/claude-sonnet-5", good: 1, bad: 1, judges: 1 },
			{ slug: "ollama/glm-5.3-flash", good: 0, bad: 1, judges: 1 },
		]);
		expect(all.recent.map((r) => [r.harnessId, r.verdict, r.note])).toEqual([
			["u_bob", "bad", "looped"],
			["u_ada", "bad", ""],
			["u_ada", "good", ""],
		]);
		expect((await feedbackView(db, since, ["u_bob"])).byModel).toEqual([{ slug: "ollama/glm-5.3-flash", good: 0, bad: 1, judges: 1 }]);
		expect((await feedbackView(db, since, [])).recent).toEqual([]);
	});

	test("export rows by day, harness, served model and scope; digest and old rows out; CSV quoting", async () => {
		const rows = await exportRows(db, since, null);
		// u_ada's two turns are one model on one day but two projects, so they no longer share a row.
		expect(rows).toHaveLength(3);
		expect(rows[0]).toMatchObject({ day: "2026-09-07", harnessId: "u_ada", slug: "anthropic/claude-sonnet-5", scope: "acme.api", provider: "openrouter", dispatches: 1, promptTokens: 1000, cachedTokens: 400, completionTokens: 50, escalations: 0, errors: 0 });
		expect(rows[0]!.spendUsd).toBeCloseTo(0.012, 6);
		expect(rows[1]).toMatchObject({ harnessId: "u_ada", scope: "acme.web", dispatches: 1, escalations: 1 });
		expect(rows[1]!.spendUsd).toBeCloseTo(0.01, 6);
		expect(rows[2]).toMatchObject({ harnessId: "u_bob", scope: "acme.api", provider: "ollama", dispatches: 1, errors: 1 });
		expect(await exportRows(db, since, ["u_bob"])).toHaveLength(1);
		expect(await exportRows(db, since, [])).toEqual([]);
		// A turn that carried no scope groups under "": what every row written before v18 does.
		expect((await exportRows(db, NOW - 60 * DAY, ["u_bob"])).map((r) => r.scope).sort()).toEqual(["", "acme.api"]);
		const csv = exportCsv([{ ...rows[0]!, harnessId: 'ada, "L"' }]);
		expect(csv.split("\n")[0]).toBe("day,harness,model,provider,dispatches,prompt_tokens,cached_tokens,completion_tokens,spend_usd,escalations,errors,scope");
		expect(csv.split("\n")[1]).toBe('2026-09-07,"ada, ""L""",anthropic/claude-sonnet-5,openrouter,1,1000,400,50,0.012000,0,0,acme.api');
		expect(harnessScopeParam(null)).toBeNull();
		expect(harnessScopeParam(" , ")).toBeNull();
		expect(harnessScopeParam("a, b")).toEqual(["a", "b"]);
	});
});

describe("view routes", () => {
	let handle: StartedServer;
	const dir = mkdtempSync(join(tmpdir(), "amr-views-"));
	beforeAll(async () => {
		const cfg = structuredClone(DEFAULT_CONFIG);
		cfg.server.host = "127.0.0.1";
		cfg.server.port = 0;
		cfg.server.apiKey = "k";
		cfg.ledger.path = join(dir, "router.db");
		// Seed through the ledger on the same file before the server opens it.
		const db = openSqlDb(cfg.ledger.path);
		await migrateStore(db);
		const seed = createSqlLedger(db, cfg, { findModel: () => null });
		await seed.record(
			entry({ id: "r1", createdAtMs: Date.now() - 1000, harnessId: "u_x", scope: "acme.api", predictedUsd: 0.2, reportedUsd: 0.25 }),
		);
		await db.close();
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
		// ?scope= charges one project: the row carried acme.api, so acme.web sees nothing.
		const scoped = (await (await get(`/v1/router/spend?sinceMs=${Date.now() - DAY}&scope=acme.api`)).json()) as { usd: number; scope: string };
		expect(scoped.usd).toBeCloseTo(0.25, 6);
		expect(scoped.scope).toBe("acme.api");
		expect(((await (await get(`/v1/router/spend?sinceMs=${Date.now() - DAY}&scope=acme.web`)).json()) as { usd: number }).usd).toBe(0);
		expect(((await (await get(`/v1/router/spend?sinceMs=${Date.now() - DAY}&harness=u_x&scope=acme.api`)).json()) as { usd: number }).usd).toBeCloseTo(0.25, 6);
		const fb = (await (await get("/v1/router/feedback?days=7")).json()) as { days: number; byModel: unknown[]; recent: unknown[] };
		expect(fb).toEqual({ days: 7, byModel: [], recent: [] });
		const csv = await get("/v1/router/export?days=1");
		expect(csv.headers.get("content-type")).toContain("text/csv");
		expect((await csv.text()).split("\n")[1]).toContain("u_x,vendor/model,openrouter,1,1000,400,50,0.250000,0,0,acme.api");
		const js = (await (await get("/v1/router/export?days=1&format=json&harness=u_x")).json()) as { days: number; rows: { harnessId: string; scope: string }[] };
		expect(js.days).toBe(1);
		expect(js.rows[0]?.harnessId).toBe("u_x");
		expect(js.rows[0]?.scope).toBe("acme.api");
	});
});

describe("decision entries", () => {
	let db: SqlDb;
	beforeAll(async () => {
		db = await seeded();
	});
	const since = NOW - DAY;

	test("newest first over a harness set, with the verdicts given on each turn", async () => {
		const { decisionEntries } = require("../src/cost/views.ts") as typeof import("../src/cost/views.ts");
		const ada = await decisionEntries(db, { sinceMs: since, harness: ["u_ada"] });
		expect(ada.map((e) => e.id)).toEqual(["l1", "l2"]); // same instant in the fixture; insertion order within it is stable
		expect(ada.find((e) => e.id === "l1")?.feedback).toEqual([{ verdict: "good", note: "", createdAtMs: NOW - 1000 }]);
		expect(ada.find((e) => e.id === "l2")?.escalationSignal).toBe("circular");
		// The context scope is a ledger column now, so it rides along on every entry.
		expect(ada.find((e) => e.id === "l1")?.scope).toBe("acme.api");
		expect(ada.find((e) => e.id === "l2")?.scope).toBe("acme.web");
		// Everyone, within the window: the 40-day-old row stays out; the digest row is a turn like any other.
		expect((await decisionEntries(db, { sinceMs: since, harness: null })).map((e) => e.id).sort()).toEqual(["l1", "l2", "l3", "l4"]);
		expect((await decisionEntries(db, { sinceMs: 0, harness: null })).length).toBe(5);
		// A model, a tier, nobody, and a cap.
		expect((await decisionEntries(db, { sinceMs: since, harness: null, slug: "ollama/glm-5.3-flash" })).map((e) => e.id).sort()).toEqual(["l3", "l4"]);
		expect(await decisionEntries(db, { sinceMs: since, harness: null, tier: "hard" })).toEqual([]);
		expect(await decisionEntries(db, { sinceMs: since, harness: [] })).toEqual([]);
		expect((await decisionEntries(db, { sinceMs: since, harness: null, limit: 1 })).length).toBe(1);
		// The error on l3 and its note ride along, so an explorer can show why a turn went wrong.
		const bob = await decisionEntries(db, { sinceMs: since, harness: ["u_bob"], slug: "ollama/glm-5.3-flash" });
		expect(bob.find((e) => e.id === "l3")?.error).toBe("boom");
		expect(bob.find((e) => e.id === "l3")?.feedback[0]?.note).toBe("looped");
	});

	test("the recorded cost split rides along; unpriced rows leave it absent", async () => {
		const { decisionEntries } = require("../src/cost/views.ts") as typeof import("../src/cost/views.ts");
		// The fixture records before any catalog fetch, so every row stored NULL;
		// one priced row stands in for a turn the router could price at record time.
		const breakdown = { freshPrompt: 0.006, cacheRead: 0.004, cacheWrite: 0, completion: 0.002, reasoning: 0, images: 0, request: 0, total: 0.006, tierAtPromptTokens: 0 };
		await db.sql`UPDATE ledger SET cost_breakdown = ${jsonParam(db, breakdown)} WHERE id = ${"l1"}`;
		const entries = await decisionEntries(db, { sinceMs: since, harness: null });
		const priced = entries.find((e) => e.id === "l1");
		expect(priced?.costBreakdown?.total).toBeCloseTo(0.006, 6);
		expect(priced?.costBreakdown?.cacheRead).toBeCloseTo(0.004, 6);
		// A row the ledger could not price (all of them here, NULL column) has no
		// breakdown at all — the front door's cue to fall back to the blend.
		expect(entries.find((e) => e.id === "l2")?.costBreakdown).toBeUndefined();
	});
});
