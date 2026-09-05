/**
 * Per-conversation routing memory.
 *
 * Persisted rather than in-memory so hysteresis and cache-warmth tracking
 * survive a restart: an omp session outlives this process, and forgetting
 * which model is warm would cold-start a paid prompt cache for no reason.
 *
 * The `conversations` table is created by `util/sqlite.ts`, the single
 * migration path.
 */

import type { Database, Statement } from "bun:sqlite";

import type { CompactionEdit } from "../wire/types.ts";
import type { ConversationState, ConversationStore, Tier } from "./types.ts";


/** Row shape as stored; column names are snake_case per the schema. */
interface Row {
	key: string;
	session_id: string;
	turn: number;
	current_slug: string | null;
	current_tier: string | null;
	sticky_until_turn: number;
	escalations: number;
	spent_usd: number;
	last_prompt_tokens: number;
	cache_warm_slug: string | null;
	cache_warm_at_ms: number;
	context_version: string | null;
	context_fetched_at_ms: number;
	compaction_plan: string | null;
	compaction_plan_tokens: number;
	updated_at_ms: number;
}

function toState(row: Row): ConversationState {
	return {
		key: row.key,
		sessionId: row.session_id,
		turn: row.turn,
		currentSlug: row.current_slug,
		// Stored as free text; the column is only ever written from a Tier.
		currentTier: row.current_tier as Tier | null,
		stickyUntilTurn: row.sticky_until_turn,
		escalations: row.escalations,
		spentUsd: row.spent_usd,
		lastPromptTokens: row.last_prompt_tokens,
		cacheWarmSlug: row.cache_warm_slug,
		cacheWarmAtMs: row.cache_warm_at_ms,
		contextVersion: row.context_version,
		contextFetchedAtMs: row.context_fetched_at_ms,
		compactionPlan: row.compaction_plan === null ? null : (JSON.parse(row.compaction_plan) as CompactionEdit[]),
		compactionPlanTokens: row.compaction_plan_tokens,
		updatedAtMs: row.updated_at_ms,
	};
}

export function createConversationStore(db: Database): ConversationStore {
	// Hoisted: this runs on every turn, twice when an escalation retries.
	const selectOne: Statement<Row, [string]> = db.query("SELECT * FROM conversations WHERE key = ?");
	const insertOne: Statement<unknown, [string, string, number]> = db.query(
		"INSERT INTO conversations (key, session_id, updated_at_ms) VALUES (?, ?, ?)",
	);
	// `spent_usd` and `escalations` are ABSENT from this statement on purpose.
	// They accumulate through `accrueOne` below, so writing a turn-start snapshot
	// back here would erase whatever a billed-but-uncommitted dispatch added.
	// The schema defaults both to 0, so the INSERT arm still works.
	const upsert = db.query(`
		INSERT INTO conversations (
			key, session_id, turn, current_slug, current_tier, sticky_until_turn,
			last_prompt_tokens, cache_warm_slug, cache_warm_at_ms,
			context_version, context_fetched_at_ms, compaction_plan, compaction_plan_tokens, updated_at_ms
		) VALUES ($key, $sessionId, $turn, $currentSlug, $currentTier, $stickyUntilTurn,
			$lastPromptTokens, $cacheWarmSlug, $cacheWarmAtMs,
			$contextVersion, $contextFetchedAtMs, $compactionPlan, $compactionPlanTokens, $updatedAtMs)
		ON CONFLICT(key) DO UPDATE SET
			session_id = excluded.session_id,
			turn = excluded.turn,
			current_slug = excluded.current_slug,
			current_tier = excluded.current_tier,
			sticky_until_turn = excluded.sticky_until_turn,
			last_prompt_tokens = excluded.last_prompt_tokens,
			cache_warm_slug = excluded.cache_warm_slug,
			cache_warm_at_ms = excluded.cache_warm_at_ms,
			context_version = excluded.context_version,
			context_fetched_at_ms = excluded.context_fetched_at_ms,
			compaction_plan = excluded.compaction_plan,
			compaction_plan_tokens = excluded.compaction_plan_tokens,
			updated_at_ms = excluded.updated_at_ms
	`);
	// Read-modify-write in JS lost money: an aborted or failed dispatch is still
	// billed by the upstream, but it returns before the commit path, so the next
	// dispatch loaded a stale total and overwrote it. Measured on live data:
	// 152 aborted dispatches billing $0.9985 — 30% of all spend — never reached
	// `spent_usd`, leaving the per-conversation budget guard blind to it.
	// Accumulating in SQL is correct regardless of who raced whom.
	const accrueOne = db.query(`
		UPDATE conversations
		SET spent_usd = spent_usd + $spentUsd,
			escalations = escalations + $escalations,
			updated_at_ms = $updatedAtMs
		WHERE key = $key
	`);
	const deleteStale: Statement<unknown, [number]> = db.query("DELETE FROM conversations WHERE updated_at_ms < ?");

	return {
		get(key) {
			const row = selectOne.get(key);
			return row === null ? null : toState(row);
		},

		load(key) {
			const existing = selectOne.get(key);
			if (existing !== null) return toState(existing);
			// Session id is derived, not random, so it stays stable if this row is
			// ever pruned and the same conversation continues afterwards.
			const sessionId = `omp-${key}`;
			insertOne.run(key, sessionId, Date.now());
			const inserted = selectOne.get(key);
			if (inserted === null) throw new Error(`conversation row vanished immediately after insert: ${key}`);
			return toState(inserted);
		},

		save(state) {
			// bun:sqlite matches named parameters by their literal `$name` key;
			// bare keys bind nothing at all and every column silently lands NULL.
			// No $spentUsd / $escalations here — see the statement above.
			upsert.run({
				$key: state.key,
				$sessionId: state.sessionId,
				$turn: state.turn,
				$currentSlug: state.currentSlug,
				$currentTier: state.currentTier,
				$stickyUntilTurn: state.stickyUntilTurn,
				$lastPromptTokens: state.lastPromptTokens,
				$compactionPlan: state.compactionPlan === null ? null : JSON.stringify(state.compactionPlan),
				$compactionPlanTokens: state.compactionPlanTokens ?? 0,
				$cacheWarmSlug: state.cacheWarmSlug,
				$cacheWarmAtMs: state.cacheWarmAtMs,
				$contextVersion: state.contextVersion,
				$contextFetchedAtMs: state.contextFetchedAtMs,
				$updatedAtMs: Date.now(),
			});
		},

		accrue(key, delta) {
			const spentUsd = delta.spentUsd ?? 0;
			const escalations = delta.escalations ?? 0;
			// Nothing to add: skip the write rather than bump updated_at_ms and
			// keep a dead conversation alive against `prune`.
			if (spentUsd === 0 && escalations === 0) return;
			accrueOne.run({ $key: key, $spentUsd: spentUsd, $escalations: escalations, $updatedAtMs: Date.now() });
		},

		prune(maxAgeMs) {
			return deleteStale.run(Date.now() - maxAgeMs).changes;
		},
	};
}
