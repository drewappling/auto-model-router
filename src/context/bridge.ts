/**
 * The refresh policy, which is the whole design.
 *
 * Injecting fresh context every turn would defeat the router's single largest
 * cost lever: the prompt cache. The block sits at the front of the prefix, so
 * changing it invalidates everything after it. The rule is therefore to
 * re-fetch ONLY when the prefix is already being paid for:
 *
 *   - no pin yet          first turn; nothing is warm
 *   - model switching     the router already decided to forfeit the cache
 *   - retrying            an escalation/failover dispatch is cold by definition
 *   - staleness TTL       a bounded upper limit on how old context may get
 *
 * Between those moments the same bytes are re-injected verbatim and the cache
 * survives. This is what makes "context refreshes as I switch models" cheap
 * rather than ruinous: the refresh rides on a cache miss that was happening
 * anyway.
 */

import { sha256Hex } from "../util/hash.ts";
import type { Logger } from "../util/log.ts";
import type { AgentDoxClient } from "./agentdox.ts";
import type { ContextBlockStore, ContextBridge, ContextPin, ContextResolveInput, TurnRecord } from "./types.ts";

export interface BridgeOptions {
	client: AgentDoxClient;
	store: ContextBlockStore;
	log: Logger;
	/** Upper bound on pinned-context age, ms. 0 ⇒ refresh only on cache-cold turns. */
	maxStalenessMs: number;
	/** Hard cap on injected block size; a runaway context must not dominate the prompt. */
	maxBlockChars: number;
	/** Record settled turns back into agentdox sessions. */
	recordTurns: boolean;
	/** Bound on queued write-backs; excess is dropped rather than grown unbounded. */
	maxQueue: number;
}

/** Wraps the raw agentdox slice in a delimiter the model can reason about. */
function renderBlock(raw: string, maxChars: number): string {
	const body = raw.length > maxChars ? `${raw.slice(0, maxChars)}\n[...truncated]` : raw;
	return [
		"<project-context source=\"agentdox\">",
		"Durable project memory, documentation, and history shared across every model that",
		"serves this conversation. Treat it as established fact; prefer it over re-deriving.",
		"",
		body,
		"</project-context>",
	].join("\n");
}

export function createContextBridge(opts: BridgeOptions): ContextBridge {
	const { client, store, log, maxStalenessMs, maxBlockChars, recordTurns, maxQueue } = opts;

	// Serialized write-back queue. Session appends for one conversation must
	// stay ordered, and agentdox is a local service — one worker is plenty.
	let queue: Promise<void> = Promise.resolve();
	let queued = 0;
	let closed = false;

	const shouldRefresh = (input: ContextResolveInput, pin: ContextPin | null): boolean => {
		if (pin === null) return true;
		if (input.modelSwitching || input.retrying) return true;
		// Staleness is measured from when THIS conversation last refreshed, not
		// from the shared block row: another conversation confirming the same
		// content must not silently extend our TTL. The re-check is cheap
		// anyway — identical content hashes to the same version, so a
		// confirming refresh re-sends identical bytes and the cache survives.
		if (maxStalenessMs > 0 && Date.now() - input.pinnedFetchedAtMs > maxStalenessMs) return true;
		return false;
	};

	return {
		enabled: true,

		async resolve(input) {
			if (input.scope === "") return null;

			const pinned = input.pinnedVersion === null ? null : store.get(input.pinnedVersion);
			if (!shouldRefresh(input, pinned) && pinned !== null) {
				// Carry the conversation's own pin time forward, so the TTL keeps
				// counting from its last real refresh rather than resetting to
				// whenever some other conversation last touched this block.
				return { ...pinned, fetchedAtMs: input.pinnedFetchedAtMs };
			}

			const raw = await client.assemble(input.scope, input.query);
			if (raw === null) {
				// agentdox unreachable or empty. Keep serving the pinned block if we
				// have one: stale shared context beats none, and re-using it also
				// keeps the prefix stable.
				return pinned;
			}

			const block = renderBlock(raw, maxBlockChars);
			// Content hash, not a timestamp: agentdox re-assembles on a timer, and
			// an unchanged assembly MUST keep its version so the cache survives.
			const version = sha256Hex(block).slice(0, 32);
			const pin: ContextPin = { version, block, fetchedAtMs: Date.now() };
			try {
				store.put(input.scope, pin);
			} catch (err) {
				log.debug("context block persist failed", { error: err instanceof Error ? err.message : String(err) });
			}
			if (pinned !== null && pinned.version !== version) {
				log.debug("context refreshed", {
					scope: input.scope,
					from: pinned.version.slice(0, 8),
					to: version.slice(0, 8),
					reason: input.retrying ? "retry" : input.modelSwitching ? "model-switch" : "stale",
				});
			}
			return pin;
		},

		recordTurn(rec: TurnRecord) {
			if (!recordTurns || closed || rec.scope === "") return;
			if (rec.userText === "" && rec.assistantText === "") return;
			if (queued >= maxQueue) {
				log.debug("agentdox write-back queue full; dropping turn record", { queued });
				return;
			}
			queued++;
			queue = queue
				.then(async () => {
					let sessionId = store.sessionFor(rec.conversationKey);
					if (sessionId === null) {
						sessionId = await client.createSession(rec.scope, rec.title);
						if (sessionId === null) return;
						store.bindSession(rec.conversationKey, rec.scope, sessionId);
					}
					// Model attribution rides on refs, which agentdox already carries
					// per message. This is what makes the transcript newly useful:
					// every turn shows WHICH model produced it.
					const refs = [`model:${rec.slug}`, `tier:${rec.tier}`];
					if (rec.userText !== "") await client.append(sessionId, "user", rec.userText, []);
					if (rec.assistantText !== "") await client.append(sessionId, "assistant", rec.assistantText, refs);
				})
				.catch((err: unknown) => {
					log.debug("agentdox write-back failed", { error: err instanceof Error ? err.message : String(err) });
				})
				.finally(() => {
					queued--;
				});
		},

		async flush() {
			await queue;
		},

		close() {
			closed = true;
		},
	};
}

/** The inert bridge used when agentdox is not configured. Every call is free. */
export function createDisabledBridge(): ContextBridge {
	return {
		enabled: false,
		resolve: async () => null,
		recordTurn: () => {},
		flush: async () => {},
		close: () => {},
	};
}
