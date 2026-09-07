#!/usr/bin/env bun
/**
 * Regenerates the old-schema ledger fixtures that test/migrations.test.ts
 * opens with the CURRENT bootstrap.
 *
 *   bun tools/gen-migration-fixtures.ts
 *
 * For each release tag that changed the schema, the bootstrap of THAT tag is
 * taken from git, run against a fresh file, and a dummy row is inserted into
 * every table (filling each NOT NULL column without a default by its declared
 * type), so the migrations have data to carry, not just DDL. The WAL is folded
 * back into the main file and the result lands in test/fixtures/migrations/
 * as router-v<user_version>.db. Small (a few dozen KB each); commit them.
 *
 * Re-run only when adding a NEW historical version: rewriting existing
 * fixtures would erase the very thing the test guards.
 */

import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

/** One tag per schema version that shipped. */
const TAGS = ["v0.1.0", "v0.1.4", "v0.2.0", "v0.2.10", "v0.2.22", "v0.2.28", "v0.3.0"];
const OUT_DIR = join(import.meta.dir, "..", "test", "fixtures", "migrations");
mkdirSync(OUT_DIR, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "amr-migrations-"));

function dummy(type: string, name: string): string | number {
	const t = type.toUpperCase();
	if (name === "id" || name === "key") return `fixture-${name}`;
	if (name === "created_at_ms" || name === "updated_at_ms" || name === "fetched_at_ms") return 1_756_000_000_000;
	if (t.includes("INT") || t.includes("REAL")) return 1;
	if (name === "usage") return JSON.stringify({ promptTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 10, reasoningTokens: 0, images: 0 });
	if (name === "reasons") return JSON.stringify(["fixture"]);
	if (name === "payload") return JSON.stringify({ data: [] });
	return `fixture-${name}`;
}

for (const tag of TAGS) {
	const src = await $`git show ${tag}:src/util/sqlite.ts`.text();
	const modPath = join(work, `sqlite-${tag}.ts`);
	await Bun.write(modPath, src);
	const dbPath = join(work, `${tag}.db`);
	const mod = (await import(modPath)) as { openDb(path: string): Database };
	const db = mod.openDb(dbPath);
	const version = (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
	const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
	for (const table of tables) {
		const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
		// NOT NULL columns without a default, plus text primary keys (SQLite lets
		// a TEXT PRIMARY KEY be NULL, but the router never writes one that way).
		const fill = cols.filter((c) => (c.notnull === 1 && c.dflt_value === null && !(c.pk === 1 && c.type.toUpperCase().includes("INT"))) || (c.pk === 1 && !c.type.toUpperCase().includes("INT")));
		// A ledger row with an error string exercises the v4 error_kind backfill.
		const values = fill.map((c) => (table === "ledger" && c.name === "error" ? "upstream_error: 502" : dummy(c.type, c.name)));
		if (fill.length === 0) continue;
		db.run(`INSERT INTO ${table} (${fill.map((c) => c.name).join(", ")}) VALUES (${fill.map(() => "?").join(", ")})`, values);
		if (table === "ledger" && cols.some((c) => c.name === "error")) db.run(`UPDATE ledger SET error = 'upstream_error: 502'`);
	}
	db.run("PRAGMA wal_checkpoint(TRUNCATE)");
	db.run("PRAGMA journal_mode = DELETE");
	db.close();
	const out = join(OUT_DIR, `router-v${version}.db`);
	await Bun.write(out, Bun.file(dbPath));
	console.log(`${tag} → ${out} (user_version ${version}, tables: ${tables.join(", ")})`);
}
rmSync(work, { recursive: true, force: true });
