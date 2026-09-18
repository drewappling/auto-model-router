/**
 * The store's schema, for either engine.
 *
 * `util/sqlite.ts` remains the migration path for a SQLite FILE that already
 * exists: twenty versions have shipped, and an old file still needs its
 * `ALTER TABLE`s applied in order. This module declares the FINAL shape of
 * every table instead, which is what a fresh store needs — a Postgres database
 * has no history to migrate, and on an already-migrated file every statement
 * here is a no-op.
 *
 * On Postgres the ledger is additionally PARTITIONED BY RANGE over
 * `created_at_ms`, one partition per UTC day. Retention is then a metadata
 * DROP rather than a bulk DELETE, which matters at the sizes this store is
 * built for: a ledger row is ~2.6 kB, and 10k-50k users write 33-165 GB a day
 * at 440-2200 writes a second. Deleting that competes for I/O with the inserts
 * it is trying to make room for, and leaves bloat autovacuum has to chase.
 *
 * Every read is unchanged: the bounds ARE ms-epoch integers, so a
 * `created_at_ms >= x` filter prunes partitions on its own and no query needs
 * to know the table is partitioned. SQLite has no declarative partitioning and
 * keeps exactly the shape it always had.
 *
 * The two must agree, so the definitions below are transcribed from
 * `util/sqlite.ts` with its incremental columns folded in, and
 * `test/schema.test.ts` compares the two engine-by-engine rather than trusting
 * that they were copied correctly.
 */

import type { Logger } from "./log.ts";
import type { SqlDb } from "./sql.ts";

const DAY_MS = 86_400_000;

/**
 * Days of ledger partitions provisioned ahead of today. A turn at 23:59:59
 * must not depend on a partition created at 00:00:00, and a process that runs
 * for days without rebooting still has runway.
 */
const LEDGER_PARTITION_AHEAD_DAYS = 3;

/** The start of the UTC day an ms-epoch instant falls in — a partition bound. */
export function ledgerDayStart(ms: number): number {
	return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** The partition holding the UTC day that starts at `dayStartMs`, e.g. `ledger_p20260914`. */
export function ledgerPartitionName(dayStartMs: number): string {
	return `ledger_p${new Date(dayStartMs).toISOString().slice(0, 10).replaceAll("-", "")}`;
}

/**
 * `IF NOT EXISTS` is not atomic on Postgres: two replicas booting against a
 * fresh database both pass the existence check and the loser fails on the
 * unique index over pg_type (23505), or on the table name itself (42P07 /
 * 42710). Measured: one of two replicas started together died with
 * "duplicate key value violates unique constraint pg_type_typname_nsp_index".
 * The condition those errors report is the condition the statement asked to
 * tolerate, so they are the success case arriving from the other replica.
 */
const RACED = new Set(["23505", "42P07", "42710"]);

async function createIfAbsent(db: SqlDb, statement: string): Promise<void> {
	try {
		await db.sql.unsafe(statement);
	} catch (err) {
		const code = err !== null && typeof err === "object" && "errno" in err ? String(err.errno) : "";
		if (!RACED.has(code)) throw err;
	}
}

/**
 * Columns added to `ledger` AFTER this shim shipped, as `<name> <type>`.
 *
 * `CREATE TABLE IF NOT EXISTS` declares the final shape for a store that does
 * not exist yet and does exactly nothing for one that does — so a Postgres
 * deployment that has been running since before a column was added would never
 * grow it, and the very next turn would fail its INSERT on an unknown column.
 * SQLite reaches the same place through `util/sqlite.ts`'s guarded ALTERs;
 * this is that path for the other engine, and it stays a list rather than a
 * version counter because `ADD COLUMN IF NOT EXISTS` is already the guard.
 *
 * On a partitioned ledger the ALTER applies to the parent and every partition
 * with it, which is what keeps a day's table from diverging from its parent.
 */
const PG_LEDGER_COLUMNS = ["request_id TEXT"] as const;

/** `42701` is "column already exists": another replica added it between the check and the ALTER. */
const ADDED_ALREADY = new Set([...RACED, "42701"]);

async function addColumnIfAbsent(db: SqlDb, table: string, column: string): Promise<void> {
	try {
		await db.sql.unsafe(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}`);
	} catch (err) {
		const code = err !== null && typeof err === "object" && "errno" in err ? String(err.errno) : "";
		if (!ADDED_ALREADY.has(code)) throw err;
	}
}

/**
 * How this store holds the ledger.
 *
 * `plain` is SQLite, and also a Postgres ledger created before partitioning
 * shipped: Postgres cannot convert a populated table to a partitioned one in
 * place, so an existing deployment keeps the table it has (see `migrateStore`).
 */
export async function ledgerLayout(db: SqlDb): Promise<"partitioned" | "plain" | "absent"> {
	if (db.dialect !== "postgres") return (await db.tableExists("ledger")) ? "plain" : "absent";
	const rows = await db.query<{ relkind: string }>("SELECT relkind FROM pg_class WHERE oid = to_regclass('ledger')");
	const kind = rows[0]?.relkind;
	if (kind === "p") return "partitioned";
	return kind === undefined ? "absent" : "plain";
}

/**
 * Creates the day partitions around `aroundMs` — yesterday through
 * `aheadDays` — so the write path never meets a day nobody provisioned.
 * Idempotent and a no-op on any store whose ledger is not partitioned.
 *
 * Yesterday is included because a row's `created_at_ms` is the instant the turn
 * STARTED: a boot just after midnight, or a replica whose clock trails the one
 * that provisioned, can still present the previous day.
 */
export async function ensureLedgerPartitions(db: SqlDb, aroundMs = Date.now(), aheadDays = LEDGER_PARTITION_AHEAD_DAYS): Promise<void> {
	if ((await ledgerLayout(db)) !== "partitioned") return;
	const today = ledgerDayStart(aroundMs);
	for (let start = today - DAY_MS; start <= today + aheadDays * DAY_MS; start += DAY_MS) {
		await createIfAbsent(
			db,
			`CREATE TABLE IF NOT EXISTS ${ledgerPartitionName(start)} PARTITION OF ledger FOR VALUES FROM (${start}) TO (${start + DAY_MS})`,
		);
	}
}

/**
 * Ledger partitions whose whole range ends at or before `upToMs`, oldest
 * first: the ones a retention cutoff covers completely.
 *
 * Bounds are read from the catalog rather than parsed out of the partition's
 * name, so a partition an operator attached by hand is judged on what it
 * actually holds, and one with an unreadable or DEFAULT bound is skipped
 * rather than guessed at — the rows in it are then pruned by the row-wise
 * DELETE, which is slower but never drops a day it did not verify.
 */
export async function droppableLedgerPartitions(db: SqlDb, upToMs: number): Promise<string[]> {
	if ((await ledgerLayout(db)) !== "partitioned") return [];
	const rows = await db.query<{ name: string; bound: string | null }>(
		`SELECT c.relname AS name, pg_get_expr(c.relpartbound, c.oid) AS bound
		 FROM pg_class c JOIN pg_inherits i ON i.inhrelid = c.oid
		 WHERE i.inhparent = to_regclass('ledger')`,
	);
	const covered: { name: string; endMs: number }[] = [];
	for (const row of rows) {
		const upper = /TO \('?(-?\d+)'?\)/.exec(row.bound ?? "");
		if (upper === null) continue;
		const endMs = Number(upper[1]);
		if (endMs <= upToMs) covered.push({ name: row.name, endMs });
	}
	covered.sort((a, b) => a.endMs - b.endMs);
	return covered.map((p) => p.name);
}

/**
 * Creates every table and index the router uses. Idempotent, so boot order
 * never matters — the property the SQLite bootstrap has always had.
 */
export async function migrateStore(db: SqlDb, log?: Logger): Promise<void> {
	// Postgres partitions the ledger by day; SQLite has no declarative
	// partitioning, so it keeps the single table it always had.
	const partitioned = db.dialect === "postgres" && (await ledgerLayout(db)) !== "plain";
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

		// One row per dispatched upstream generation. The columns twenty
		// migrations added are declared here as they finally stand.
		//
		// Partitioned by day on Postgres, which forces the primary key to
		// include the partition key — a unique index on a partitioned table has
		// to. `id` alone stays unique in practice (it is a fresh UUID per entry),
		// and a re-recorded entry carries the same `created_at_ms`, so the
		// ON CONFLICT guard in `record` still collapses it.
		`CREATE TABLE IF NOT EXISTS ledger (
			id TEXT${partitioned ? "" : " PRIMARY KEY"},
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
			redactions INTEGER,
			request_id TEXT${partitioned ? ",\n\t\t\tPRIMARY KEY (id, created_at_ms)" : ""}
		)${partitioned ? " PARTITION BY RANGE (created_at_ms)" : ""}`,
		// The composite key above cannot serve a lookup by `id` alone, which is
		// what the feedback join and `markWasted` do.
		...(partitioned ? ["CREATE INDEX IF NOT EXISTS idx_ledger_id ON ledger (id)"] : []),
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
		// One request id straight to its rows: what support does with an id a
		// customer quoted, and an escalated turn files several rows under it.
		"CREATE INDEX IF NOT EXISTS idx_ledger_request ON ledger (request_id)",

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

	// Before the statements, so the indexes below can name a column an existing
	// deployment is only now growing. A store that has no ledger yet gets the
	// whole shape from the CREATE TABLE and needs no top-up.
	if (db.dialect === "postgres" && (await db.tableExists("ledger"))) {
		for (const column of PG_LEDGER_COLUMNS) await addColumnIfAbsent(db, "ledger", column);
	}

	for (const statement of statements) await createIfAbsent(db, statement);

	if (db.dialect !== "postgres") return;
	if (partitioned) {
		// Ahead of need: the write path must never be the thing that discovers a
		// day has no partition (it recovers, but a bill should not depend on that).
		await ensureLedgerPartitions(db);
		return;
	}
	// A Postgres ledger from before this shipped. Postgres cannot convert a
	// populated table to a partitioned one in place, and copying a billing table
	// at boot is the one failure mode the ledger must not have, so the existing
	// table is left exactly as it is and retention keeps deleting rows. The
	// conversion is an operator's decision, taken with the router stopped.
	log?.warn("ledger is not partitioned by day, so retention will delete rows instead of dropping partitions; partitioning applies to new deployments", {
		convert:
			"stop every replica, then: ALTER TABLE ledger RENAME TO ledger_legacy; start the router (it recreates ledger partitioned); INSERT INTO ledger SELECT * FROM ledger_legacy; verify the counts match; DROP TABLE ledger_legacy",
	});
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
