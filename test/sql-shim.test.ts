/**
 * The dialect shim. Every case here is a way the two engines differ that cost
 * a real bug while the ledger was ported: a JSON boolean read as the wrong
 * type silently counted estimated cache hits as measured ones, a NULL
 * parameter without a cast made Postgres refuse to plan the statement, and a
 * repeated named bind mapped to the wrong slot reads the wrong column.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bindNamed, jsonParam, jsonValue, num, numOrNull, openSqlDb } from "../src/util/sql.ts";

describe("bindNamed", () => {
	test("numbers placeholders in order of first appearance, reusing a slot on postgres", async () => {
		const text = "SELECT * FROM t WHERE a >= $since AND (b < $until OR c = $since)";
		const pg = bindNamed(text, { since: 10, until: 20 }, true);
		expect(pg.text).toBe("SELECT * FROM t WHERE a >= $1 AND (b < $2 OR c = $1)");
		expect(pg.values).toEqual([10, 20]);

		// SQLite's `?` cannot reuse a slot, so a repeat binds again, in order.
		const lite = bindNamed(text, { since: 10, until: 20 }, false);
		expect(lite.text).toBe("SELECT * FROM t WHERE a >= ? AND (b < ? OR c = ?)");
		expect(lite.values).toEqual([10, 20, 10]);
	});

	test("leaves JSON paths alone and refuses an unbound name", async () => {
		// `'$.isSubagent'` is a JSON path, not a placeholder.
		const out = bindNamed("SELECT json_extract(features, '$.isSubagent') FROM t WHERE a = $a", { a: 1 }, true);
		expect(out.text).toContain("'$.isSubagent'");
		expect(out.values).toEqual([1]);
		// A missing bind is a programming error, not an implicit NULL.
		expect(() => bindNamed("SELECT $missing", {}, true)).toThrow();
	});
});

describe("numeric coercion", () => {
	test("postgres' string aggregates become numbers, and absent stays absent", async () => {
		// Postgres returns COUNT(*) and BIGINT sums as strings; the ledger's
		// helpers do arithmetic on them.
		expect(num("42")).toBe(42);
		expect(num(42)).toBe(42);
		// A nullable aggregate must not silently become 0.
		expect(num(null)).toBe(0);
		expect(numOrNull(null)).toBeNull();
		expect(numOrNull(undefined)).toBeNull();
		expect(numOrNull("2.5")).toBe(2.5);
	});
});

const engines = [
	{ name: "sqlite", url: `sqlite://${join(tmpdir(), `shim-${process.pid}-${Date.now()}.db`)}` },
	...(process.env.AMR_ROUTER_TEST_PG === undefined ? [] : [{ name: "postgres", url: process.env.AMR_ROUTER_TEST_PG }]),
];

for (const engine of engines) {
	describe(`shim on ${engine.name}`, () => {
		test("json members read back as number, text and boolean", async () => {
			const db = openSqlDb(engine.url);
			try {
				await db.sql.unsafe("DROP TABLE IF EXISTS shim_probe");
				await db.sql.unsafe(`CREATE TABLE shim_probe (id TEXT, u ${db.type("json")})`);
				await db.sql`INSERT INTO shim_probe (id, u) VALUES (${"a"}, ${jsonParam(db, { promptTokens: 42, kind: "chat", estimated: true })})`;
				await db.sql`INSERT INTO shim_probe (id, u) VALUES (${"b"}, ${jsonParam(db, { promptTokens: 1, kind: "chat", estimated: false })})`;

				const rows = await db.query<{ id: string; tok: unknown; kind: unknown; est: unknown }>(
					`SELECT id, ${db.jsonNum("u", "promptTokens")} AS tok, ${db.jsonText("u", "kind")} AS kind,
						${db.jsonBool("u", "estimated")} AS est
					FROM shim_probe WHERE id = $id`,
					{ id: "a" },
				);
				expect(num(rows[0]?.tok)).toBe(42);
				expect(rows[0]?.kind).toBe("chat");
				// The boolean is the case that differed: json_extract yields the
				// INTEGER 1, `->>` yields the TEXT 'true', and sqlite's IN does not
				// coerce between them.
				expect(num(rows[0]?.est)).toBe(1);

				const off = await db.one<{ est: unknown }>(
					`SELECT ${db.jsonBool("u", "estimated")} AS est FROM shim_probe WHERE id = $id`,
					{ id: "b" },
				);
				expect(num(off?.est)).toBe(0);

				// An aggregate over a JSON member: the reason jsonNum casts.
				const total = await db.one<{ n: unknown }>(`SELECT SUM(${db.jsonNum("u", "promptTokens")}) AS n FROM shim_probe`);
				expect(num(total?.n)).toBe(43);
			} finally {
				await db.sql.unsafe("DROP TABLE IF EXISTS shim_probe");
				await db.close();
			}
		});

		test("an optional filter works with a NULL parameter, and substring search matches", async () => {
			const db = openSqlDb(engine.url);
			try {
				await db.sql.unsafe("DROP TABLE IF EXISTS shim_filter");
				await db.sql.unsafe("CREATE TABLE shim_filter (h TEXT, reasons TEXT)");
				await db.sql`INSERT INTO shim_filter (h, reasons) VALUES (${"h1"}, ${"failover: upstream died"})`;
				await db.sql`INSERT INTO shim_filter (h, reasons) VALUES (${"h2"}, ${"cheapest"})`;

				// The `(${x} IS NULL OR col = ${x})` idiom: Postgres cannot infer a
				// type for a bare NULL placeholder without the cast.
				const all = await db.query<{ h: string }>(
					`SELECT h FROM shim_filter WHERE ($h${db.nullableText} IS NULL OR h = $h) ORDER BY h`,
					{ h: null },
				);
				expect(all.map((r) => r.h)).toEqual(["h1", "h2"]);

				const one = await db.query<{ h: string }>(
					`SELECT h FROM shim_filter WHERE ($h${db.nullableText} IS NULL OR h = $h)`,
					{ h: "h2" },
				);
				expect(one.map((r) => r.h)).toEqual(["h2"]);

				const failovers = await db.query<{ h: string }>(
					`SELECT h FROM shim_filter WHERE ${db.contains("reasons", "'failover:'")}`,
				);
				expect(failovers.map((r) => r.h)).toEqual(["h1"]);
			} finally {
				await db.sql.unsafe("DROP TABLE IF EXISTS shim_filter");
				await db.close();
			}
		});

		test("scalar minimum takes two arguments on both engines", async () => {
			const db = openSqlDb(engine.url);
			try {
				// Postgres reserves MIN for the aggregate; LEAST is the scalar.
				const row = await db.one<{ v: unknown }>(`SELECT ${db.least("3", "7")} AS v`);
				expect(num(row?.v)).toBe(3);
			} finally {
				await db.close();
			}
		});

		test("a json column round-trips whichever way it is stored", async () => {
			const db = openSqlDb(engine.url);
			try {
				await db.sql.unsafe("DROP TABLE IF EXISTS shim_rt");
				await db.sql.unsafe(`CREATE TABLE shim_rt (u ${db.type("json")})`);
				const value = { a: 1, nested: { b: [1, 2, 3] } };
				await db.sql`INSERT INTO shim_rt (u) VALUES (${jsonParam(db, value)})`;
				const row = await db.one<{ u: unknown }>("SELECT u FROM shim_rt");
				// Stringifying into a JSONB column stores a JSON *string*, and every
				// `->>` on it then reads NULL; jsonParam is what prevents that.
				expect(jsonValue<typeof value>(row?.u)).toEqual(value);
			} finally {
				await db.sql.unsafe("DROP TABLE IF EXISTS shim_rt");
				await db.close();
			}
		});
	});
}
