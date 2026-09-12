import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openDb } from "../src/util/sqlite.ts";
import { openSqlDb } from "../src/util/sql.ts";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createFeedbackStore } from "../src/cost/feedback.ts";
import { createSqlLedger } from "../src/cost/ledger-sql.ts";
import { buildUsageReport } from "../src/cost/report.ts";
import { buildDailySummary, createKv } from "../src/cost/summary.ts";
import { exportRows, spendUsdSince } from "../src/cost/views.ts";
import { createConversationStore } from "../src/router/state.ts";

/**
 * Every ledger a past release wrote must open under the current bootstrap:
 * the version lands on the current number, every prepared statement the
 * router uses compiles against the migrated schema, the carried rows survive
 * with their backfills, and the aggregates run. The fixtures come from
 * tools/gen-migration-fixtures.ts (each tag's own bootstrap plus one row per
 * table), so a column added without a guard, or a statement that assumes a
 * column older files lack, fails here rather than on a user's install.
 */

const FIXTURES = join(import.meta.dir, "fixtures", "migrations");
const files = readdirSync(FIXTURES).filter((f) => /^router-v\d+\.db$/.test(f)).sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
const CURRENT_VERSION = 19;

describe("schema migrations from every shipped version", () => {
	test("fixtures exist for the versions that shipped", async () => {
		expect(files.map((f) => Number(/\d+/.exec(f)![0]))).toEqual([4, 5, 10, 12, 13, 14, 16]);
	});

	for (const file of files) {
		const from = Number(/\d+/.exec(file)![0]);
		test(`v${from} → v${CURRENT_VERSION}: opens, migrates, keeps its rows, and every consumer runs`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "amr-migrate-"));
			const path = join(dir, "router.db");
			copyFileSync(join(FIXTURES, file), path);
			const cfg = structuredClone(DEFAULT_CONFIG);
			cfg.ledger.path = path;
			// `openDb` is the migration path for a SQLite file: it applies the
			// nineteen versions in order. The shim handle then reads the result.
			const db = openDb(path);
			const sdb = openSqlDb(path);
			try {
				expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(CURRENT_VERSION);
				// Every column the current code writes exists after migration.
				const ledgerCols = new Set((db.query("PRAGMA table_info(ledger)").all() as { name: string }[]).map((c) => c.name));
				for (const c of ["harness_id", "error_kind", "omp_session_id", "features", "explored_from", "hold_arm", "prompt_tokens_saved", "scope", "redactions"]) expect(ledgerCols.has(c)).toBe(true);
				const convCols = new Set((db.query("PRAGMA table_info(conversations)").all() as { name: string }[]).map((c) => c.name));
				for (const c of ["context_version", "compaction_plan", "compaction_plan_tokens", "upgrade_deferred_tier"]) expect(convCols.has(c)).toBe(true);
				// The fixture's ledger row survived the ALTERs with its values.
				const row = db.query("SELECT id, error, slug FROM ledger").get() as { id: string; error: string | null; slug: string } | null;
				expect(row).toEqual({ id: "fixture-id", error: "upstream_error: 502", slug: "fixture-slug" });
				// Every prepared statement compiles and every consumer runs on the migrated file.
				const ledger = createSqlLedger(sdb, cfg, { findModel: () => null });
				const conversations = createConversationStore(sdb);
				createFeedbackStore(sdb);
				createKv(db);
				expect(await ledger.recentEntries(5)).toHaveLength(1);
				expect(await ledger.trust("fixture-slug")).not.toBeNull();
				expect(await ledger.softFailureSpikes()).toEqual([]);
				expect(await ledger.latestForSession("nope")).toBeNull();
				expect((await conversations.load("fixture-key")).key).toBe("fixture-key");
				expect((await buildUsageReport(sdb, { windowDays: 3650 })).totals.dispatches).toBe(1);
				expect((await buildDailySummary(sdb, {})).current.dispatches).toBe(0);
				// v18: the fixture's row predates `scope`, so it exports under "" and no
				// context scope claims its spend.
				expect((await exportRows(sdb, 0, null)).map((r) => r.scope)).toEqual([""]);
				expect(await spendUsdSince(sdb, 0, null, "acme.api")).toBe(0);
				expect(await spendUsdSince(sdb, 0, null)).toBeGreaterThanOrEqual(0);
				expect((await ledger.prune(0)).deleted).toBe(0);
				// v19: the fixture's row predates `redactions`, so nothing claims a
				// redaction happened on it and the report totals it as zero.
				expect((await buildUsageReport(sdb, { windowDays: 3650 })).totals.redactions).toBe(0);
			} finally {
				await sdb.close();
				db.close();
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// Windows keeps the file locked until the statements are collected; the temp dir is disposable.
				}
			}
		});
	}

	test("a fresh database lands on the same version as a migrated one", async () => {
		const db = openDb(join(tmpdir(), `t-migrations.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
		try {
			expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(CURRENT_VERSION);
			// A fresh ledger has the scope column the bootstrap never spells out in CREATE TABLE.
			expect((db.query("PRAGMA table_info(ledger)").all() as { name: string }[]).some((c) => c.name === "scope")).toBe(true);
		} finally {
			db.close();
		}
	});
});
