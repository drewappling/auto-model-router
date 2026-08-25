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
const USER_VERSION = 5;

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
  harness_id TEXT NOT NULL DEFAULT '',
  omp_session_id TEXT NOT NULL DEFAULT '',
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

const MIGRATE_V3 = `
ALTER TABLE ledger ADD COLUMN harness_id TEXT NOT NULL DEFAULT '';
`;

// v4: ledger gains error_kind, so per-model trust can count only failures the
// MODEL is responsible for. Before this, any non-null `error` counted against a
// model's reliability — including client aborts, account-level auth/policy
// refusals, and guardrail `model_unavailable`, none of which say anything about
// the model's quality. Those spurious demotions shrink the candidate pool and
// push traffic onto a handful of survivors.
//
// Existing rows are backfilled from the stored `error` text, which turn.ts
// writes as `"<kind>: <message>"` (the abort path writes the bare message
// "request aborted"). Anything unrecognised stays NULL and is treated as
// model-attributable, preserving the old, stricter behaviour for rows we
// cannot classify.
const MIGRATE_V4 = `
ALTER TABLE ledger ADD COLUMN error_kind TEXT;

UPDATE ledger SET error_kind = CASE
  WHEN error IS NULL THEN NULL
  WHEN error = 'request aborted' THEN 'aborted'
  WHEN instr(error, ': ') > 0 THEN substr(error, 1, instr(error, ': ') - 1)
  ELSE NULL
END
WHERE error IS NOT NULL;
`;

// v5: ledger gains omp_session_id, so the toast extension can scope decisions to
// its own omp session. Before this, the only scoping was per-harness, so two
// interactive omp sessions of the same harness (the default: empty) each
// surfaced the other's routing toasts from the shared ledger. Existing rows
// backfill to '' (unknown session), matching the no-header default.
const MIGRATE_V5 = `
ALTER TABLE ledger ADD COLUMN omp_session_id TEXT NOT NULL DEFAULT '';
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
		const cacheCols = db.query("PRAGMA table_info(catalog_cache)").all() as { name: string }[];
		if (!cacheCols.some((c) => c.name === "key_scoped")) db.exec(MIGRATE_V2);
		const ledgerCols = db.query("PRAGMA table_info(ledger)").all() as { name: string }[];
		if (!ledgerCols.some((c) => c.name === "harness_id")) db.exec(MIGRATE_V3);
		if (!ledgerCols.some((c) => c.name === "error_kind")) db.exec(MIGRATE_V4);
		if (!ledgerCols.some((c) => c.name === "omp_session_id")) db.exec(MIGRATE_V5);
		db.exec(`PRAGMA user_version = ${USER_VERSION}`);
	}
	return db;
}
