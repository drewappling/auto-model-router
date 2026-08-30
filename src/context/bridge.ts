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
	/**
	 * Bounds on what agentdox SELECTS. Preferred over `maxBlockChars`, which can
	 * only slice bytes: the server ranks by relevance, so a limit drops the least
	 * useful entry instead of severing whatever straddles the cap.
	 */
	memoryLimit: number;
	docsLimit: number;
	sessionLimit: number;
	/** Character budget for the project brief rendered first in the block; 0 omits it. */
	briefChars: number;
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

/**
 * Cap on assistant text buffered for one in-flight turn, chars. A memory guard
 * only, not a quality knob: a 200-round-trip loop must not buffer without
 * limit. The dispatch that ENDS the turn is appended past this cap, so the
 * model's actual answer is never the thing that gets dropped.
 */
const MAX_PENDING_CHARS = 64_000;

/**
 * Cap on conversations buffering fragments at once. A turn that dies without a
 * terminal dispatch (client disconnect, upstream error) leaves its buffer
 * behind, so this map is bounded rather than trusted to drain.
 */
const MAX_PENDING_CONVERSATIONS = 64;

/** Appends a mid-loop fragment, bounded. Blank-line joined: separate thoughts. */
function appendFragment(prior: string, next: string): string {
	if (next === "") return prior;
	if (prior === "") return next.slice(0, MAX_PENDING_CHARS);
	if (prior.length >= MAX_PENDING_CHARS) return prior;
	return `${prior}\n\n${next}`.slice(0, MAX_PENDING_CHARS);
}

export function createContextBridge(opts: BridgeOptions): ContextBridge {
	const { client, store, log, maxStalenessMs, maxBlockChars, memoryLimit, docsLimit, sessionLimit, briefChars, recordTurns, maxQueue } = opts;

	// Serialized write-back queue. Session appends for one conversation must
	// stay ordered, and agentdox is a local service — one worker is plenty.
	let queue: Promise<void> = Promise.resolve();
	let queued = 0;
	let closed = false;
	// Assistant text buffered across an in-flight tool loop, keyed by
	// conversation. Process-local by design: a turn never spans a restart, and
	// losing a buffer whose turn already died costs nothing.
	const pending = new Map<string, string>();

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

			const raw = await client.assemble(input.scope, input.query, { memoryLimit, docsLimit, sessionLimit, briefChars });
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

			// Mid-loop dispatch: keep the fragment and wait for the turn to end.
			// Writing here is what produced ~13 near-empty assistant messages per
			// turn plus ~13 copies of an unchanged user message, which both lost
			// the real answer and poisoned later context assembly.
			if (!rec.turnEnded) {
				if (rec.assistantText === "") return;
				const prior = pending.get(rec.conversationKey);
				if (prior === undefined && pending.size >= MAX_PENDING_CONVERSATIONS) {
					log.debug("agentdox pending transcript budget full; dropping fragment", { conversations: pending.size });
					return;
				}
				pending.set(rec.conversationKey, appendFragment(prior ?? "", rec.assistantText));
				return;
			}

			// Turn over. Flush the whole loop's narration plus this dispatch's
			// synthesis as ONE assistant message, attributed to the served model.
			const buffered = pending.get(rec.conversationKey) ?? "";
			pending.delete(rec.conversationKey);
			const assistantText =
				buffered === ""
					? rec.assistantText
					: rec.assistantText === ""
						? buffered
						: `${buffered}\n\n${rec.assistantText}`;

			if (rec.userText === "" && assistantText === "") return;
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
					if (assistantText !== "") await client.append(sessionId, "assistant", assistantText, refs);
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

		pruneBlocks(maxAgeMs: number) {
			return store.prune(maxAgeMs);
		},

		close() {
			closed = true;
			pending.clear();
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
		pruneBlocks: () => 0,
		close: () => {},
	};
}
