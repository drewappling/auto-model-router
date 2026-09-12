/**
 * Per-conversation routing memory.
 *
 * Persisted rather than in-memory so hysteresis and cache-warmth tracking
 * survive a restart: an omp session outlives this process, and forgetting
 * which model is warm would cold-start a paid prompt cache for no reason.
 *
 * The `conversations` table is created by the store's migration
 * (`util/schema.ts`, or `util/sqlite.ts` for a file that predates it).
 */

import { jsonParam, jsonValue, num, type SqlDb } from "../util/sql.ts";

import type { CompactionEdit } from "../wire/types.ts";
import type { ConversationState, ConversationStore, Tier } from "./types.ts";


/** Row shape as stored; column names are snake_case per the schema. */
interface Row {
	key: string;
	session_id: string;
	turn: unknown;
	current_slug: string | null;
	current_tier: string | null;
	sticky_until_turn: unknown;
	escalations: unknown;
	spent_usd: unknown;
	last_prompt_tokens: unknown;
	cache_warm_slug: string | null;
	cache_warm_at_ms: unknown;
	context_version: string | null;
	context_fetched_at_ms: unknown;
	/** JSON: text on sqlite, already parsed on postgres. */
	compaction_plan: unknown;
	compaction_plan_tokens: unknown;
	upgrade_deferred_tier: string | null;
	updated_at_ms: unknown;
}

function toState(row: Row): ConversationState {
	return {
		key: row.key,
		sessionId: row.session_id,
		// Counts and sums arrive as strings from Postgres, and every one of these
		// feeds arithmetic — the sticky window, the budget guard, cache warmth.
		turn: num(row.turn),
		currentSlug: row.current_slug,
		// Stored as free text; the column is only ever written from a Tier.
		currentTier: row.current_tier as Tier | null,
		stickyUntilTurn: num(row.sticky_until_turn),
		escalations: num(row.escalations),
		spentUsd: num(row.spent_usd),
		lastPromptTokens: num(row.last_prompt_tokens),
		cacheWarmSlug: row.cache_warm_slug,
		cacheWarmAtMs: num(row.cache_warm_at_ms),
		contextVersion: row.context_version,
		contextFetchedAtMs: num(row.context_fetched_at_ms),
		compactionPlan: jsonValue<CompactionEdit[]>(row.compaction_plan),
		compactionPlanTokens: num(row.compaction_plan_tokens),
		upgradeDeferredTier: row.upgrade_deferred_tier as Tier | null,
		updatedAtMs: num(row.updated_at_ms),
	};
}

export function createConversationStore(db: SqlDb): ConversationStore {
	const { sql } = db;
	const selectOne = async (key: string): Promise<Row | null> =>
		await db.one<Row>("SELECT * FROM conversations WHERE key = $key", { key });

	return {
		async get(key) {
			const row = await selectOne(key);
			return row === null ? null : toState(row);
		},

		async load(key) {
			const existing = await selectOne(key);
			if (existing !== null) return toState(existing);
			// Session id is derived, not random, so it stays stable if this row is
			// ever pruned and the same conversation continues afterwards.
			const sessionId = `omp-${key}`;
			// Two replicas can reach this at once for the same conversation; the
			// loser must read the winner's row rather than fail the turn.
			await sql`INSERT INTO conversations (key, session_id, updated_at_ms) VALUES (${key}, ${sessionId}, ${Date.now()})
				ON CONFLICT (key) DO NOTHING`;
			const inserted = await selectOne(key);
			if (inserted === null) throw new Error(`conversation row vanished immediately after insert: ${key}`);
			return toState(inserted);
		},

		async save(state) {
			// `spent_usd` and `escalations` are ABSENT on purpose: they accumulate
			// through `accrue`, so writing a turn-start snapshot back here would
			// erase whatever a billed-but-uncommitted dispatch added. The schema
			// defaults both to 0, so the INSERT arm still works.
			await sql`
				INSERT INTO conversations (
					key, session_id, turn, current_slug, current_tier, sticky_until_turn,
					last_prompt_tokens, cache_warm_slug, cache_warm_at_ms,
					context_version, context_fetched_at_ms, compaction_plan, compaction_plan_tokens,
					upgrade_deferred_tier, updated_at_ms
				) VALUES (
					${state.key}, ${state.sessionId}, ${state.turn}, ${state.currentSlug}, ${state.currentTier},
					${state.stickyUntilTurn}, ${state.lastPromptTokens}, ${state.cacheWarmSlug}, ${state.cacheWarmAtMs},
					${state.contextVersion}, ${state.contextFetchedAtMs}, ${jsonParam(db, state.compactionPlan)},
					${state.compactionPlanTokens ?? 0}, ${state.upgradeDeferredTier ?? null}, ${Date.now()}
				)
				ON CONFLICT (key) DO UPDATE SET
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
					upgrade_deferred_tier = excluded.upgrade_deferred_tier,
					updated_at_ms = excluded.updated_at_ms`;
		},

		async accrue(key, delta) {
			const spentUsd = delta.spentUsd ?? 0;
			const escalations = delta.escalations ?? 0;
			// Nothing to add: skip the write rather than bump updated_at_ms and
			// keep a dead conversation alive against `prune`.
			if (spentUsd === 0 && escalations === 0) return;
			// Read-modify-write in JS lost money: an aborted or failed dispatch is
			// still billed by the upstream, but it returns before the commit path,
			// so the next dispatch loaded a stale total and overwrote it. Measured
			// on live data: 152 aborted dispatches billing $0.9985 — 30% of all
			// spend — never reached `spent_usd`. Accumulating in SQL is correct
			// regardless of who raced whom, and with a shared store the racers can
			// now be different processes.
			await sql`
				UPDATE conversations
				SET spent_usd = spent_usd + ${spentUsd},
					escalations = escalations + ${escalations},
					updated_at_ms = ${Date.now()}
				WHERE key = ${key}`;
		},

		async prune(maxAgeMs) {
			const deleted = (await sql`DELETE FROM conversations WHERE updated_at_ms < ${Date.now() - maxAgeMs} RETURNING key`) as {
				key: string;
			}[];
			return deleted.length;
		},
	};
}
