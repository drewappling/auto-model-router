/**
 * Persistence for the agentdox bridge.
 *
 * Blocks are content-addressed by version and shared across conversations, so
 * ten conversations on one project store one copy. Persisting them (rather
 * than caching in memory) means a router restart can re-inject the SAME bytes
 * a conversation was already using — OpenRouter's prompt cache outlives our
 * process, and re-fetching would needlessly change the prefix.
 *
 * Tables are created by the store's migration (`util/schema.ts`).
 */

import { num, type SqlDb } from "../util/sql.ts";

import type { ContextBlockStore, ContextPin } from "./types.ts";

interface BlockRow {
	version: string;
	block: string;
	fetched_at_ms: unknown;
}


export function createContextStore(db: SqlDb): ContextBlockStore {
	const { sql } = db;

	return {
		async get(version) {
			const row = await db.one<BlockRow>(
				"SELECT version, block, fetched_at_ms FROM context_blocks WHERE version = $version",
				{ version },
			);
			if (row === null) return null;
			return { version: row.version, block: row.block, fetchedAtMs: num(row.fetched_at_ms) };
		},

		async put(scope, pin: ContextPin) {
			await sql`
				INSERT INTO context_blocks (version, scope, block, fetched_at_ms)
				VALUES (${pin.version}, ${scope}, ${pin.block}, ${pin.fetchedAtMs})
				ON CONFLICT (version) DO UPDATE SET fetched_at_ms = excluded.fetched_at_ms`;
		},

		async sessionFor(conversationKey) {
			const row = await db.one<{ session_id: string }>(
				"SELECT session_id FROM agentdox_sessions WHERE conversation_key = $key",
				{ key: conversationKey },
			);
			return row === null ? null : row.session_id;
		},

		async bindSession(conversationKey, scope, sessionId) {
			await sql`
				INSERT INTO agentdox_sessions (conversation_key, scope, session_id, created_at_ms)
				VALUES (${conversationKey}, ${scope}, ${sessionId}, ${Date.now()})
				ON CONFLICT (conversation_key) DO UPDATE SET session_id = excluded.session_id`;
		},

		async prune(maxAgeMs) {
			// Age alone is the wrong test: a block older than the staleness TTL may
			// still be PINNED by a live conversation, and deleting it forces that
			// conversation to refetch and re-inject different bytes — a prompt-cache
			// miss caused by housekeeping. Blocks are content-addressed and shared,
			// so the safe set is "old AND referenced by no conversation". With a
			// shared store that now means no conversation on ANY replica.
			const deleted = (await sql`
				DELETE FROM context_blocks
				WHERE fetched_at_ms < ${Date.now() - maxAgeMs}
				  AND version NOT IN (SELECT context_version FROM conversations WHERE context_version IS NOT NULL)
				RETURNING version`) as { version: string }[];
			return deleted.length;
		},
	};
}
