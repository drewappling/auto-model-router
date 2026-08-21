/**
 * OpenRouter transport contracts.
 *
 * The client is deliberately thin: it POSTs a body the wire layer rendered,
 * parses SSE into `UpstreamChunk`s, and classifies failures. It holds no
 * routing policy — that lives in `router/`.
 */

import type { UpstreamChunk, WireError } from "../wire/types.ts";

export type UpstreamErrorKind =
	| "auth"
	| "rate_limit"
	| "context_length"
	| "model_unavailable"
	| "invalid_request"
	| "moderation"
	| "upstream_error"
	| "timeout"
	| "network"
	| "aborted";

export class UpstreamError extends Error {
	constructor(
		readonly kind: UpstreamErrorKind,
		readonly status: number,
		message: string,
		readonly retryable: boolean,
		readonly body?: unknown,
	) {
		super(message);
		this.name = "UpstreamError";
	}

	toWireError(): WireError {
		return { status: this.status, code: this.kind, message: this.message };
	}
}

export interface DispatchOptions {
	body: Record<string, unknown>;
	/** Forwarded as the `x-session-id` header, mirroring body `session_id`. */
	sessionId: string;
	signal: AbortSignal;
}

/**
 * A live upstream generation.
 *
 * `chunks` is single-pass. The escalation guard may abandon it before
 * completion; callers MUST abort the signal in that case so the upstream
 * connection is torn down and no further tokens are billed.
 */
export interface Dispatch {
	chunks: AsyncIterable<UpstreamChunk>;
	/** Resolves once the generation id is known, i.e. on the first chunk. */
	generationId(): Promise<string | null>;
}

export interface UpstreamClient {
	/** Streaming chat completion. Always requests `stream: true` upstream. */
	dispatch(opts: DispatchOptions): Promise<Dispatch>;
	/**
	 * Non-streaming single-shot, used by the classifier adjudicator.
	 * Returns assistant text and the reported cost.
	 */
	complete(body: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; costUsd: number | null }>;
	/** Raw catalog fetch. Returns the parsed `data` array untouched. */
	fetchModels(signal?: AbortSignal): Promise<unknown[]>;
	/**
	 * Key-scoped catalog fetch (`GET /models/user`). Returns the models
	 * available to the configured key under active guardrails and preferences.
	 */
	fetchModelsForUser(signal?: AbortSignal): Promise<unknown[]>;
}
