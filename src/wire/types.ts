/**
 * Protocol-agnostic boundary between a client-facing wire (OpenAI chat
 * completions today, pi-native later) and the routing core.
 *
 * The core never parses a wire format. A front end produces a `NormRequest`
 * and consumes `UpstreamChunk`s through a `ResponseSink`. Anything the core
 * does not understand rides along in `renderUpstreamBody()` output and in
 * `UpstreamChunk.raw`, so unknown fields survive the round trip untouched.
 */

import type { UsageCounts } from "../cost/types.ts";

export type WireProtocol = "openai-chat" | "openai-responses" | "anthropic-messages" | "pi-native";

/**
 * A routing policy attached to one request. `allow`/`deny` are slug globs
 * like `filters.allow`/`filters.deny` (a request allow list replaces the
 * configured one; a deny list adds to it); `minTier`/`maxTier` narrow the
 * profile's tier envelope; `pin` forces one slug, like `/router pin`.
 */
export interface RequestPolicy {
	allow?: string[];
	deny?: string[];
	minTier?: "trivial" | "simple" | "moderate" | "hard";
	maxTier?: "trivial" | "simple" | "moderate" | "hard";
	pin?: string;
}

export type Role = "system" | "developer" | "user" | "assistant" | "tool";

/** One tool call requested by an assistant turn. */
export interface NormToolCall {
	id: string;
	name: string;
	/** Raw JSON argument text as the model emitted it (may be invalid JSON). */
	argsJson: string;
}

/**
 * A conversation message flattened for feature extraction.
 *
 * `text` is a lossy concatenation used only for classification. Nothing is
 * ever dispatched from it — the wire's own `renderUpstreamBody()` owns the
 * bytes that reach OpenRouter.
 */
export interface NormMessage {
	role: Role;
	text: string;
	/** Number of image parts on this message. */
	images: number;
	/** Bytes of text content, cheaper than recounting. */
	textBytes: number;
	toolCalls: NormToolCall[];
	/** Set when `role === "tool"`; links back to the assistant call. */
	toolCallId?: string;
	/** Name of the tool, for `role === "tool"` messages that carry it. */
	toolName?: string;
}

/** A tool exposed to the model, sized for prompt-cost accounting. */
export interface NormTool {
	name: string;
	description: string;
	/** Serialized byte length of the JSON schema. Tool schemas dominate omp prompts. */
	schemaBytes: number;
}

export type ReasoningLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface NormRequest {
	protocol: WireProtocol;
	/**
	 * Stable conversation identity: sha256 over the system prompt plus the
	 * first non-system message. Matches how OpenRouter fingerprints
	 * conversations, so our `session_id` and their implicit key agree.
	 */
	conversationKey: string;
	/**
	 * Harness/session identifier from the `X-Omp-Harness` request header, when
	 * the client sends one. Lets multiple coding harnesses share one router
	 * while keeping per-harness daily budgets and toast scoping. Empty when the
	 * client sends no header (single-harness default).
	 */
	harnessId: string;
	/**
	 * omp UI session id from the `X-Omp-Session` request header, when the client
	 * sends one. Scopes toasts to a single interactive session so concurrent
	 * sessions sharing one router don't surface each other's choices. Empty when
	 * the client sends no header.
	 */
	ompSessionId: string;
	/**
	 * agentdox project scope from the `X-Agentdox-Scope` request header. Selects
	 * which project's shared context is injected and which project's sessions
	 * the turn is recorded into. Empty ⇒ fall back to `context.defaultScope`,
	 * and if that is empty too the bridge stays inert for this request.
	 */
	agentdoxScope: string;
	/**
	 * agentdox group-context scope from the `X-Agentdox-Group` request header,
	 * set by a front door such as the team edition: the scope whose brief and
	 * top memory render FIRST in the block. Empty when absent or not a slug,
	 * which sends nothing, so a lone router's block is unchanged.
	 */
	agentdoxGroup: string;
	/**
	 * agentdox personal scope from the `X-Agentdox-Personal` request header:
	 * one member's own thread in the project (their handoff note first), which
	 * renders LAST. Empty when absent or not a slug ⇒ no personal layer.
	 */
	agentdoxPersonal: string;
	/**
	 * The workspace's repository fingerprint from the `X-Agentdox-Origin`
	 * request header (`<host>/<path>` of its git remote `origin`, see
	 * `src/context/scope.ts`). Validated here, in one place, for a front door
	 * with a project registry — the team edition — which uses it to find the
	 * project two same-named folders are really about. The router's own bridge
	 * has no registry and never reads it. Empty when absent or not a fingerprint.
	 */
	agentdoxOrigin: string;
	/** `X-Omp-Subagent: 1`: the caller is an omp subagent (a session without a UI). */
	isSubagent: boolean;
	/**
	 * Per-request routing policy from the `X-Omp-Policy` header (JSON), set by
	 * a front door such as the team edition: narrows what this turn may route
	 * to. Absent ⇒ the configured profile and filters alone.
	 */
	policy?: RequestPolicy;
	/** Virtual model the client selected, e.g. `auto`, `auto-cheap`, `auto-max`. */
	requestedModel: string;
	/**
	 * The client's `model` string before the provider prefix was stripped, so a
	 * vendor-qualified catalog slug (`deepseek/deepseek-v4.1-flash`) stays
	 * distinguishable from a profile id. Absent ⇒ `requestedModel` is the whole
	 * of what the client asked for.
	 */
	requestedModelFull?: string;
	messages: NormMessage[];
	tools: NormTool[];
	/** True when the client forced a specific tool. */
	forcedToolChoice: boolean;
	stream: boolean;
	maxTokens?: number;
	temperature?: number;
	reasoning?: ReasoningLevel;
	hasImages: boolean;
	/** Total prompt bytes across messages, system prompt, and tool schemas. */
	promptBytes: number;
	/**
	 * Renders the body to POST to OpenRouter for a chosen model. The core passes
	 * mutations it computed; the wire owns serialization so unknown client
	 * fields pass through verbatim.
	 */
	renderUpstreamBody(m: UpstreamMutations): Record<string, unknown>;
}

/** Core-computed changes the wire must apply when rendering the upstream body. */
export interface UpstreamMutations {
	/** Concrete slug to dispatch to. Replaces the virtual model. */
	slug: string;
	/** Same-tier fallbacks for OpenRouter's `models[]` array. */
	fallbacks: string[];
	/** Forwarded as `session_id` to pin provider stickiness and group logs. */
	sessionId: string;
	/** Cache breakpoints to inject, as message indices. Empty ⇒ inject none. */
	cacheBreakpointMessageIndices: number[];
	/** Effective reasoning level, after clamping to what the target supports. */
	reasoning: ReasoningLevel | undefined;
	/** Clamp for the target's published completion ceiling. */
	maxTokens: number | undefined;
	/** Drop assistant reasoning-replay fields the target rejects. */
	stripAssistantReasoning: boolean;
	/**
	 * agentdox project context to fold into the system prefix. Appended to the
	 * LAST system message rather than inserted as a new one: inserting would
	 * shift every `cacheBreakpointMessageIndices` entry, and appending puts the
	 * block inside the prefix that `planCacheBreakpoints` already marks.
	 * Undefined ⇒ inject nothing.
	 */
	contextBlock?: string;
	/**
	 * Deterministic compaction edits to apply to the message array before the
	 * other mutations. Each edit shrinks ONE tool-result's content in place;
	 * message count and order are preserved so cache-breakpoint indices and the
	 * context-block append stay valid. Empty ⇒ compact nothing.
	 */
	compactionPlan?: CompactionEdit[];
}

/**
 * One in-place shrink of a tool-result message's content. `stub` replaces the
 * whole content with a breadcrumb; `truncate` keeps `keepHead`/`keepTail`
 * characters around an elision breadcrumb. `note` describes why, for the
 * breadcrumb the model reads.
 */
export interface CompactionEdit {
	index: number;
	mode: "truncate" | "stub";
	keepHead: number;
	keepTail: number;
	note: string;
	/**
	 * Original (pre-edit) byte length of the targeted message's string content,
	 * captured when the edit was planned. Persisted with the plan so a later
	 * turn can verify the history it is re-applying to is byte-identical before
	 * re-applying — a client-side rewrite or an upstream difference invalidates
	 * the edit instead of corrupting the prompt.
	 */
	bytes: number;
	/**
	 * A cheap-model digest of the original content (marker line first), set
	 * by summarising compaction. When present it replaces the content outright
	 * instead of the head/tail or stub breadcrumb, and persists with the plan
	 * so the dispatched bytes stay identical turn to turn.
	 */
	digest?: string;
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "error";

/** Interpreted view of one upstream SSE chunk. */
export type StreamEvent =
	| { type: "start"; servedSlug: string; generationId: string | null }
	| { type: "text"; delta: string }
	| { type: "reasoning"; delta: string }
	| { type: "tool_call"; index: number; id?: string; name?: string; argsDelta?: string }
	| { type: "finish"; reason: FinishReason }
	| { type: "usage"; usage: UsageCounts; reportedCostUsd: number | null };

/**
 * One upstream chunk, carried as both raw bytes and interpreted events.
 *
 * The escalation guard reads `events`; the wire forwards `raw` (with `model`
 * rewritten). Keeping both means interpretation gaps never drop client-visible
 * fields.
 */
export interface UpstreamChunk {
	raw: Record<string, unknown>;
	events: StreamEvent[];
}

export interface WireError {
	status: number;
	code: string;
	message: string;
}

/** Outcome of a fully-resolved turn, after any escalation retries. */
export interface TurnSummary {
	servedSlug: string;
	tier: string;
	attempts: number;
	predictedUsd: number;
	reportedUsd: number | null;
	usage: UsageCounts;
	reasons: string[];
	escalated: boolean;
}

/** Client-facing sink. A front end renders these to its own wire format. */
export interface ResponseSink {
	chunk(chunk: UpstreamChunk): void | Promise<void>;
	error(error: WireError): void | Promise<void>;
	finish(summary: TurnSummary): void | Promise<void>;
}
