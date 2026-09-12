/**
 * The store's schema, for either engine.
 *
 * `util/sqlite.ts` remains the migration path for a SQLite FILE that already
 * exists: nineteen versions have shipped, and an old file still needs its
 * `ALTER TABLE`s applied in order. This module declares the FINAL shape of
 * every table instead, which is what a fresh store needs — a Postgres database
 * has no history to migrate, and on an already-migrated file every statement
 * here is a no-op.
 *
 * The two must agree, so the definitions below are transcribed from
 * `util/sqlite.ts` with its incremental columns folded in, and
 * `test/schema.test.ts` compares the two engine-by-engine rather than trusting
 * that they were copied correctly.
 */

import type { SqlDb } from "./sql.ts";

/**
 * Creates every table and index the router uses. Idempotent, so boot order
 * never matters — the property the SQLite bootstrap has always had.
 */
export async function migrateStore(db: SqlDb): Promise<void> {
	const json = db.type("json");
	const float = db.type("float");
	const big = db.type("bigint");
	// A single-row cache keyed on a constant: `CHECK (id = 1)` is portable, and
	// it is what keeps a second payload from ever accumulating.
	const singleton = (name: string, extra = ""): string =>
		`CREATE TABLE IF NOT EXISTS ${name} (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			payload ${json} NOT NULL,
			fetched_at_ms ${big} NOT NULL${extra}
		)`;

	const statements: string[] = [
		singleton("catalog_cache", `,\n\t\t\tetag TEXT,\n\t\t\tkey_scoped INTEGER NOT NULL DEFAULT 0`),
		singleton("ollama_catalog_cache"),
		singleton("benchmark_cache"),
		singleton("local_scores"),

		// One row per dispatched upstream generation. The columns nineteen
		// migrations added are declared here as they finally stand.
		`CREATE TABLE IF NOT EXISTS ledger (
			id TEXT PRIMARY KEY,
			created_at_ms ${big} NOT NULL,
			conversation_key TEXT NOT NULL,
			session_id TEXT NOT NULL,
			turn INTEGER NOT NULL,
			requested_model TEXT NOT NULL,
			harness_id TEXT NOT NULL DEFAULT '',
			omp_session_id TEXT NOT NULL DEFAULT '',
			slug TEXT NOT NULL,
			served_slug TEXT,
			tier TEXT NOT NULL,
			classification_source TEXT NOT NULL,
			reasons ${json} NOT NULL,
			predicted_usd ${float} NOT NULL,
			reported_usd ${float},
			usage ${json} NOT NULL,
			cost_breakdown ${json},
			attempt INTEGER NOT NULL,
			escalation_signal TEXT,
			latency_ms INTEGER NOT NULL,
			ttft_ms INTEGER,
			finish_reason TEXT,
			wasted INTEGER NOT NULL DEFAULT 0,
			upstream_generation_id TEXT,
			error TEXT,
			error_kind TEXT,
			features ${json},
			score ${float},
			confidence ${float},
			task TEXT,
			classifier_reasons ${json},
			explored_from TEXT,
			hold_arm INTEGER,
			prompt_tokens_saved INTEGER,
			scope TEXT,
			redactions INTEGER
		)`,
		"CREATE INDEX IF NOT EXISTS idx_ledger_conversation ON ledger (conversation_key)",
		"CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger (created_at_ms)",
		"CREATE INDEX IF NOT EXISTS idx_ledger_slug ON ledger (slug)",
		// Per-slug newest-first reads (the latency window, any windowed trust).
		// Without this they sorted every row the slug ever had: measured on a
		// real ledger, 5-10ms and RISING with history against a flat 0.04-0.08ms.
		"CREATE INDEX IF NOT EXISTS idx_ledger_slug_created ON ledger (slug, created_at_ms DESC)",
		"CREATE INDEX IF NOT EXISTS idx_ledger_harness_created ON ledger (harness_id, created_at_ms DESC)",
		"CREATE INDEX IF NOT EXISTS idx_ledger_slug_harness_created ON ledger (slug, harness_id, created_at_ms DESC)",
		"CREATE INDEX IF NOT EXISTS idx_ledger_session ON ledger (omp_session_id, created_at_ms DESC)",

		`CREATE TABLE IF NOT EXISTS token_calibration (
			tokenizer TEXT PRIMARY KEY,
			est_bytes ${big} NOT NULL,
			actual_tokens ${big} NOT NULL,
			samples ${big} NOT NULL
		)`,

		// Per-conversation routing memory: the sticky window, which model's
		// prompt cache is warm, and the accumulated spend the budget guard reads.
		`CREATE TABLE IF NOT EXISTS conversations (
			key TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			turn INTEGER NOT NULL DEFAULT 0,
			current_slug TEXT,
			current_tier TEXT,
			sticky_until_turn INTEGER NOT NULL DEFAULT 0,
			escalations INTEGER NOT NULL DEFAULT 0,
			spent_usd ${float} NOT NULL DEFAULT 0,
			last_prompt_tokens INTEGER NOT NULL DEFAULT 0,
			cache_warm_slug TEXT,
			cache_warm_at_ms ${big} NOT NULL DEFAULT 0,
			context_version TEXT,
			context_fetched_at_ms ${big} NOT NULL DEFAULT 0,
			compaction_plan ${json},
			compaction_plan_tokens INTEGER NOT NULL DEFAULT 0,
			upgrade_deferred_tier TEXT,
			updated_at_ms ${big} NOT NULL DEFAULT 0
		)`,

		// agentdox bridge. Blocks are content-addressed so many conversations on
		// one project share a copy, and so a restart can re-inject the SAME bytes
		// a conversation was already using (the upstream cache outlives us).
		`CREATE TABLE IF NOT EXISTS context_blocks (
			version TEXT PRIMARY KEY,
			scope TEXT NOT NULL,
			block TEXT NOT NULL,
			fetched_at_ms ${big} NOT NULL
		)`,

		// Plan-meter readings beside the ledger's own Ollama total at the same
		// instant, so the estimate can be calibrated against the bill.
		`CREATE TABLE IF NOT EXISTS ollama_meter_samples (
			at_ms ${big} PRIMARY KEY,
			meter_usd ${float} NOT NULL,
			ledger_usd ${float} NOT NULL
		)`,

		// User verdicts on routed turns, tied to the ledger row judged.
		`CREATE TABLE IF NOT EXISTS feedback (
			id TEXT PRIMARY KEY,
			ledger_id TEXT NOT NULL,
			omp_session_id TEXT NOT NULL DEFAULT '',
			slug TEXT NOT NULL,
			tier TEXT NOT NULL,
			verdict TEXT NOT NULL,
			note TEXT NOT NULL DEFAULT '',
			created_at_ms ${big} NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at_ms)",
		"CREATE INDEX IF NOT EXISTS idx_feedback_ledger ON feedback (ledger_id)",

		// Small durable markers (when the daily summary was last posted, per harness).
		`CREATE TABLE IF NOT EXISTS router_kv (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at_ms ${big} NOT NULL
		)`,

		`CREATE TABLE IF NOT EXISTS agentdox_sessions (
			conversation_key TEXT PRIMARY KEY,
			scope TEXT NOT NULL,
			session_id TEXT NOT NULL,
			created_at_ms ${big} NOT NULL
		)`,
	];

	// `IF NOT EXISTS` is not atomic on Postgres: two replicas booting against a
	// fresh database both pass the existence check and the loser fails on the
	// unique index over pg_type (23505), or on the table name itself (42P07 /
	// 42710). Measured: one of two replicas started together died with
	// "duplicate key value violates unique constraint pg_type_typname_nsp_index".
	// The condition those errors report is the condition the statement asked to
	// tolerate, so they are the success case arriving from the other replica.
	const RACED = new Set(["23505", "42P07", "42710"]);
	for (const statement of statements) {
		try {
			await db.sql.unsafe(statement);
		} catch (err) {
			const code = (err as { errno?: unknown }).errno;
			if (!RACED.has(String(code))) throw err;
		}
	}
}

/** Every table `migrateStore` creates, for tests and for teardown. */
export const STORE_TABLES = [
	"catalog_cache",
	"ollama_catalog_cache",
	"benchmark_cache",
	"local_scores",
	"ledger",
	"token_calibration",
	"conversations",
	"context_blocks",
	"ollama_meter_samples",
	"feedback",
	"router_kv",
	"agentdox_sessions",
] as const;
