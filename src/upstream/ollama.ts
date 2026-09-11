/**
 * Ollama Cloud transport: Ollama's OpenAI-compatible `/v1/chat/completions`,
 * either on ollama.com directly (API key) or through a local daemon that
 * proxies `:cloud` models under the signed-in account.
 *
 * Same shape as the OpenRouter client, with the differences Ollama's
 * compatibility layer imposes applied to the rendered body just before it
 * goes out:
 *
 *  - the `ollama/` catalog prefix is stripped from `model`;
 *  - `models[]` (OpenRouter's fallback cascade) and `session_id` are removed;
 *  - `tool_choice` is removed (documented as unsupported);
 *  - OpenRouter's `reasoning: {effort}` object becomes `reasoning_effort`;
 *  - `cache_control` markers are stripped from content parts (Anthropic-style
 *    breakpoints mean nothing here and could be rejected);
 *  - `stream_options.include_usage` is set so the final chunk carries usage.
 *
 * Ollama returns no `usage.cost`, so the ledger's predicted figure stands in
 * as the reported one; the catalog price is the published per-token rate.
 *
 * Plan limits are the other difference. Ollama meters cloud usage against
 * monthly credits and a per-plan concurrency cap (1/3/10), so 402 and 429 are
 * routine, not exceptional. Both trip a circuit breaker: the composite catalog
 * hides every Ollama model while it is open, so a turn falls straight through
 * to OpenRouter instead of paying a doomed dispatch first.
 */

import type { RouterConfig } from "../config/types.ts";
import type { CompletionResult } from "./types.ts";
import { openaiToolCalls } from "./toolcalls.ts";
import { OLLAMA_SLUG_PREFIX, ollamaModelId } from "../catalog/ollama-catalog.ts";
import { createLogger } from "../util/log.ts";
import type { StreamEvent, UpstreamChunk } from "../wire/types.ts";
import { parseSse } from "./sse-parse.ts";
import { UpstreamError, type Dispatch, type DispatchOptions, type UpstreamClient, type UpstreamErrorKind } from "./types.ts";

/** Circuit-breaker view the catalog consults. */
export interface OllamaAvailability {
	/** False while a quota/rate-limit cooldown is in force. */
	available(): boolean;
	/** Epoch ms the cooldown ends, or null when available. */
	cooldownUntilMs(): number | null;
	/** Why the breaker is open, for /health. */
	lastTrip(): { kind: UpstreamErrorKind; atMs: number; message: string } | null;
}

export interface OllamaClient extends UpstreamClient, OllamaAvailability {}

function asRec(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const REASONING_EFFORT_MAP: Record<string, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
};

/** Rewrites an OpenRouter-shaped request body into what Ollama accepts. Pure. */
export function toOllamaBody(body: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...body };
	if (typeof out.model === "string") out.model = ollamaModelId(out.model);
	delete out.models;
	delete out.session_id;
	delete out.tool_choice;
	delete out.stream_options;
	const reasoning = asRec(out.reasoning);
	delete out.reasoning;
	delete out.reasoning_effort;
	if (reasoning !== null) {
		if (reasoning.enabled === false) {
			// Nothing: omitting the field is "no explicit effort" on Ollama.
		} else if (typeof reasoning.effort === "string") {
			const mapped = REASONING_EFFORT_MAP[reasoning.effort];
			if (mapped !== undefined) out.reasoning_effort = mapped;
		}
	}
	if (Array.isArray(out.messages)) {
		out.messages = out.messages.map((m) => {
			const msg = asRec(m);
			if (msg === null || !Array.isArray(msg.content)) return m;
			return {
				...msg,
				content: msg.content.map((part) => {
					const p = asRec(part);
					if (p === null || !("cache_control" in p)) return part;
					const { cache_control: _dropped, ...rest } = p;
					return rest;
				}),
			};
		});
	}
	if (out.stream === true) out.stream_options = { include_usage: true };
	return out;
}

/** HTTP status → error kind. 402/429 are plan limits, not model faults. */
export function classifyOllamaStatus(status: number, body: unknown): UpstreamError {
	const rec = asRec(body);
	const errRec = rec ? asRec(rec.error) : null;
	const msg = errRec?.message ?? rec?.message ?? rec?.error;
	const message = typeof msg === "string" && msg !== "" ? msg : `Ollama HTTP ${status}`;
	const fail = (kind: UpstreamErrorKind, retryable: boolean): UpstreamError => new UpstreamError(kind, status, message, retryable, body);
	if (status === 401) return fail("auth", false);
	// Out of credits (or a plan gate): the account, not the model. Fail over.
	if (status === 402) return fail("quota", true);
	if (status === 403) return /credit|quota|plan|limit|billing/i.test(message) ? fail("quota", true) : fail("moderation", true);
	if (status === 429) return fail("rate_limit", true);
	if (status === 404) return fail("model_unavailable", true);
	if (status === 400) {
		if (/context|too many tokens|token limit/i.test(message)) return fail("context_length", false);
		return fail("invalid_request", /support|unsupported|does not/i.test(message));
	}
	if (status >= 500) return fail("upstream_error", true);
	return fail("upstream_error", status === 408);
}

function transportError(err: unknown): UpstreamError {
	if (err instanceof UpstreamError) return err;
	const name = err instanceof Error ? err.name : "";
	if (name === "TimeoutError") return new UpstreamError("timeout", 0, "Ollama request timed out", true);
	if (name === "AbortError") return new UpstreamError("aborted", 0, "request aborted", false);
	return new UpstreamError("network", 0, err instanceof Error ? err.message : String(err), true);
}

/** Minimal fetch surface, injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function createOllamaClient(cfg: RouterConfig, fetchImpl: FetchLike = fetch): OllamaClient {
	const o = cfg.ollama;
	// Read per call, not captured: `o` is the live config block, so a base URL
	// changed while the router runs takes effect on the next dispatch.
	const baseUrl = (): string => o.baseUrl.replace(/\/+$/, "");
	const log = createLogger(cfg.logLevel);
	let cooldownUntil = 0;
	let lastTrip: { kind: UpstreamErrorKind; atMs: number; message: string } | null = null;

	const trip = (err: UpstreamError): void => {
		const ms = err.kind === "quota" ? o.quotaCooldownMs : err.kind === "rate_limit" ? o.rateLimitCooldownMs : 0;
		if (ms <= 0) return;
		cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
		lastTrip = { kind: err.kind, atMs: Date.now(), message: err.message };
		log.warn("ollama cloud unavailable; routing around it", { kind: err.kind, cooldownMs: ms, message: err.message });
	};

	function headers(extra: Record<string, string> = {}): Record<string, string> {
		const h: Record<string, string> = { "content-type": "application/json", ...extra };
		if (o.apiKey !== "") h.authorization = `Bearer ${o.apiKey}`;
		return h;
	}

	function composeSignal(caller: AbortSignal | undefined): AbortSignal | null {
		const timeout = o.timeoutMs > 0 ? AbortSignal.timeout(o.timeoutMs) : null;
		if (caller && timeout) return AbortSignal.any([caller, timeout]);
		return caller ?? timeout;
	}

	async function httpError(res: Response): Promise<UpstreamError> {
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			// Status alone drives classification.
		}
		const err = classifyOllamaStatus(res.status, body);
		trip(err);
		return err;
	}

	/** Re-prefixes the served model so state/ledger keys match the catalog slug. */
	function prefixServed(chunk: UpstreamChunk): UpstreamChunk {
		let events: StreamEvent[] | null = null;
		for (let i = 0; i < chunk.events.length; i++) {
			const ev = chunk.events[i];
			if (ev !== undefined && ev.type === "start" && !ev.servedSlug.startsWith(OLLAMA_SLUG_PREFIX)) {
				events ??= [...chunk.events];
				events[i] = { ...ev, servedSlug: `${OLLAMA_SLUG_PREFIX}${ev.servedSlug}` };
			}
		}
		const raw = typeof chunk.raw.model === "string" && !chunk.raw.model.startsWith(OLLAMA_SLUG_PREFIX) ? { ...chunk.raw, model: `${OLLAMA_SLUG_PREFIX}${chunk.raw.model}` } : chunk.raw;
		return events === null && raw === chunk.raw ? chunk : { raw, events: events ?? chunk.events };
	}

	return {
		available: () => Date.now() >= cooldownUntil,
		cooldownUntilMs: () => (Date.now() >= cooldownUntil ? null : cooldownUntil),
		lastTrip: () => lastTrip,

		async dispatch(opts: DispatchOptions): Promise<Dispatch> {
			const body = toOllamaBody({ ...opts.body, stream: true });
			let res: Response;
			try {
				res = await fetchImpl(`${baseUrl()}/chat/completions`, {
					method: "POST",
					headers: headers(),
					body: JSON.stringify(body),
					signal: composeSignal(opts.signal),
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
						const errPayload = chunk.raw.error;
						if (errPayload !== undefined && errPayload !== null) {
							const rec = asRec(errPayload) ?? {};
							const message = typeof rec.message === "string" ? rec.message : "Ollama stream error";
							throw new UpstreamError("upstream_error", 0, message, true, errPayload);
						}
						if (!idResolved && typeof chunk.raw.id === "string") resolveOnce(chunk.raw.id);
						yield prefixServed(chunk);
					}
				} catch (err) {
					throw transportError(err);
				} finally {
					resolveOnce(null);
				}
			})();
			return { chunks, generationId: () => idPromise };
		},

		async complete(body: Record<string, unknown>, signal: AbortSignal): Promise<CompletionResult> {
			let res: Response;
			try {
				res = await fetchImpl(`${baseUrl()}/chat/completions`, {
					method: "POST",
					headers: headers(),
					body: JSON.stringify(toOllamaBody({ ...body, stream: false })),
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
			return { text: typeof content === "string" ? content : "", costUsd: null, toolCalls: openaiToolCalls(message) };
		},

		async fetchModels(signal?: AbortSignal): Promise<unknown[]> {
			let res: Response;
			try {
				res = await fetchImpl(`${baseUrl()}/models`, { headers: headers(), signal: composeSignal(signal) });
			} catch (err) {
				throw transportError(err);
			}
			if (!res.ok) throw await httpError(res);
			const data = asRec(await res.json())?.data;
			if (!Array.isArray(data)) throw new UpstreamError("upstream_error", res.status, "models payload had no data array", true);
			return data;
		},

		fetchModelsForUser(signal?: AbortSignal): Promise<unknown[]> {
			return this.fetchModels(signal);
		},
	};
}
