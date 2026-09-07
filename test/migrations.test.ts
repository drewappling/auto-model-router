import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { createFeedbackStore } from "../src/cost/feedback.ts";
import { createLedger } from "../src/cost/ledger.ts";
import { buildUsageReport } from "../src/cost/report.ts";
import { buildDailySummary, createKv } from "../src/cost/summary.ts";
import { createConversationStore } from "../src/router/state.ts";
import { openDb } from "../src/util/sqlite.ts";

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
const CURRENT_VERSION = 17;

describe("schema migrations from every shipped version", () => {
	test("fixtures exist for the versions that shipped", () => {
		expect(files.map((f) => Number(/\d+/.exec(f)![0]))).toEqual([4, 5, 10, 12, 13, 14, 16]);
	});

	for (const file of files) {
		const from = Number(/\d+/.exec(file)![0]);
		test(`v${from} → v${CURRENT_VERSION}: opens, migrates, keeps its rows, and every consumer runs`, () => {
			const dir = mkdtempSync(join(tmpdir(), "amr-migrate-"));
			const path = join(dir, "router.db");
			copyFileSync(join(FIXTURES, file), path);
			const cfg = structuredClone(DEFAULT_CONFIG);
			cfg.ledger.path = path;
			const db = openDb(path);
			try {
				expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(CURRENT_VERSION);
				// Every column the current code writes exists after migration.
				const ledgerCols = new Set((db.query("PRAGMA table_info(ledger)").all() as { name: string }[]).map((c) => c.name));
				for (const c of ["harness_id", "error_kind", "omp_session_id", "features", "explored_from", "hold_arm", "prompt_tokens_saved"]) expect(ledgerCols.has(c)).toBe(true);
				const convCols = new Set((db.query("PRAGMA table_info(conversations)").all() as { name: string }[]).map((c) => c.name));
				for (const c of ["context_version", "compaction_plan", "compaction_plan_tokens", "upgrade_deferred_tier"]) expect(convCols.has(c)).toBe(true);
				// The fixture's ledger row survived the ALTERs with its values.
				const row = db.query("SELECT id, error, slug FROM ledger").get() as { id: string; error: string | null; slug: string } | null;
				expect(row).toEqual({ id: "fixture-id", error: "upstream_error: 502", slug: "fixture-slug" });
				// Every prepared statement compiles and every consumer runs on the migrated file.
				const ledger = createLedger(db, cfg);
				const conversations = createConversationStore(db);
				createFeedbackStore(db);
				createKv(db);
				expect(ledger.recentEntries(5)).toHaveLength(1);
				expect(ledger.trust("fixture-slug")).not.toBeNull();
				expect(ledger.softFailureSpikes?.()).toEqual([]);
				expect(ledger.latestForSession?.("nope")).toBeNull();
				expect(conversations.load("fixture-key").key).toBe("fixture-key");
				expect(buildUsageReport(db, { windowDays: 3650 }).totals.dispatches).toBe(1);
				expect(buildDailySummary(db, {}).current.dispatches).toBe(0);
				expect(ledger.prune?.(0)).toBe(0);
			} finally {
				db.close();
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// Windows keeps the file locked until the statements are collected; the temp dir is disposable.
				}
			}
		});
	}

	test("a fresh database lands on the same version as a migrated one", () => {
		const db = openDb(":memory:");
		try {
			expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(CURRENT_VERSION);
		} finally {
			db.close();
		}
	});
});
