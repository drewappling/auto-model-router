/**
 * Shared test doubles for the store-backed interfaces.
 *
 * `AsyncLedger` and `ConversationStore` are deliberately TOTAL — a real backend
 * implements every method, and letting callers guess which half they have is
 * how a routing signal silently goes missing. That makes a hand-written fake
 * verbose, so the defaults live here once: a ledger that has observed nothing,
 * and a conversation store in a Map.
 */

import type { AsyncLedger, LedgerEntry } from "../src/cost/types.ts";
import type { ConversationState, ConversationStore } from "../src/router/types.ts";

/** A ledger that knows nothing, with the parts under test overridden. */
export function fakeLedger(over: Partial<AsyncLedger> = {}): AsyncLedger {
	return {
		record: async () => {},
		conversationSpend: async () => 0,
		spendSince: async () => 0,
		blendedRate: async () => null,
		trust: async () => null,
		allTrust: async () => [],
		latency: async () => null,
		signals: async () => new Map(),
		cacheReliability: async () => new Map(),
		escalationCost: async () => null,
		tokenRatio: async () => null,
		recentEntries: async () => [],
		softFailureSpikes: async () => [],
		providerSpendSince: async () => 0,
		latestForSession: async () => null,
		entriesForSession: async () => [],
		prune: async () => ({ deleted: 0, oldestKeptMs: null }),
		markWasted: async () => {},
		...over,
	};
}

/** A ledger that records into an array, for asserting what a turn wrote. */
export function recordingLedger(over: Partial<AsyncLedger> = {}): { ledger: AsyncLedger; entries: LedgerEntry[] } {
	const entries: LedgerEntry[] = [];
	return {
		entries,
		ledger: fakeLedger({
			record: async (entry) => {
				entries.push(entry);
			},
			...over,
		}),
	};
}

export function freshState(key: string): ConversationState {
	return {
		key,
		sessionId: `omp-${key}`,
		turn: 0,
		currentSlug: null,
		currentTier: null,
		stickyUntilTurn: 0,
		escalations: 0,
		spentUsd: 0,
		lastPromptTokens: 0,
		cacheWarmSlug: null,
		cacheWarmAtMs: 0,
		contextVersion: null,
		contextFetchedAtMs: 0,
		compactionPlan: null,
		compactionPlanTokens: 0,
		upgradeDeferredTier: null,
		updatedAtMs: 0,
	};
}

/**
 * A conversation store in a Map. `accrue` ADDS, mirroring the SQL the real one
 * runs: a read-modify-write here would hide the bug that motivated it (a
 * billed-but-uncommitted dispatch losing its spend).
 */
export function fakeConversations(): { store: ConversationStore; map: Map<string, ConversationState> } {
	const map = new Map<string, ConversationState>();
	return {
		map,
		store: {
			get: async (key) => map.get(key) ?? null,
			load: async (key) => {
				const existing = map.get(key);
				if (existing !== undefined) return existing;
				const fresh = freshState(key);
				map.set(key, fresh);
				return fresh;
			},
			save: async (state) => {
				map.set(state.key, state);
			},
			accrue: async (key, delta) => {
				const row = map.get(key);
				if (row === undefined) return;
				row.spentUsd += delta.spentUsd ?? 0;
				row.escalations += delta.escalations ?? 0;
			},
			prune: async () => 0,
		},
	};
}
