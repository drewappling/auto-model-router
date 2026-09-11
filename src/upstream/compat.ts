/**
 * A named OpenAI-compatible upstream: OpenAI itself, Azure OpenAI, a vLLM or
 * any other server speaking `/chat/completions`. Configured in
 * `upstreams: []` with a static, priced model list (there is no universal
 * catalog to fetch); its models appear in the catalog as `<id>/<model>` and
 * dispatch here, exactly as `ollama/…` does.
 *
 * The rendered body is OpenRouter dialect, so the same rewrite Ollama needs
 * applies: strip the slug prefix, drop `models[]` and `session_id`, turn the
 * `reasoning` object into `reasoning_effort`, strip `cache_control` markers,
 * and ask for usage in the final chunk. Azure differs only in the URL (the
 * deployment name is the model) and the `api-key` header.
 *
 * A 429 trips a short breaker and an out-of-quota answer a longer one; the
 * composite catalog hides the upstream's models while it is open, so a turn
 * routes around it instead of paying a doomed dispatch first.
 */

import type { RouterConfig, UpstreamEntry } from "../config/types.ts";
import type { CompletionResult } from "./types.ts";
import { openaiToolCalls } from "./toolcalls.ts";
import { createLogger } from "../util/log.ts";
import type { StreamEvent, UpstreamChunk } from "../wire/types.ts";
import type { FetchLike, OllamaAvailability } from "./ollama.ts";
import { parseSse } from "./sse-parse.ts";
import { UpstreamError, type Dispatch, type DispatchOptions, type UpstreamClient, type UpstreamErrorKind } from "./types.ts";

/** The breaker view any named upstream exposes; the Ollama one is the same shape. */
export type UpstreamAvailability = OllamaAvailability;

export interface NamedUpstreamClient extends UpstreamClient, UpstreamAvailability {
	readonly id: string;
}

function asRec(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The model id after the `<id>/` prefix, or the slug itself when it carries none. */
export function upstreamModelId(id: string, slug: string): string {
	return slug.startsWith(`${id}/`) ? slug.slice(id.length + 1) : slug;
}

const REASONING_EFFORT_MAP: Record<string, string> = {
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "high",
	max: "high",
};

/** Rewrites an OpenRouter-shaped body into plain OpenAI chat-completions. Pure. */
export function toCompatBody(id: string, body: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...body };
	if (typeof out.model === "string") out.model = upstreamModelId(id, out.model);
	delete out.models;
	delete out.session_id;
	delete out.stream_options;
	const reasoning = asRec(out.reasoning);
	delete out.reasoning;
	delete out.reasoning_effort;
	if (reasoning !== null && reasoning.enabled !== false && typeof reasoning.effort === "string") {
		const mapped = REASONING_EFFORT_MAP[reasoning.effort];
		if (mapped !== undefined) out.reasoning_effort = mapped;
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

/** HTTP status → error kind for an OpenAI-shaped API. */
export function classifyCompatStatus(id: string, status: number, body: unknown): UpstreamError {
	const rec = asRec(body);
	const errRec = rec ? asRec(rec.error) : null;
	const msg = errRec?.message ?? rec?.message ?? rec?.error;
	const message = typeof msg === "string" && msg !== "" ? msg : `${id} HTTP ${status}`;
	const code = typeof errRec?.code === "string" ? errRec.code : typeof errRec?.type === "string" ? errRec.type : "";
	const fail = (kind: UpstreamErrorKind, retryable: boolean): UpstreamError => new UpstreamError(kind, status, message, retryable, body);
	if (status === 401) return fail("auth", false);
	if (status === 402) return fail("quota", true);
	if (status === 403) return /credit|quota|plan|limit|billing/i.test(message) ? fail("quota", true) : fail("moderation", true);
	// OpenAI reports an exhausted balance as a 429 with insufficient_quota: the account, not the moment.
	if (status === 429) return /insufficient_quota|exceeded your current quota/i.test(`${code} ${message}`) ? fail("quota", true) : fail("rate_limit", true);
	if (status === 404) return fail("model_unavailable", true);
	if (status === 400 || status === 413 || status === 422) {
		if (/context|too many tokens|token limit|maximum context|too long/i.test(message)) return fail("context_length", false);
		return fail("invalid_request", /support|unsupported|does not|not available/i.test(message));
	}
	if (status >= 500) return fail("upstream_error", true);
	return fail("upstream_error", status === 408);
}

function transportError(id: string, err: unknown): UpstreamError {
	if (err instanceof UpstreamError) return err;
	const name = err instanceof Error ? err.name : "";
	if (name === "TimeoutError") return new UpstreamError("timeout", 0, `${id} request timed out`, true);
	if (name === "AbortError") return new UpstreamError("aborted", 0, "request aborted", false);
	return new UpstreamError("network", 0, err instanceof Error ? err.message : String(err), true);
}

/** The chat-completions URL and auth for an entry: Azure names the deployment in the path and keys with `api-key`. */
export function compatEndpoint(entry: UpstreamEntry, modelId: string): { url: string; headers: Record<string, string> } {
	const base = entry.baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> = { "content-type": "application/json", ...entry.headers };
	if (entry.kind === "azure") {
		if (entry.apiKey !== "") headers["api-key"] = entry.apiKey;
		return { url: `${base}/openai/deployments/${encodeURIComponent(modelId)}/chat/completions?api-version=${encodeURIComponent(entry.apiVersion)}`, headers };
	}
	if (entry.apiKey !== "") headers.authorization = `Bearer ${entry.apiKey}`;
	return { url: `${base}/chat/completions`, headers };
}

/** Circuit-breaker state shared by the named clients. */
export function createBreaker(id: string, log: ReturnType<typeof createLogger>, cooldownFor: (kind: UpstreamErrorKind) => number): UpstreamAvailability & { trip(err: UpstreamError): void } {
	let cooldownUntil = 0;
	let lastTrip: { kind: UpstreamErrorKind; atMs: number; message: string } | null = null;
	return {
		available: () => Date.now() >= cooldownUntil,
		cooldownUntilMs: () => (Date.now() >= cooldownUntil ? null : cooldownUntil),
		lastTrip: () => lastTrip,
		trip(err) {
			const ms = cooldownFor(err.kind);
			if (ms <= 0) return;
			cooldownUntil = Math.max(cooldownUntil, Date.now() + ms);
			lastTrip = { kind: err.kind, atMs: Date.now(), message: err.message };
			log.warn(`upstream ${id} unavailable; routing around it`, { kind: err.kind, cooldownMs: ms, message: err.message });
		},
	};
}

/** Re-prefixes the served model so state/ledger keys match the catalog slug. */
export function prefixServedWith(prefix: string, chunk: UpstreamChunk): UpstreamChunk {
	let events: StreamEvent[] | null = null;
	for (let i = 0; i < chunk.events.length; i++) {
		const ev = chunk.events[i];
		if (ev !== undefined && ev.type === "start" && !ev.servedSlug.startsWith(prefix)) {
			events ??= [...chunk.events];
			events[i] = { ...ev, servedSlug: `${prefix}${ev.servedSlug}` };
		}
	}
	const raw = typeof chunk.raw.model === "string" && !chunk.raw.model.startsWith(prefix) ? { ...chunk.raw, model: `${prefix}${chunk.raw.model}` } : chunk.raw;
	return events === null && raw === chunk.raw ? chunk : { raw, events: events ?? chunk.events };
}

/** The live entry for an id, read per call so a hot-reloaded list applies to the next dispatch. */
export function upstreamLookup(cfg: RouterConfig, id: string): () => UpstreamEntry | undefined {
	return () => cfg.upstreams.find((u) => u.id === id);
}

export function createCompatClient(cfg: RouterConfig, id: string, fetchImpl: FetchLike = fetch): NamedUpstreamClient {
	const lookup = upstreamLookup(cfg, id);
	const log = createLogger(cfg.logLevel);
	const entry = (): UpstreamEntry => {
		const e = lookup();
		if (e === undefined) throw new UpstreamError("model_unavailable", 0, `upstream ${id} is no longer configured`, true);
		return e;
	};
	const breaker = createBreaker(id, log, (kind) => {
		const e = lookup();
		if (e === undefined) return 0;
		return kind === "quota" ? e.quotaCooldownMs : kind === "rate_limit" ? e.rateLimitCooldownMs : 0;
	});
	const prefix = `${id}/`;

	function composeSignal(e: UpstreamEntry, caller: AbortSignal | undefined): AbortSignal | null {
		const timeout = e.timeoutMs > 0 ? AbortSignal.timeout(e.timeoutMs) : null;
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
		const err = classifyCompatStatus(id, res.status, body);
		breaker.trip(err);
		return err;
	}

	async function post(e: UpstreamEntry, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Response> {
		const { url, headers } = compatEndpoint(e, typeof body.model === "string" ? body.model : "");
		try {
			return await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(body), signal: composeSignal(e, signal) });
		} catch (err) {
			throw transportError(id, err);
		}
	}

	return {
		id,
		available: breaker.available,
		cooldownUntilMs: breaker.cooldownUntilMs,
		lastTrip: breaker.lastTrip,

		async dispatch(opts: DispatchOptions): Promise<Dispatch> {
			const e = entry();
			const res = await post(e, toCompatBody(id, { ...opts.body, stream: true }), opts.signal);
			if (!res.ok) throw await httpError(res);
			if (!res.body) throw new UpstreamError("upstream_error", res.status, "response had no body", true);
			const parsed = parseSse(res.body, (msg, fields) => log.warn(msg, fields));
			let resolveId!: (v: string | null) => void;
			const idPromise = new Promise<string | null>((resolve) => {
				resolveId = resolve;
			});
			let idResolved = false;
			const resolveOnce = (v: string | null): void => {
				if (!idResolved) {
					idResolved = true;
					resolveId(v);
				}
			};
			const chunks = (async function* (): AsyncGenerator<UpstreamChunk> {
				try {
					for await (const chunk of parsed) {
						const errPayload = chunk.raw.error;
						if (errPayload !== undefined && errPayload !== null) {
							const rec = asRec(errPayload) ?? {};
							throw new UpstreamError("upstream_error", 0, typeof rec.message === "string" ? rec.message : `${id} stream error`, true, errPayload);
						}
						if (!idResolved && typeof chunk.raw.id === "string") resolveOnce(chunk.raw.id);
						yield prefixServedWith(prefix, chunk);
					}
				} catch (err) {
					throw transportError(id, err);
				} finally {
					resolveOnce(null);
				}
			})();
			return { chunks, generationId: () => idPromise };
		},

		async complete(body: Record<string, unknown>, signal: AbortSignal): Promise<CompletionResult> {
			const e = entry();
			const res = await post(e, toCompatBody(id, { ...body, stream: false }), signal);
			if (!res.ok) throw await httpError(res);
			const json = asRec(await res.json());
			const choices = json?.choices;
			const choice0 = Array.isArray(choices) && choices.length > 0 ? asRec(choices[0]) : null;
			const message = choice0 ? asRec(choice0.message) : null;
			const content = message?.content;
			return { text: typeof content === "string" ? content : "", costUsd: null, toolCalls: openaiToolCalls(message) };
		},

		// The catalog is static configuration; nothing to fetch.
		async fetchModels(): Promise<unknown[]> {
			return [];
		},
		async fetchModelsForUser(): Promise<unknown[]> {
			return [];
		},
	};
}
