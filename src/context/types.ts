/**
 * agentdox bridge — one shared project context that survives model switches.
 *
 * The router is the only choke point that sees every model in every harness,
 * so injecting project memory/docs/brief HERE gives every candidate model the
 * same context without per-harness MCP wiring.
 *
 * The load-bearing constraint is the prompt cache. A context block that
 * changes per turn sits at the front of the prefix and turns every turn into a
 * full cache miss — which would cost far more than routing saves. So a block
 * is PINNED per conversation and only re-fetched at moments the prefix is
 * already forfeit (a model switch, an escalation retry) or after a staleness
 * TTL. See `bridge.ts` for the policy.
 */

/** A pinned, prompt-ready context block. */
export interface ContextPin {
	/**
	 * Content hash of `block`. Deliberately NOT agentdox's `assembledAt`: the
	 * server re-assembles on a timer, so a timestamp changes even when nothing
	 * about the content did, and that would break a warm cache for no reason.
	 */
	version: string;
	/** Text appended to the system prefix by the wire. */
	block: string;
	fetchedAtMs: number;
}

export interface ContextResolveInput {
	/** agentdox project slug. Empty ⇒ the bridge is inert for this turn. */
	scope: string;
	conversationKey: string;
	/** Version pinned by the previous turn; null on a fresh conversation. */
	pinnedVersion: string | null;
	/** When that pin was fetched, for the staleness TTL. */
	pinnedFetchedAtMs: number;
	/** This turn dispatches to a different slug than the last committed turn. */
	modelSwitching: boolean;
	/** An escalation or failover retry — the prefix is cold either way. */
	retrying: boolean;
	/** Latest user text, used to bias agentdox relevance ranking. */
	query: string;
}

/** One settled turn, recorded to agentdox with the model that served it. */
export interface TurnRecord {
	scope: string;
	conversationKey: string;
	/** Title used if this is the first turn and a session must be created. */
	title: string;
	userText: string;
	/** Text THIS dispatch produced. Fragments are joined across a tool loop. */
	assistantText: string;
	/** The slug that actually served the turn — the model attribution. */
	slug: string;
	tier: string;
	/**
	 * Whether the assistant yielded control back to the user — i.e. the upstream
	 * finish reason was NOT `tool_calls`.
	 *
	 * A user-visible turn is many dispatches: every tool round-trip is its own
	 * request, and only the last carries the model's synthesis. The intermediate
	 * ones are almost pure tool calls with a few stray words of text, and the
	 * last *user* message does not move while the loop runs. False therefore
	 * means "buffer this fragment, the turn is still running" — recording it as
	 * a turn would write a near-empty answer and re-append the same user text.
	 */
	turnEnded: boolean;
}

export interface ContextBridge {
	/** False when no agentdox URL/token is configured; every call is then a no-op. */
	readonly enabled: boolean;
	/** Resolves the block to inject. Never throws: agentdox being down degrades to null. */
	resolve(input: ContextResolveInput): Promise<ContextPin | null>;
	/** Queues a turn for write-back. Returns immediately; never blocks the turn. */
	recordTurn(rec: TurnRecord): void;
	/** Drains the write queue. For tests and shutdown. */
	flush(): Promise<void>;
	close(): void;
}

/** Content-addressed store of fetched blocks, so a restart keeps a warm prefix. */
export interface ContextBlockStore {
	get(version: string): ContextPin | null;
	put(scope: string, pin: ContextPin): void;
	/** agentdox session id previously opened for a conversation. */
	sessionFor(conversationKey: string): string | null;
	bindSession(conversationKey: string, scope: string, sessionId: string): void;
	prune(maxAgeMs: number): number;
}
