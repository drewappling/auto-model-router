/**
 * SQLite bootstrap. This is the ONLY migration path: every table the router
 * needs is created here, idempotently, so boot order never matters.
 *
 * Tables:
 *  - catalog_cache: single-row (id = 1) store of the last raw OpenRouter
 *    catalog payload, so restarts route from disk while a refresh is pending.
 *  - ledger: one row per dispatched upstream generation (see cost/types.ts
 *    LedgerEntry). `reasons`, `usage`, and `cost_breakdown` are JSON text.
 *  - token_calibration: running sums of estimated prompt bytes vs. actual
 *    billed prompt tokens per tokenizer family (see tokens/estimate.ts).
 *  - conversations: per-conversation routing memory, written by the
 *    RouterBrain slice's ConversationStore (it codes against these columns).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Bump when a migration is added; guarded below so reopening never regresses it. */
const USER_VERSION = 2;

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS catalog_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  etag TEXT,
  key_scoped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ledger (
  id TEXT PRIMARY KEY,
  created_at_ms INTEGER NOT NULL,
  conversation_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  requested_model TEXT NOT NULL,
  slug TEXT NOT NULL,
  served_slug TEXT,
  tier TEXT NOT NULL,
  classification_source TEXT NOT NULL,
  reasons TEXT NOT NULL,
  predicted_usd REAL NOT NULL,
  reported_usd REAL,
  usage TEXT NOT NULL,
  cost_breakdown TEXT,
  attempt INTEGER NOT NULL,
  escalation_signal TEXT,
  latency_ms INTEGER NOT NULL,
  ttft_ms INTEGER,
  finish_reason TEXT,
  wasted INTEGER NOT NULL DEFAULT 0,
  upstream_generation_id TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_conversation ON ledger (conversation_key);
CREATE INDEX IF NOT EXISTS idx_ledger_created ON ledger (created_at_ms);
CREATE INDEX IF NOT EXISTS idx_ledger_slug ON ledger (slug);

CREATE TABLE IF NOT EXISTS token_calibration (
  tokenizer TEXT PRIMARY KEY,
  est_bytes INTEGER NOT NULL,
  actual_tokens INTEGER NOT NULL,
  samples INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL DEFAULT 0,
  current_slug TEXT,
  current_tier TEXT,
  sticky_until_turn INTEGER NOT NULL DEFAULT 0,
  escalations INTEGER NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  last_prompt_tokens INTEGER NOT NULL DEFAULT 0,
  cache_warm_slug TEXT,
  cache_warm_at_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL DEFAULT 0
);

-- v2: catalog_cache gains key_scoped provenance. ALTER TABLE ADD COLUMN is
-- idempotent only via a guard; SQLite has no IF NOT EXISTS for columns, so
-- probe pragma_table_info and add when absent.
`;

const MIGRATE_V2 = `
ALTER TABLE catalog_cache ADD COLUMN key_scoped INTEGER NOT NULL DEFAULT 0;
`;

export function openDb(path: string): Database {
	// ":memory:" has no parent directory to create.
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	// WAL + NORMAL: single-writer local service; favours read latency on the turn hot path.
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec(MIGRATIONS);
	// PRAGMA user_version always returns exactly one row with one integer column.
	const versionRow = db.query("PRAGMA user_version").get() as { user_version: number };
	if (versionRow.user_version < USER_VERSION) {
		const cols = db.query("PRAGMA table_info(catalog_cache)").all() as { name: string }[];
		if (!cols.some((c) => c.name === "key_scoped")) db.exec(MIGRATE_V2);
		db.exec(`PRAGMA user_version = ${USER_VERSION}`);
	}
	return db;
}
