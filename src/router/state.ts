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
		updatedAtMs: row.updated_at_ms,
	};
}

export function createConversationStore(db: Database): ConversationStore {
	// Hoisted: this runs on every turn, twice when an escalation retries.
	const selectOne: Statement<Row, [string]> = db.query("SELECT * FROM conversations WHERE key = ?");
	const insertOne: Statement<unknown, [string, string, number]> = db.query(
		"INSERT INTO conversations (key, session_id, updated_at_ms) VALUES (?, ?, ?)",
	);
	const upsert = db.query(`
		INSERT INTO conversations (
			key, session_id, turn, current_slug, current_tier, sticky_until_turn,
			escalations, spent_usd, last_prompt_tokens, cache_warm_slug, cache_warm_at_ms,
			context_version, context_fetched_at_ms, updated_at_ms
		) VALUES ($key, $sessionId, $turn, $currentSlug, $currentTier, $stickyUntilTurn,
			$escalations, $spentUsd, $lastPromptTokens, $cacheWarmSlug, $cacheWarmAtMs,
			$contextVersion, $contextFetchedAtMs, $updatedAtMs)
		ON CONFLICT(key) DO UPDATE SET
			session_id = excluded.session_id,
			turn = excluded.turn,
			current_slug = excluded.current_slug,
			current_tier = excluded.current_tier,
			sticky_until_turn = excluded.sticky_until_turn,
			escalations = excluded.escalations,
			spent_usd = excluded.spent_usd,
			last_prompt_tokens = excluded.last_prompt_tokens,
			cache_warm_slug = excluded.cache_warm_slug,
			cache_warm_at_ms = excluded.cache_warm_at_ms,
			context_version = excluded.context_version,
			context_fetched_at_ms = excluded.context_fetched_at_ms,
			updated_at_ms = excluded.updated_at_ms
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
			upsert.run({
				$key: state.key,
				$sessionId: state.sessionId,
				$turn: state.turn,
				$currentSlug: state.currentSlug,
				$currentTier: state.currentTier,
				$stickyUntilTurn: state.stickyUntilTurn,
				$escalations: state.escalations,
				$spentUsd: state.spentUsd,
				$lastPromptTokens: state.lastPromptTokens,
				$cacheWarmSlug: state.cacheWarmSlug,
				$cacheWarmAtMs: state.cacheWarmAtMs,
				$contextVersion: state.contextVersion,
				$contextFetchedAtMs: state.contextFetchedAtMs,
				$updatedAtMs: Date.now(),
			});
		},

		prune(maxAgeMs) {
			return deleteStale.run(Date.now() - maxAgeMs).changes;
		},
	};
}
