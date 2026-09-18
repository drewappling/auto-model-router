/**
 * The request id, from the header a front door sends to the row support reads.
 *
 * The fact being defended: a customer quotes `x-request-id` and an operator must
 * land on THAT turn. Before the ledger recorded it, the only join available was
 * "the same member at the same instant", which answers "probably this one" and
 * answers nothing at all when two of a member's turns overlap. Everything below
 * is about that answer being exact, and about the id being safe to accept from
 * outside: it arrives from the public internet through somebody else's proxy.
 *
 * SQLite runs always; Postgres runs when AMR_ROUTER_TEST_PG points at one,
 * following this repo's convention for store tests — and there specifically
 * because the ledger is partitioned by day there, so the id has to survive
 * partition routing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { completeUpstreamEntry } from "../src/config/upstreams.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { createSqlLedger } from "../src/cost/ledger-sql.ts";
import { EMPTY_USAGE, type AsyncLedger, type LedgerEntry } from "../src/cost/types.ts";
import { decisionEntries } from "../src/cost/views.ts";
import { startServer, type StartedServer } from "../src/server/http.ts";
import {
	acceptRequestId,
	isMintedRequestId,
	isRequestId,
	mintRequestId,
	requestIdFor,
	MINTED_REQUEST_ID_PREFIX,
	REQUEST_ID_MAX_LENGTH,
} from "../src/util/requestid.ts";
import { ledgerDayStart, ledgerLayout, ledgerPartitionName, migrateStore } from "../src/util/schema.ts";
import { openSqlDb, type SqlDb } from "../src/util/sql.ts";
import { openDb } from "../src/util/sqlite.ts";
import { parseMessagesRequest } from "../src/wire/anthropic/messages.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";
import { parseResponsesRequest } from "../src/wire/openai/responses.ts";

const DAY = 86_400_000;
const PG = process.env.AMR_ROUTER_TEST_PG;
const NUL = String.fromCharCode(0);

const engines: { name: string; url: string; partitions: boolean }[] = [
	{ name: "sqlite", url: `sqlite://${join(tmpdir(), `ledger-reqid-${process.pid}-${Date.now()}.db`)}`, partitions: false },
	...(PG === undefined ? [] : [{ name: "postgres", url: PG, partitions: true }]),
];

function entry(over: Partial<LedgerEntry> & { id: string }): LedgerEntry {
	return {
		createdAtMs: Date.now(),
		conversationKey: `conv-${over.id}`,
		sessionId: `sess-${over.id}`,
		turn: 1,
		requestedModel: "auto",
		harnessId: "u_ada",
		ompSessionId: `omp-${over.id}`,
		slug: "x/model",
		servedSlug: "x/model",
		tier: "simple",
		classificationSource: "heuristic",
		reasons: ["cheapest"],
		predictedUsd: 0.001,
		reportedUsd: 0.002,
		usage: { ...EMPTY_USAGE, promptTokens: 100, completionTokens: 10 },
		attempt: 0,
		escalationSignal: null,
		latencyMs: 10,
		ttftMs: 5,
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
		promptTokensSaved: 0,
		...over,
	} as unknown as LedgerEntry;
}

describe("what the router will carry as a request id", () => {
	test("the ordinary shapes in circulation are accepted verbatim", () => {
		for (const id of [
			"abc123",
			crypto.randomUUID(),
			"01JBQ9F6WQ2M8P7VJ5X3K4T0YZ", // a ULID
			"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", // a traceparent
			"req_01HZ.9-x",
			"c".repeat(REQUEST_ID_MAX_LENGTH),
		]) {
			expect(acceptRequestId(id)).toBe(id);
		}
		// Surrounding whitespace is a proxy's formatting, not part of the id.
		expect(acceptRequestId("  abc123  ")).toBe("abc123");
	});

	test("a hostile value is refused whole rather than repaired", () => {
		const hostile: string[] = [
			"", // absent
			"   ",
			"x".repeat(REQUEST_ID_MAX_LENGTH + 1), // unbounded
			`abc${NUL}def`, // a control character
			"abc\ndef", // a newline: one log line must stay one log line
			"abc\r\nX-Injected: 1",
			"abc\tdef",
			"id with spaces",
			'"><script>alert(1)</script>',
			"a'; DROP TABLE ledger;--",
			"../../etc/passwd",
			"héllo", // outside the ASCII set the rules allow
		];
		for (const value of hostile) {
			expect(acceptRequestId(value), value).toBe("");
			// Nothing is salvaged from it: a truncated or stripped id would look
			// valid and match no row, which is worse than having none.
			expect(requestIdFor(value).startsWith(MINTED_REQUEST_ID_PREFIX), value).toBe(true);
		}
		expect(acceptRequestId(null)).toBe("");
		expect(acceptRequestId(undefined)).toBe("");
	});

	test("a caller cannot pass off an id as one this router minted", () => {
		const forged = `${MINTED_REQUEST_ID_PREFIX}deadbeef`;
		expect(isRequestId(forged)).toBe(true); // well-shaped...
		expect(acceptRequestId(forged)).toBe(""); // ...and still refused from outside
		// The turn is recorded under a minted id of the router's own instead.
		const minted = requestIdFor(forged);
		expect(minted).not.toBe(forged);
		expect(isMintedRequestId(minted)).toBe(true);
	});

	test("a minted id is distinguishable, unique, and short enough for anyone's log", () => {
		const a = mintRequestId();
		const b = mintRequestId();
		expect(a).not.toBe(b);
		expect(isMintedRequestId(a)).toBe(true);
		expect(isMintedRequestId("abc123")).toBe(false);
		expect(a.length).toBeLessThanOrEqual(REQUEST_ID_MAX_LENGTH);
		// It also passes the team edition's own id rule (letters, digits, dots,
		// dashes, 8-64 characters), so a minted id pastes into support unchanged.
		expect(/^[A-Za-z0-9._-]{8,64}$/.test(a)).toBe(true);
	});
});

describe("every turn wire reads the header", () => {
	const body = { model: "auto", messages: [{ role: "user", content: "hi" }] };

	test("the chat, responses and messages wires all carry the caller's id", () => {
		const h = () => new Headers({ "x-request-id": "abc123" });
		expect(parseChatRequest(body, h()).requestId).toBe("abc123");
		expect(parseResponsesRequest({ model: "auto", input: "hi" }, h()).requestId).toBe("abc123");
		expect(parseMessagesRequest({ model: "claude-sonnet-4-5", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }, h()).requestId).toBe("abc123");
	});

	test("an older front door that sends no header behaves exactly as before, plus a minted id", () => {
		const before = parseChatRequest(body, new Headers({ "x-omp-harness": "codex" }));
		// Nothing else about the request changed: the id is additive.
		expect(before.harnessId).toBe("codex");
		expect(before.requestedModel).toBe("auto");
		expect(isMintedRequestId(before.requestId ?? "")).toBe(true);
		// And two turns are never filed under the same minted id.
		expect(parseChatRequest(body, new Headers()).requestId).not.toBe(before.requestId);
	});

	test("a header the rules refuse never reaches the request", () => {
		for (const hostile of ["x".repeat(REQUEST_ID_MAX_LENGTH + 1), "id with spaces", `${MINTED_REQUEST_ID_PREFIX}forged`, '"><script>']) {
			const req = parseChatRequest(body, new Headers({ "x-request-id": hostile }));
			expect(req.requestId).not.toBe(hostile);
			expect(isMintedRequestId(req.requestId ?? "")).toBe(true);
		}
	});
});

for (const engine of engines) {
	describe(`the ledger records the request id on ${engine.name}`, () => {
		let db: SqlDb;
		const cfg: RouterConfig = { ...structuredClone(DEFAULT_CONFIG), ledger: { ...DEFAULT_CONFIG.ledger, path: engine.url } };
		let ledger: AsyncLedger;

		beforeAll(async () => {
			db = openSqlDb(engine.url);
			if (db.dialect === "postgres") await db.sql.unsafe("DROP TABLE IF EXISTS ledger");
			await migrateStore(db);
			ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await db.sql.unsafe("DELETE FROM ledger");
		});

		afterAll(async () => {
			await db.sql.unsafe("DELETE FROM ledger");
			await db.close();
		});

		test("a turn's id round-trips, and a turn without one reads as absent", async () => {
			await ledger.record(entry({ id: "w1", requestId: "abc123" }));
			await ledger.record(entry({ id: "w2" }));
			// An empty string is not an id: it stores as NULL, like an absent one.
			await ledger.record(entry({ id: "w3", requestId: "" }));

			const byId = new Map((await ledger.recentEntries(10)).map((e) => [e.id, e]));
			expect(byId.get("w1")?.requestId).toBe("abc123");
			expect(byId.get("w2")?.requestId).toBeUndefined();
			expect(byId.get("w3")?.requestId).toBeUndefined();
		});

		test("the decision shape carries it, and filters on it exactly", async () => {
			await db.sql.unsafe("DELETE FROM ledger");
			// One request, escalated: two rows, one id. And another member's turn
			// in the same millisecond — the case the time-window join cannot call.
			const atMs = Date.now() - 1000;
			await ledger.record(entry({ id: "d1", createdAtMs: atMs, requestId: "req-one", attempt: 0, wasted: true }));
			await ledger.record(entry({ id: "d2", createdAtMs: atMs, requestId: "req-one", attempt: 1 }));
			await ledger.record(entry({ id: "d3", createdAtMs: atMs, requestId: "req-two", harnessId: "u_bob" }));

			const all = await decisionEntries(db, { sinceMs: 0, harness: null });
			expect(new Set(all.map((e) => e.requestId))).toEqual(new Set(["req-one", "req-two"]));

			const one = await decisionEntries(db, { sinceMs: 0, harness: null, requestId: "req-one" });
			expect(one.map((e) => e.id).sort()).toEqual(["d1", "d2"]);
			// Exact, not nearest: an id nothing was recorded under finds nothing,
			// even though a turn of that member sits at the same instant.
			expect(await decisionEntries(db, { sinceMs: 0, harness: null, requestId: "req-three" })).toEqual([]);
			// And it composes with the scoping a front door already applies.
			expect((await decisionEntries(db, { sinceMs: 0, harness: ["u_bob"], requestId: "req-two" })).map((e) => e.id)).toEqual(["d3"]);
			expect(await decisionEntries(db, { sinceMs: 0, harness: ["u_ada"], requestId: "req-two" })).toEqual([]);
		});

		test("a row written before the column existed reads null rather than failing", async () => {
			await db.sql.unsafe("DELETE FROM ledger");
			await ledger.record(entry({ id: "old", requestId: "will-be-cleared" }));
			// Exactly what an upgraded deployment holds: the column exists, the row
			// predates it. (On SQLite the migration itself is covered by
			// test/migrations.test.ts against every shipped fixture.)
			await db.sql`UPDATE ledger SET request_id = NULL WHERE id = ${"old"}`;
			expect((await ledger.recentEntries(1))[0]?.requestId).toBeUndefined();
			expect((await decisionEntries(db, { sinceMs: 0, harness: null }))[0]?.requestId).toBeUndefined();
		});

		test("an id far outside today still lands, so partition routing is unaffected", async () => {
			await db.sql.unsafe("DELETE FROM ledger");
			// 40 days back is outside every partition migrateStore provisioned: the
			// insert is refused once, the day is created, and the row is written
			// again — the retry path has to carry the id too.
			const backdated = Date.now() - 40 * DAY;
			await ledger.record(entry({ id: "late", createdAtMs: backdated, requestId: "req-late" }));
			await ledger.record(entry({ id: "now", requestId: "req-now" }));

			expect((await decisionEntries(db, { sinceMs: 0, harness: null, requestId: "req-late" })).map((e) => e.id)).toEqual(["late"]);
			expect((await decisionEntries(db, { sinceMs: 0, harness: null, requestId: "req-now" })).map((e) => e.id)).toEqual(["now"]);
			if (!engine.partitions) return;
			expect(await ledgerLayout(db)).toBe("partitioned");
			const rows = await db.query<{ name: string }>(
				"SELECT c.relname AS name FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid WHERE i.inhparent = to_regclass('ledger')",
			);
			expect(rows.map((r) => r.name)).toContain(ledgerPartitionName(ledgerDayStart(backdated)));
			// The column reached the day partition, not only the parent.
			const cols = await db.query<{ name: string }>(
				"SELECT column_name AS name FROM information_schema.columns WHERE table_name = $t",
				{ t: ledgerPartitionName(ledgerDayStart(backdated)) },
			);
			expect(cols.map((c) => c.name)).toContain("request_id");
		});

		test("a hostile string cannot poison the row, because it never becomes an id", async () => {
			await db.sql.unsafe("DELETE FROM ledger");
			// The turn path decides the id (the wire tests above); this is the
			// storage end of the same fact: whatever a caller sent, what is stored
			// is either a value that passed the rules or NULL, and the row beside
			// it is untouched either way.
			const hostile = `x'); DROP TABLE ledger;--${NUL}\n`;
			await ledger.record(entry({ id: "poison", requestId: requestIdFor(hostile) }));
			await ledger.record(entry({ id: "neighbour", requestId: "req-clean" }));
			const rows = await ledger.recentEntries(10);
			expect(rows).toHaveLength(2);
			expect(isMintedRequestId(rows.find((e) => e.id === "poison")?.requestId ?? "")).toBe(true);
			expect(rows.find((e) => e.id === "neighbour")?.requestId).toBe("req-clean");
		});
	});
}

describe("a router upgraded in place", () => {
	test("an older database migrates, keeps its rows, and its old turns read null", () => {
		const dir = mkdtempSync(join(tmpdir(), "amr-reqid-upgrade-"));
		try {
			const path = join(dir, "router.db");
			// A ledger as v19 left it: every column of that release and no
			// request_id. Built by hand rather than from a fixture, so the guard is
			// tested on the exact shape the previous version shipped.
			const old = openDb(path);
			old.exec("PRAGMA user_version = 19");
			// The index goes first: SQLite refuses to drop a column an index names.
			old.exec("DROP INDEX IF EXISTS idx_ledger_request");
			old.exec("ALTER TABLE ledger DROP COLUMN request_id");
			old.exec(
				`INSERT INTO ledger (id, created_at_ms, conversation_key, session_id, turn, requested_model, slug, tier,
					classification_source, reasons, predicted_usd, usage, attempt, latency_ms, wasted)
				 VALUES ('v19row', ${Date.now()}, 'k', 's', 1, 'auto', 'x/model', 'simple', 'heuristic', '[]', 0.001, '{}', 0, 5, 0)`,
			);
			old.close();

			// Reopening is the migration. Nothing is lost, and the old row is
			// honestly id-less rather than carrying an invented one.
			const db = openDb(path);
			try {
				expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(20);
				const cols = (db.query("PRAGMA table_info(ledger)").all() as { name: string }[]).map((c) => c.name);
				expect(cols).toContain("request_id");
				const row = db.query("SELECT id, request_id FROM ledger").get() as { id: string; request_id: string | null };
				expect(row).toEqual({ id: "v19row", request_id: null });
				// The lookup an operator will run is indexed, on both old and new rows.
				const plan = db.query("EXPLAIN QUERY PLAN SELECT * FROM ledger WHERE request_id = 'abc'").all() as { detail: string }[];
				expect(plan.map((p) => p.detail).join(" ")).toContain("idx_ledger_request");
			} finally {
				db.close();
			}
		} finally {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* Windows may hold the WAL briefly */
			}
		}
	});
});

describe("over HTTP", () => {
	let handle: StartedServer;
	let dir: string;
	let base: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "amr-reqid-http-"));
		const cfg = structuredClone(DEFAULT_CONFIG);
		cfg.server.host = "127.0.0.1";
		cfg.server.port = 0;
		cfg.server.apiKey = "k";
		cfg.logLevel = "silent";
		cfg.context = { ...cfg.context, enabled: false };
		// A catalog that needs no network: one static upstream, pointed at a port
		// nothing listens on. Routing then decides immediately and the dispatch
		// fails at once, so this test measures the header and never the internet.
		cfg.upstreams = [
			completeUpstreamEntry({ id: "nowhere", kind: "openai", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-x", models: [{ id: "m1", input: 0.1, output: 0.4 }] }),
		];
		cfg.ledger.path = join(dir, "router.db");
		// Seeded through the same file before the server opens it, as a front
		// door's own handle would be.
		const db = openSqlDb(cfg.ledger.path);
		await migrateStore(db);
		const seed = createSqlLedger(db, cfg, { findModel: () => null });
		await seed.record(entry({ id: "h1", createdAtMs: Date.now() - 1000, requestId: "quoted-by-a-customer" }));
		await seed.record(entry({ id: "h2", createdAtMs: Date.now() - 900 }));
		await db.close();
		handle = startServer(cfg);
		base = `http://127.0.0.1:${handle.server.port}`;
	});

	afterAll(async () => {
		await handle.stop();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* Windows may hold the WAL briefly */
		}
	});

	const get = (path: string) => fetch(`${base}${path}`, { headers: { authorization: "Bearer k" } });

	test("the decisions route answers on an exact id, and refuses a mangled one", async () => {
		const hit = (await (await get("/v1/router/decisions?requestId=quoted-by-a-customer")).json()) as { entries: { id: string; requestId?: string }[] };
		expect(hit.entries.map((e) => e.id)).toEqual(["h1"]);
		expect(hit.entries[0]?.requestId).toBe("quoted-by-a-customer");
		// The row that carried no id is not swept in by an id lookup...
		expect(((await (await get("/v1/router/decisions?requestId=nothing-recorded")).json()) as { entries: unknown[] }).entries).toEqual([]);
		// ...and without the parameter the trail is exactly what it always was.
		const all = (await (await get("/v1/router/decisions")).json()) as { entries: { id: string; requestId?: string }[] };
		expect(all.entries.map((e) => e.id).sort()).toEqual(["h1", "h2"]);
		expect(all.entries.find((e) => e.id === "h2")?.requestId).toBeUndefined();
		// A paste that arrived mangled says so, rather than quietly answering
		// with the whole trail as an ignored filter would.
		expect((await get("/v1/router/decisions?requestId=not%20an%20id")).status).toBe(400);
		// A minted id is looked up like any other: the header refuses the prefix,
		// a QUESTION about one is the ordinary case.
		expect((await get(`/v1/router/decisions?requestId=${MINTED_REQUEST_ID_PREFIX}0123456789abcdef`)).status).toBe(200);
	});

	test("a turn's response carries the id back: the caller's, or the minted one", async () => {
		// Buffered rather than streamed, so the assertion is about the header and
		// not about how fast a stream is torn down. No upstream key is configured
		// here, so the turn fails at routing — which is the point: the id is on
		// the response either way, and a failed turn is exactly the one a customer
		// opens a ticket about.
		const turn = async (headers: Record<string, string>): Promise<Response> => {
			const res = await fetch(`${base}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer k", ...headers },
				body: JSON.stringify({ model: "auto", stream: false, messages: [{ role: "user", content: "hi" }] }),
			});
			await res.text();
			return res;
		};

		expect((await turn({ "x-request-id": "abc123" })).headers.get("x-request-id")).toBe("abc123");
		expect(isMintedRequestId((await turn({})).headers.get("x-request-id") ?? "")).toBe(true);

		// A hostile header is not echoed back either — nothing reflects it.
		const echoed = (await turn({ "x-request-id": "x".repeat(REQUEST_ID_MAX_LENGTH + 1) })).headers.get("x-request-id") ?? "";
		expect(echoed).not.toContain("xxxx");
		expect(isMintedRequestId(echoed)).toBe(true);
	});

	test("/health names the capability, so a front door can tell before it relies on it", async () => {
		const health = (await (await get("/health")).json()) as { features: string[] };
		expect(health.features).toContain("request-id");
	});
});
