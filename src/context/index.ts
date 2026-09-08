/**
 * Bridge factory. Returns the inert bridge unless agentdox is fully
 * configured, so every call site can stay unconditional — and stays
 * reconfigurable, so those settings can change while the router runs.
 */

import type { Database } from "bun:sqlite";

import type { RouterConfig } from "../config/types.ts";
import { createLogger } from "../util/log.ts";
import { createAgentDoxClient } from "./agentdox.ts";
import { createContextBridge, createDisabledBridge } from "./bridge.ts";
import { createContextStore } from "./store.ts";
import type { ContextBridge } from "./types.ts";

export type { ContextBridge, ContextPin, ContextResolveInput, TurnRecord } from "./types.ts";
export { createContextBridge, createDisabledBridge } from "./bridge.ts";
export { createContextStore } from "./store.ts";
export { createAgentDoxClient } from "./agentdox.ts";

/** A bridge that can be pointed at different agentdox settings while the router runs. */
export interface ReloadableContextBridge extends ContextBridge {
	/**
	 * Applies the config's current `context` block: the URL, token, limits or the
	 * enabled flag may all have changed. Queued write-backs are drained first, so
	 * nothing recorded against the old settings is lost.
	 */
	reconfigure(): Promise<void>;
}

/**
 * The bridge the server runs with. It follows `cfg.context` for the life of the
 * process: `reconfigure()` rebuilds the inner bridge from whatever the config
 * now says, including off→on and on→off, so agentdox settings never need a
 * restart. The block store is the database, not the bridge, so a rebuild keeps
 * every pinned block and session binding.
 */
export function createBridgeFromConfig(cfg: RouterConfig, db: Database): ReloadableContextBridge {
	let inner = buildBridge(cfg, db);
	return {
		get enabled() {
			return inner.enabled;
		},
		resolve: (input) => inner.resolve(input),
		recordTurn: (rec) => {
			inner.recordTurn(rec);
		},
		flush: () => inner.flush(),
		pruneBlocks: (maxAgeMs) => inner.pruneBlocks(maxAgeMs),
		close: () => {
			inner.close();
		},
		async reconfigure() {
			await inner.flush();
			inner.close();
			inner = buildBridge(cfg, db);
		},
	};
}

function buildBridge(cfg: RouterConfig, db: Database): ContextBridge {
	const c = cfg.context;
	if (!c.enabled || c.baseUrl === "" || c.token === "") return createDisabledBridge();
	const log = createLogger(cfg.logLevel);
	return createContextBridge({
		client: createAgentDoxClient({ baseUrl: c.baseUrl, token: c.token, timeoutMs: c.timeoutMs, log }),
		store: createContextStore(db),
		log,
		maxStalenessMs: c.maxStalenessMs,
		maxBlockChars: c.maxBlockChars,
		memoryLimit: c.memoryLimit,
		docsLimit: c.docsLimit,
		sessionLimit: c.sessionLimit,
		briefChars: c.briefChars,
		recordTurns: c.recordTurns,
		maxQueue: c.maxQueue,
	});
}
