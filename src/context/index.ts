/**
 * Bridge factory. Returns the inert bridge unless agentdox is fully
 * configured, so every call site can stay unconditional.
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

export function createBridgeFromConfig(cfg: RouterConfig, db: Database): ContextBridge {
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
		recordTurns: c.recordTurns,
		maxQueue: c.maxQueue,
	});
}
