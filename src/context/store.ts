/**
 * Persistence for the agentdox bridge.
 *
 * Blocks are content-addressed by version and shared across conversations, so
 * ten conversations on one project store one copy. Persisting them (rather
 * than caching in memory) means a router restart can re-inject the SAME bytes
 * a conversation was already using — OpenRouter's prompt cache outlives our
 * process, and re-fetching would needlessly change the prefix.
 *
 * Tables are created by `util/sqlite.ts`, the single migration path.
 */

import type { Database, Statement } from "bun:sqlite";

import type { ContextBlockStore, ContextPin } from "./types.ts";

interface BlockRow {
	version: string;
	block: string;
	fetched_at_ms: number;
}

interface SessionRow {
	session_id: string;
}

export function createContextStore(db: Database): ContextBlockStore {
	// Hoisted: these run on the turn hot path.
	const selectBlock: Statement<BlockRow, [string]> = db.query(
		"SELECT version, block, fetched_at_ms FROM context_blocks WHERE version = ?",
	);
	const insertBlock = db.query(`
		INSERT INTO context_blocks (version, scope, block, fetched_at_ms)
		VALUES ($version, $scope, $block, $fetchedAtMs)
		ON CONFLICT(version) DO UPDATE SET fetched_at_ms = excluded.fetched_at_ms
	`);
	const selectSession: Statement<SessionRow, [string]> = db.query(
		"SELECT session_id FROM agentdox_sessions WHERE conversation_key = ?",
	);
	const insertSession = db.query(`
		INSERT INTO agentdox_sessions (conversation_key, scope, session_id, created_at_ms)
		VALUES ($key, $scope, $sessionId, $createdAtMs)
		ON CONFLICT(conversation_key) DO UPDATE SET session_id = excluded.session_id
	`);
	// Age alone is the wrong test: a block older than the staleness TTL may still
	// be PINNED by a live conversation, and deleting it forces that conversation
	// to refetch and re-inject different bytes — a prompt-cache miss caused by
	// housekeeping. Blocks are content-addressed and shared, so the safe set is
	// "old AND referenced by no conversation".
	const deleteStale: Statement<unknown, [number]> = db.query(`
		DELETE FROM context_blocks
		WHERE fetched_at_ms < ?
		  AND version NOT IN (SELECT context_version FROM conversations WHERE context_version IS NOT NULL)
	`);

	return {
		get(version) {
			const row = selectBlock.get(version);
			if (row === null) return null;
			return { version: row.version, block: row.block, fetchedAtMs: row.fetched_at_ms };
		},

		put(scope, pin: ContextPin) {
			insertBlock.run({
				$version: pin.version,
				$scope: scope,
				$block: pin.block,
				$fetchedAtMs: pin.fetchedAtMs,
			});
		},

		sessionFor(conversationKey) {
			const row = selectSession.get(conversationKey);
			return row === null ? null : row.session_id;
		},

		bindSession(conversationKey, scope, sessionId) {
			insertSession.run({
				$key: conversationKey,
				$scope: scope,
				$sessionId: sessionId,
				$createdAtMs: Date.now(),
			});
		},

		prune(maxAgeMs) {
			const res = deleteStale.run(Date.now() - maxAgeMs) as unknown as { changes?: number };
			return res.changes ?? 0;
		},
	};
}
