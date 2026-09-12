/**
 * The shim's schema against the SQLite bootstrap's.
 *
 * `util/schema.ts` declares the FINAL shape of every table; `util/sqlite.ts`
 * reaches the same shape by replaying nineteen migrations. They are written
 * twice, so they can drift — and drift here is silent: a missing column makes
 * the real owner's statements fail only when that code path runs, which is how
 * a live server refused to start earlier in this port.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateStore, STORE_TABLES } from "../src/util/schema.ts";
import { openSqlDb } from "../src/util/sql.ts";
import { openDb } from "../src/util/sqlite.ts";

const PG = process.env.AMR_ROUTER_TEST_PG;

/** Column names per table, as the engine reports them. */
async function columnsOf(url: string): Promise<Map<string, Set<string>>> {
	const db = openSqlDb(url);
	const out = new Map<string, Set<string>>();
	try {
		for (const table of STORE_TABLES) {
			const rows =
				db.dialect === "postgres"
					? await db.query<{ name: string }>(
							"SELECT column_name AS name FROM information_schema.columns WHERE table_name = $t",
							{ t: table },
						)
					: await db.query<{ name: string }>(`SELECT name FROM pragma_table_info(${JSON.stringify(table)})`);
			out.set(table, new Set(rows.map((r) => r.name)));
		}
	} finally {
		await db.close();
	}
	return out;
}

describe("store schema", () => {
	test("the shim creates every table the sqlite bootstrap does, with the same columns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "amr-schema-"));
		try {
			// The bootstrap's result, after all nineteen migrations.
			const legacyPath = join(dir, "legacy.db");
			openDb(legacyPath).close();
			const legacy = await columnsOf(legacyPath);

			// The shim's result on an empty store.
			const shimPath = join(dir, "shim.db");
			const shim = openSqlDb(shimPath);
			await migrateStore(shim);
			await shim.close();
			const fresh = await columnsOf(shimPath);

			for (const table of STORE_TABLES) {
				const expected = legacy.get(table) ?? new Set<string>();
				expect(expected.size, `${table} missing from the sqlite bootstrap`).toBeGreaterThan(0);
				const actual = fresh.get(table) ?? new Set<string>();
				// Sorted lists, so a failure names the column rather than the sizes.
				expect([...actual].sort(), table).toEqual([...expected].sort());
			}
		} finally {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* Windows may hold the WAL briefly */
			}
		}
	});

	test("it is idempotent: running it twice changes nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "amr-schema-idem-"));
		try {
			const path = join(dir, "twice.db");
			const db = openSqlDb(path);
			await migrateStore(db);
			await migrateStore(db);
			await db.close();
			const after = await columnsOf(path);
			expect(after.get("ledger")?.has("redactions")).toBe(true);
			expect(after.get("conversations")?.has("cache_warm_slug")).toBe(true);
		} finally {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* as above */
			}
		}
	});

	test.skipIf(PG === undefined)("it applies to postgres, twice, with the same columns as sqlite", async () => {
		const pg = openSqlDb(PG as string);
		try {
			for (const table of [...STORE_TABLES].reverse()) await pg.sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
			await migrateStore(pg);
			await migrateStore(pg);
		} finally {
			await pg.close();
		}
		const dir = mkdtempSync(join(tmpdir(), "amr-schema-pg-"));
		try {
			const litePath = join(dir, "lite.db");
			const lite = openSqlDb(litePath);
			await migrateStore(lite);
			await lite.close();

			const onPg = await columnsOf(PG as string);
			const onLite = await columnsOf(litePath);
			for (const table of STORE_TABLES) {
				expect([...(onPg.get(table) ?? [])].sort(), table).toEqual([...(onLite.get(table) ?? [])].sort());
			}
		} finally {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* as above */
			}
		}
	});
});
