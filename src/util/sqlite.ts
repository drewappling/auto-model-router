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
const USER_VERSION = 12;

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS catalog_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  etag TEXT,
  key_scoped INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS benchmark_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS local_scores (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL
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

-- agentdox bridge. Blocks are content-addressed so many conversations on one
-- project share a single copy, and so a restart can re-inject the SAME bytes a
-- conversation was already using (OpenRouter's prompt cache outlives us).
CREATE TABLE IF NOT EXISTS context_blocks (
  version TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  block TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agentdox_sessions (
  conversation_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  session_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
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

// v6: classifier INPUTS. Before this the ledger recorded only what routing
// decided (tier, slug, cost, escalation) and never what it decided FROM, so a
// turn could not be replayed, and no weight could be fit offline. `features`
// is the verbatim feature vector as JSON; `score` and `confidence` are the
// classifier's own outputs, kept alongside because they are cheap and make
// weight drift detectable when the scorer changes under a fixed feature set.
// `classifier_reasons` is the per-feature breakdown, which `select.ts` drops
// from the decision trail on every path except a hysteresis hold.
//
// All nullable with no backfill: pre-v6 rows genuinely lack these inputs and
// NULL says so honestly. A DEFAULT would invent data that was never observed.
const MIGRATE_V6 = `
ALTER TABLE ledger ADD COLUMN features TEXT;
ALTER TABLE ledger ADD COLUMN score REAL;
ALTER TABLE ledger ADD COLUMN confidence REAL;
ALTER TABLE ledger ADD COLUMN task TEXT;
ALTER TABLE ledger ADD COLUMN classifier_reasons TEXT;
`;

// v7: records epsilon-greedy exploration. `explored_from` is the tier the
// classifier actually chose on a turn we deliberately routed one step
// cheaper; NULL means the turn was routed normally.
//
// This is the counterfactual the ledger could never observe before. Natural
// traffic only reveals UNDER-routing, because a tier that was too low
// escalates and leaves a trace, while a tier that was too high looks
// indistinguishable from a tier that was exactly right.
const MIGRATE_V7 = `
ALTER TABLE ledger ADD COLUMN explored_from TEXT;
`;

// v8: records the hold-length arm a conversation was assigned by hold
// exploration. NULL means the conversation was not part of the experiment.
//
// Recorded on EVERY turn of the conversation, not only the turns a hold
// actually affects, so arms can be compared on total conversation cost
// rather than on the subset the treatment happened to touch.
const MIGRATE_V8 = `
ALTER TABLE ledger ADD COLUMN hold_arm INTEGER;
`;

// v11: conversations pin an agentdox context version. Storing the version (not
// the block) keeps the row small; the block itself lives once in context_blocks.
const MIGRATE_V11 = `
ALTER TABLE conversations ADD COLUMN context_version TEXT;
ALTER TABLE conversations ADD COLUMN context_fetched_at_ms INTEGER NOT NULL DEFAULT 0;
`;

// v12: ledger records prompt tokens removed by context compaction, so the
// savings (and any over-aggressive elision) can be measured and tuned.
const MIGRATE_V12 = `
ALTER TABLE ledger ADD COLUMN prompt_tokens_saved INTEGER;
`;

// v9: benchmark_cache holds the external benchmark feeds (Artificial Analysis,
// BenchLM) that backfill quality scores OpenRouter leaves unpublished. It is a
// whole new table, created idempotently by the MIGRATIONS block above, so there
// is no ALTER guard here — the version bump alone records that the schema now
// includes it.

// v10: local_scores holds calibrated scores from our OWN eval harness
// (src/eval), a `local`-source feed applied only when benchmarks.useLocalScores
// is on. Another new table via the idempotent MIGRATIONS block; version bump
// only, no ALTER guard.

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
		if (!ledgerCols.some((c) => c.name === "features")) db.exec(MIGRATE_V6);
		if (!ledgerCols.some((c) => c.name === "explored_from")) db.exec(MIGRATE_V7);
		if (!ledgerCols.some((c) => c.name === "hold_arm")) db.exec(MIGRATE_V8);
		const convCols = db.query("PRAGMA table_info(conversations)").all() as { name: string }[];
		if (!convCols.some((c) => c.name === "context_version")) db.exec(MIGRATE_V11);
		if (!ledgerCols.some((c) => c.name === "prompt_tokens_saved")) db.exec(MIGRATE_V12);
		db.exec(`PRAGMA user_version = ${USER_VERSION}`);
	}
	return db;
}
