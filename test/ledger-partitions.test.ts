/**
 * The ledger's day partitions, on every engine it claims to support.
 *
 * SQLite runs always (a temp file) and MUST be unchanged by any of this: it has
 * no declarative partitioning, so every assertion below has to hold on the
 * single table it always had. Postgres runs when AMR_ROUTER_TEST_PG points at
 * one, following this repo's convention for store tests.
 *
 * What is actually being defended: retention on a store taking 33-165 GB a day
 * cannot be a bulk DELETE, and the conversion to something cheaper must not
 * change a single figure a bill is read from — nor lose a row on a deployment
 * that upgrades into it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { createSqlLedger } from "../src/cost/ledger-sql.ts";
import { exportRows, spendUsdSince } from "../src/cost/views.ts";
import { EMPTY_USAGE, type AsyncLedger, type LedgerEntry } from "../src/cost/types.ts";
import type { Logger } from "../src/util/log.ts";
import {
	droppableLedgerPartitions,
	ensureLedgerPartitions,
	ledgerDayStart,
	ledgerLayout,
	ledgerPartitionName,
	migrateStore,
} from "../src/util/schema.ts";
import { num, openSqlDb, type SqlDb } from "../src/util/sql.ts";

const DAY = 86_400_000;
const PG = process.env.AMR_ROUTER_TEST_PG;

const engines: { name: string; url: string; partitions: boolean }[] = [
	{ name: "sqlite", url: `sqlite://${join(tmpdir(), `ledger-part-${process.pid}-${Date.now()}.db`)}`, partitions: false },
	...(PG === undefined ? [] : [{ name: "postgres", url: PG, partitions: true }]),
];

function entry(over: Partial<LedgerEntry> & { id: string }): LedgerEntry {
	return {
		createdAtMs: Date.now(),
		conversationKey: `conv-${over.id}`,
		sessionId: `sess-${over.id}`,
		turn: 1,
		requestedModel: "auto",
		harnessId: "hp",
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
		promptTokensSaved: null,
		scope: "team/proj",
		redactions: null,
		...over,
	} as unknown as LedgerEntry;
}

/** Live day partitions of the ledger, by name; empty on an unpartitioned store. */
async function partitionsOf(db: SqlDb): Promise<string[]> {
	if ((await ledgerLayout(db)) !== "partitioned") return [];
	const rows = await db.query<{ name: string }>(
		"SELECT c.relname AS name FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid WHERE i.inhparent = to_regclass('ledger') ORDER BY 1",
	);
	return rows.map((r) => r.name);
}

for (const engine of engines) {
	describe(`ledger partitioning on ${engine.name}`, () => {
		let db: SqlDb;
		const cfg: RouterConfig = { ...structuredClone(DEFAULT_CONFIG), ledger: { ...DEFAULT_CONFIG.ledger, path: engine.url } };
		let ledger: AsyncLedger;

		/** A fresh store: what a NEW deployment boots into, not what an old one upgraded to. */
		const fresh = async (): Promise<void> => {
			if (db.dialect === "postgres") await db.sql.unsafe("DROP TABLE IF EXISTS ledger");
			await migrateStore(db);
		};

		beforeAll(async () => {
			db = openSqlDb(engine.url);
			await fresh();
			ledger = createSqlLedger(db, cfg, { findModel: () => null });
		});

		afterAll(async () => {
			// Leave the shared database in the shape a fresh boot produces, whatever
			// the legacy test below did to it.
			await fresh();
			await db.close();
		});

		beforeEach(async () => {
			await db.sql.unsafe("DELETE FROM ledger");
			await db.sql.unsafe("DELETE FROM feedback");
		});

		test("a fresh store partitions by day on postgres and not on sqlite, and a turn writes and reads back", async () => {
			expect(await ledgerLayout(db)).toBe(engine.partitions ? "partitioned" : "plain");
			// Ahead of need: today's partition exists before any turn arrives, and
			// so do the next few days, so a turn at 23:59:59 cannot be the first to
			// need tomorrow's.
			const today = ledgerDayStart(Date.now());
			const expected = engine.partitions
				? [-1, 0, 1, 2, 3].map((d) => ledgerPartitionName(today + d * DAY))
				: [];
			expect(await partitionsOf(db)).toEqual(expected);

			await ledger.record(entry({ id: "t1", reportedUsd: 0.5 }));
			const recent = await ledger.recentEntries(10);
			expect(recent.map((e) => e.id)).toEqual(["t1"]);
			// The JSON columns and the money survive the trip through a partition.
			expect(recent[0]?.usage.promptTokens).toBe(100);
			expect(recent[0]?.reasons).toEqual(["cheapest"]);
			expect(await ledger.spendSince(0, "hp")).toBeCloseTo(0.5, 9);
			expect((await ledger.latestForSession("omp-t1"))?.id).toBe("t1");
		});

		test("a turn for a day nobody provisioned still records, and the day exists afterwards", async () => {
			// 40 days back is outside every partition `migrateStore` created. On
			// Postgres the insert is refused once, the day is created, and the row
			// lands — the caller never sees a failure, because a ledger row is a
			// bill and there is no second copy of it.
			const backdated = Date.now() - 40 * DAY;
			await ledger.record(entry({ id: "late", createdAtMs: backdated, reportedUsd: 0.25 }));
			// And forwards: a process that has been up for a week.
			const ahead = Date.now() + 9 * DAY;
			await ledger.record(entry({ id: "ahead", createdAtMs: ahead, reportedUsd: 0.75 }));

			expect((await ledger.recentEntries(10)).map((e) => e.id).sort()).toEqual(["ahead", "late"]);
			expect(await ledger.spendSince(0, "hp")).toBeCloseTo(1, 9);
			if (!engine.partitions) return;
			const live = await partitionsOf(db);
			expect(live).toContain(ledgerPartitionName(ledgerDayStart(backdated)));
			expect(live).toContain(ledgerPartitionName(ledgerDayStart(ahead)));
		});

		test("prune drops whole days, keeps the recent window, and counts rows rather than partitions", async () => {
			// One instant for both the rows and the cutoff: `oldestKeptMs` is an
			// exact row timestamp, so a second Date.now() would be milliseconds off.
			const nowMs = Date.now();
			for (const age of [400, 200, 1]) {
				await ledger.record(entry({ id: `p${age}`, createdAtMs: nowMs - age * DAY }));
			}
			expect(await ledger.prune(365, nowMs)).toEqual({ deleted: 1, oldestKeptMs: expect.any(Number) });
			expect((await ledger.recentEntries(10)).map((e) => e.id).sort()).toEqual(["p1", "p200"]);
			if (engine.partitions) {
				// The dropped day is gone as a table, not just as rows.
				expect(await partitionsOf(db)).not.toContain(ledgerPartitionName(ledgerDayStart(nowMs - 400 * DAY)));
				expect(await partitionsOf(db)).toContain(ledgerPartitionName(ledgerDayStart(nowMs - 200 * DAY)));
			}
			expect((await ledger.prune(30, nowMs)).deleted).toBe(1);
			expect((await ledger.recentEntries(10)).map((e) => e.id)).toEqual(["p1"]);
			// Nothing left to remove, and the window is reported from real rows.
			expect(await ledger.prune(30, nowMs)).toEqual({ deleted: 0, oldestKeptMs: nowMs - DAY });
		});

		test("the boundary day the cutoff falls inside is pruned row by row, so the count stays honest", async () => {
			// The cutoff at noon splits a day: its partition holds rows on both
			// sides of it and must not be dropped, while the day before it goes
			// whole. `deleted` has to count both kinds of row and nothing else.
			const cutoff = ledgerDayStart(Date.now()) + 12 * 3_600_000;
			const nowMs = cutoff + DAY;
			await ledger.record(entry({ id: "b_before", createdAtMs: cutoff - 60_000 }));
			await ledger.record(entry({ id: "b_after", createdAtMs: cutoff + 60_000 }));
			await ledger.record(entry({ id: "b_whole", createdAtMs: cutoff - 2 * DAY }));

			expect((await ledger.prune(1, nowMs)).deleted).toBe(2);
			expect((await ledger.recentEntries(10)).map((e) => e.id)).toEqual(["b_after"]);
			if (!engine.partitions) return;
			const live = await partitionsOf(db);
			expect(live).toContain(ledgerPartitionName(ledgerDayStart(cutoff)));
			expect(live).not.toContain(ledgerPartitionName(ledgerDayStart(cutoff - 2 * DAY)));
			// And the partial day was not covered by a drop: the helper only ever
			// offers partitions whose whole range is behind the cutoff.
			expect(await droppableLedgerPartitions(db, cutoff)).not.toContain(ledgerPartitionName(ledgerDayStart(cutoff)));
		});

		test("export, spend and cap reads see exactly what they saw before partitioning", async () => {
			const day = ledgerDayStart(Date.now()) + 3_600_000;
			await ledger.record(entry({ id: "v1", createdAtMs: day, reportedUsd: 1 }));
			await ledger.record(entry({ id: "v2", createdAtMs: day + 60_000, reportedUsd: 2, harnessId: "other" }));
			await ledger.record(entry({ id: "v3", createdAtMs: day - 2 * DAY, reportedUsd: 4 }));

			const rows = await exportRows(db, 0, null);
			expect(rows.map((r) => [r.day, r.harnessId, r.dispatches, r.spendUsd])).toEqual([
				[new Date(day - 2 * DAY).toISOString().slice(0, 10), "hp", 1, 4],
				[new Date(day).toISOString().slice(0, 10), "hp", 1, 1],
				[new Date(day).toISOString().slice(0, 10), "other", 1, 2],
			]);
			expect(rows.every((r) => r.scope === "team/proj")).toBe(true);
			// The cap reads: whole ledger, one harness, one window, one project.
			expect(await spendUsdSince(db, 0, null)).toBeCloseTo(7, 9);
			expect(await spendUsdSince(db, 0, ["hp"])).toBeCloseTo(5, 9);
			expect(await spendUsdSince(db, day, null)).toBeCloseTo(3, 9);
			expect(await spendUsdSince(db, 0, null, "team/proj")).toBeCloseTo(7, 9);
			expect(await ledger.spendSince(day - DAY, "hp")).toBeCloseTo(1, 9);
			expect(await ledger.conversationSpend("conv-v3")).toBeCloseTo(4, 9);
			expect((await ledger.trust("x/model", "hp"))?.attempts).toBe(2);
		});

		test("ensuring partitions is idempotent and never touches an unpartitioned store", async () => {
			const before = await partitionsOf(db);
			await ensureLedgerPartitions(db);
			await ensureLedgerPartitions(db);
			expect(await partitionsOf(db)).toEqual(before);
			expect(await ledgerLayout(db)).toBe(engine.partitions ? "partitioned" : "plain");
		});
	});
}

/**
 * The upgrade path. A deployment with a populated, unpartitioned `ledger` is
 * holding billing history with no second copy, and Postgres cannot convert a
 * table to a partitioned one in place — so the chosen behaviour is to leave it
 * exactly as it is, say so once, and keep working.
 */
describe.skipIf(PG === undefined)("a legacy unpartitioned postgres ledger", () => {
	let db: SqlDb;
	const cfg: RouterConfig = { ...structuredClone(DEFAULT_CONFIG), ledger: { ...DEFAULT_CONFIG.ledger, path: PG ?? "" } };
	const warnings: string[] = [];
	const capture: Logger = {
		error: () => {},
		warn: (msg) => warnings.push(msg),
		info: () => {},
		debug: () => {},
	};

	beforeAll(async () => {
		db = openSqlDb(PG as string);
		await db.sql.unsafe("DROP TABLE IF EXISTS ledger");
		await migrateStore(db);
		// Reshape it into what an older release left behind: the same columns, one
		// plain table. `LIKE` copies the column list off the partitioned parent,
		// so this fixture cannot drift from the real schema.
		await db.sql.unsafe("DROP TABLE IF EXISTS ledger_legacy_fixture");
		await db.sql.unsafe("CREATE TABLE ledger_legacy_fixture (LIKE ledger INCLUDING DEFAULTS)");
		await db.sql.unsafe("DROP TABLE ledger");
		await db.sql.unsafe("ALTER TABLE ledger_legacy_fixture RENAME TO ledger");
		await db.sql.unsafe("ALTER TABLE ledger ADD PRIMARY KEY (id)");
	});

	afterAll(async () => {
		await db.sql.unsafe("DROP TABLE IF EXISTS ledger");
		await migrateStore(db);
		await db.close();
	});

	test("it is left alone, its rows are kept, and the operator is told once how to convert", async () => {
		const ledger = createSqlLedger(db, cfg, { findModel: () => null });
		await ledger.record(entry({ id: "legacy1", createdAtMs: Date.now() - 400 * DAY, reportedUsd: 3 }));
		warnings.length = 0;

		await migrateStore(db, capture);

		expect(await ledgerLayout(db)).toBe("plain");
		expect(num((await db.one<{ n: unknown }>("SELECT COUNT(*) AS n FROM ledger"))?.n)).toBe(1);
		expect(warnings.filter((w) => w.includes("not partitioned"))).toHaveLength(1);
		// Still a working ledger, and retention still applies — row-wise, which is
		// the cost of not converting.
		await ledger.record(entry({ id: "legacy2", reportedUsd: 5 }));
		expect(await ledger.spendSince(0, "hp")).toBeCloseTo(8, 9);
		expect(await droppableLedgerPartitions(db, Date.now())).toEqual([]);
		expect((await ledger.prune(365)).deleted).toBe(1);
		expect((await ledger.recentEntries(10)).map((e) => e.id)).toEqual(["legacy2"]);
	});

	test("every read returns the same figures on the partitioned table as on the legacy one", async () => {
		// The same three turns, read twice: once through the table a deployment
		// already has, once through the partitioned one a fresh boot creates. Any
		// difference here is a bill that changed because of a storage decision.
		const rows = [
			entry({ id: "same1", createdAtMs: ledgerDayStart(Date.now()) + 3_600_000, reportedUsd: 1 }),
			entry({ id: "same2", createdAtMs: ledgerDayStart(Date.now()) + 7_200_000, reportedUsd: 2, harnessId: "other" }),
			entry({ id: "same3", createdAtMs: ledgerDayStart(Date.now()) - 5 * DAY, reportedUsd: 4 }),
		];
		const read = async (): Promise<unknown> => {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			await db.sql.unsafe("DELETE FROM ledger");
			for (const row of rows) await ledger.record(row);
			return {
				exported: await exportRows(db, 0, null),
				all: await spendUsdSince(db, 0, null),
				scoped: await spendUsdSince(db, 0, ["hp"]),
				project: await spendUsdSince(db, 0, null, "team/proj"),
				trust: await ledger.trust("x/model"),
				entries: (await ledger.recentEntries(10)).map((e) => e.id),
			};
		};

		expect(await ledgerLayout(db)).toBe("plain");
		const legacy = await read();

		await db.sql.unsafe("DROP TABLE ledger");
		await migrateStore(db);
		expect(await ledgerLayout(db)).toBe("partitioned");
		expect(await read()).toEqual(legacy);
	});
});
