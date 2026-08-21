/**
 * OpenRouter transport.
 *
 * Deliberately thin: POSTs the body the wire rendered, decodes SSE via
 * `sse-parse.ts`, and classifies failures into `UpstreamErrorKind`s the turn
 * orchestrator can act on. No routing policy lives here.
 */

import type { RouterConfig } from "../config/types.ts";
import { createLogger } from "../util/log.ts";
import type { UpstreamChunk } from "../wire/types.ts";
import { parseSse } from "./sse-parse.ts";
import {
	UpstreamError,
	type Dispatch,
	type DispatchOptions,
	type UpstreamClient,
	type UpstreamErrorKind,
} from "./types.ts";

// OpenRouter reports context overflow as a 400 with a human message; the
// message is the only signal, so match the phrasings providers actually send.
const CONTEXT_LENGTH_RE =
	/context[ _-]?length|context[ _-]?window|maximum context|too many tokens|reduce (?:the |your )?(?:length|prompt)|prompt is too long|token limit/i;

function asRec(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function classifyStatus(status: number, body: unknown): UpstreamError {
	const rec = asRec(body);
	const errRec = rec ? asRec(rec.error) : null;
	const msg = errRec?.message ?? rec?.message;
	const message = typeof msg === "string" && msg !== "" ? msg : `OpenRouter HTTP ${status}`;
	const fail = (kind: UpstreamErrorKind, retryable: boolean): UpstreamError =>
		new UpstreamError(kind, status, message, retryable, body);
	if (status === 401 || status === 403) return fail("auth", false);
	// 402 = out of credits; retrying changes nothing, only topping up does.
	if (status === 402) return fail("auth", false);
	if (status === 429) return fail("rate_limit", true);
	if (status === 400) {
		return CONTEXT_LENGTH_RE.test(message) ? fail("context_length", false) : fail("invalid_request", false);
	}
	// Provider routing may recover a missing model on the next attempt.
	if (status === 404) return fail("model_unavailable", true);
	if (status >= 500) return fail("upstream_error", true);
	return fail("upstream_error", status === 408);
}

async function httpError(res: Response): Promise<UpstreamError> {
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		// Non-JSON error body — the status alone drives classification.
	}
	return classifyStatus(res.status, body);
}

// Mid-stream failure arrives as an SSE payload: {"error": {message, code}}.
function streamError(raw: unknown): UpstreamError {
	const rec = asRec(raw) ?? {};
	const message = typeof rec.message === "string" && rec.message !== "" ? rec.message : "OpenRouter stream error";
	const code = rec.code;
	const status = typeof code === "number" && Number.isFinite(code) ? code : 0;
	if (status === 0) return new UpstreamError("upstream_error", 0, message, true, raw);
	return classifyStatus(status, raw);
}

// Transport-level rejection: timeout, caller abort, or a socket failure.
function transportError(err: unknown): UpstreamError {
	if (err instanceof UpstreamError) return err;
	const name = err instanceof Error ? err.name : "";
	if (name === "TimeoutError") return new UpstreamError("timeout", 0, "OpenRouter request timed out", true);
	if (name === "AbortError") return new UpstreamError("aborted", 0, "request aborted", false);
	return new UpstreamError("network", 0, err instanceof Error ? err.message : String(err), true);
}

export function createOpenRouterClient(cfg: RouterConfig): UpstreamClient {
	const baseUrl = cfg.openrouter.baseUrl.replace(/\/+$/, "");
	const log = createLogger(cfg.logLevel);

	// Compose the per-request timeout with the caller's cancellation.
	function composeSignal(caller: AbortSignal | undefined): AbortSignal | null {
		const timeout = cfg.openrouter.timeoutMs > 0 ? AbortSignal.timeout(cfg.openrouter.timeoutMs) : null;
		if (caller && timeout) return AbortSignal.any([caller, timeout]);
		return caller ?? timeout;
	}

	function headers(extra: Record<string, string>): Record<string, string> {
		const h: Record<string, string> = {
			"content-type": "application/json",
			"x-title": cfg.openrouter.title,
			...extra,
		};
		// /models is public; an empty key must not produce a broken Bearer header.
		if (cfg.openrouter.apiKey !== "") h.authorization = `Bearer ${cfg.openrouter.apiKey}`;
		if (cfg.openrouter.referer) h["http-referer"] = cfg.openrouter.referer;
		return h;
	}

	return {
		async dispatch(opts: DispatchOptions): Promise<Dispatch> {
			const signal = composeSignal(opts.signal);
			// session_id pins provider stickiness so prompt caches stay warm across
			// turns. No `usage` flag: OpenRouter now returns full cost and cache
			// accounting on every response, and the old opt-in is a no-op.
			// The wire's rendered body wins on conflicts, except the two invariants
			// this client owns: streaming and session id.
			const body = { ...opts.body, stream: true, session_id: opts.sessionId };
			let res: Response;
			try {
				res = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: headers({ "x-session-id": opts.sessionId }),
					body: JSON.stringify(body),
					signal,
				});
			} catch (err) {
				throw transportError(err);
			}
			if (!res.ok) throw await httpError(res);
			if (!res.body) throw new UpstreamError("upstream_error", res.status, "response had no body", true);

			const parsed = parseSse(res.body, (msg, fields) => log.warn(msg, fields));
			let resolveId!: (id: string | null) => void;
			const idPromise = new Promise<string | null>((resolve) => {
				resolveId = resolve;
			});
			let idResolved = false;
			const resolveOnce = (id: string | null): void => {
				if (!idResolved) {
					idResolved = true;
					resolveId(id);
				}
			};

			const chunks = (async function* (): AsyncGenerator<UpstreamChunk> {
				try {
					for await (const chunk of parsed) {
						// OpenRouter can fail mid-stream as an SSE payload instead of an
						// HTTP status; reclassify it so callers see one error shape.
						const errPayload = chunk.raw.error;
						if (errPayload !== undefined && errPayload !== null) throw streamError(errPayload);
						if (!idResolved && typeof chunk.raw.id === "string") resolveOnce(chunk.raw.id);
						yield chunk;
					}
				} catch (err) {
					throw transportError(err);
				} finally {
					// generationId() must never hang, even if the consumer abandons
					// the stream before the first chunk.
					resolveOnce(null);
				}
			})();

			return { chunks, generationId: () => idPromise };
		},

		async complete(
			body: Record<string, unknown>,
			signal: AbortSignal,
		): Promise<{ text: string; costUsd: number | null }> {
			// Single attempt by design: this feeds the classifier adjudicator,
			// where a retry would double adjudication cost on ambiguous turns.
			let res: Response;
			try {
				res = await fetch(`${baseUrl}/chat/completions`, {
					method: "POST",
					headers: headers({}),
					body: JSON.stringify({ ...body, stream: false }),
					signal: composeSignal(signal),
				});
			} catch (err) {
				throw transportError(err);
			}
			if (!res.ok) throw await httpError(res);
			const json = asRec(await res.json());
			const choices = json?.choices;
			const choice0 = Array.isArray(choices) && choices.length > 0 ? asRec(choices[0]) : null;
			const message = choice0 ? asRec(choice0.message) : null;
			const content = message?.content;
			const usage = json ? asRec(json.usage) : null;
			const cost = usage?.cost;
			return {
				text: typeof content === "string" ? content : "",
				costUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
			};
		},

		async fetchModels(signal?: AbortSignal): Promise<unknown[]> {
			let res: Response;
			try {
				res = await fetch(`${baseUrl}/models`, { headers: headers({}), signal: composeSignal(signal) });
			} catch (err) {
				throw transportError(err);
			}
			if (!res.ok) throw await httpError(res);
			const data = asRec(await res.json())?.data;
			if (!Array.isArray(data)) {
				throw new UpstreamError("upstream_error", res.status, "models payload had no data array", true);
			}
			return data;
		},
	};
}
