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

export type WireProtocol = "openai-chat" | "pi-native";

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
	/** Virtual model the client selected, e.g. `auto`, `auto-cheap`, `auto-max`. */
	requestedModel: string;
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
