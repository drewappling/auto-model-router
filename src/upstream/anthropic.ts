/**
 * A native Anthropic upstream (`api.anthropic.com/v1/messages`), configured as
 * an `upstreams: []` entry of kind `anthropic` with a static priced model list.
 *
 * The router's internal shape is OpenAI chat-completions, so this client
 * translates in both directions: the rendered body becomes a Messages request
 * (system blocks, alternating user/assistant turns, tool_use / tool_result
 * blocks, tools with input_schema, thinking from the reasoning effort,
 * `cache_control` markers kept because Anthropic honours them natively), and
 * the Messages SSE stream becomes the same `UpstreamChunk`s an OpenAI stream
 * yields — the `raw` of each chunk is a synthesised chat-completions chunk,
 * because the wire forwards `raw` to OpenAI-protocol clients.
 *
 * Usage follows the OpenAI convention the ledger expects: prompt tokens INCLUDE
 * the cached and cache-written ones, reported as sub-counts. Anthropic reports
 * no cost, so the catalog price (with its cache read/write rates) applies.
 */

import type { RouterConfig, UpstreamEntry, UpstreamModelConfig } from "../config/types.ts";
import type { CompletionResult } from "./types.ts";
import { anthropicToolCalls } from "./toolcalls.ts";
import type { UsageCounts } from "../cost/types.ts";
import { createLogger } from "../util/log.ts";
import type { FinishReason, StreamEvent, UpstreamChunk } from "../wire/types.ts";
import { createBreaker, type NamedUpstreamClient, upstreamLookup, upstreamModelId } from "./compat.ts";
import type { FetchLike } from "./ollama.ts";
import { UpstreamError, type Dispatch, type DispatchOptions, type UpstreamErrorKind } from "./types.ts";

export const ANTHROPIC_VERSION = "2023-06-01";

function asRec(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Thinking budgets per reasoning effort, in tokens. */
const THINKING_BUDGET: Record<string, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32000, max: 32000 };

type Block = Record<string, unknown>;

function textBlocks(content: unknown, keepCache: boolean): Block[] {
	if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	const out: Block[] = [];
	for (const partRaw of content) {
		const part = asRec(partRaw);
		if (part === null) continue;
		if (part.type === "text" && typeof part.text === "string") {
			if (part.text === "") continue;
			const block: Block = { type: "text", text: part.text };
			if (keepCache && part.cache_control !== undefined) block.cache_control = part.cache_control;
			out.push(block);
		} else if (part.type === "image_url") {
			const url = typeof part.image_url === "string" ? part.image_url : (asRec(part.image_url)?.url as string | undefined);
			if (typeof url !== "string") continue;
			const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
			out.push(m !== null ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } } : { type: "image", source: { type: "url", url } });
		}
	}
	return out;
}

function toolResultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((p) => (typeof (asRec(p)?.text) === "string" ? (asRec(p)!.text as string) : "")).join("");
	return content === null || content === undefined ? "" : JSON.stringify(content);
}

export interface AnthropicBodyOptions {
	/** The bare model id sent upstream. */
	modelId: string;
	/** The model's published completion ceiling, when known; caps max_tokens. */
	maxCompletionTokens?: number;
	supportsReasoning: boolean;
}

/** Renders an OpenAI-shaped (OpenRouter dialect) body as an Anthropic Messages request. Pure. */
export function toAnthropicBody(body: Record<string, unknown>, opts: AnthropicBodyOptions): Record<string, unknown> {
	const system: Block[] = [];
	const messages: { role: "user" | "assistant"; content: Block[] }[] = [];
	const push = (role: "user" | "assistant", blocks: Block[]): void => {
		if (blocks.length === 0) return;
		const last = messages[messages.length - 1];
		// Anthropic wants strict alternation: adjacent same-role turns fold into one.
		if (last !== undefined && last.role === role) last.content.push(...blocks);
		else messages.push({ role, content: blocks });
	};
	for (const mRaw of Array.isArray(body.messages) ? body.messages : []) {
		const m = asRec(mRaw);
		if (m === null) continue;
		switch (m.role) {
			case "system":
			case "developer":
				system.push(...textBlocks(m.content, true));
				break;
			case "user":
				push("user", textBlocks(m.content, true));
				break;
			case "assistant": {
				const blocks = textBlocks(m.content, false);
				if (Array.isArray(m.tool_calls)) {
					for (const tcRaw of m.tool_calls) {
						const tc = asRec(tcRaw);
						const fn = tc ? asRec(tc.function) : null;
						if (tc === null || fn === null || typeof fn.name !== "string") continue;
						let input: unknown = {};
						if (typeof fn.arguments === "string" && fn.arguments.trim() !== "") {
							try {
								input = JSON.parse(fn.arguments);
							} catch {
								input = { _raw: fn.arguments };
							}
						}
						blocks.push({ type: "tool_use", id: typeof tc.id === "string" ? tc.id : `call_${blocks.length}`, name: fn.name, input });
					}
				}
				push("assistant", blocks);
				break;
			}
			case "tool":
				push("user", [{ type: "tool_result", tool_use_id: typeof m.tool_call_id === "string" ? m.tool_call_id : "", content: toolResultText(m.content) }]);
				break;
			default:
				break;
		}
	}
	// The conversation must open with the user.
	if (messages.length === 0 || messages[0]!.role !== "user") messages.unshift({ role: "user", content: [{ type: "text", text: "(continue)" }] });

	const out: Record<string, unknown> = { model: opts.modelId, messages, stream: body.stream === true };
	if (system.length > 0) out.system = system;
	const requested = typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : typeof body.max_tokens === "number" ? body.max_tokens : 4096;
	let maxTokens = opts.maxCompletionTokens !== undefined ? Math.min(requested, opts.maxCompletionTokens) : requested;
	if (typeof body.temperature === "number") out.temperature = body.temperature;
	if (typeof body.top_p === "number") out.top_p = body.top_p;
	if (typeof body.stop === "string") out.stop_sequences = [body.stop];
	else if (Array.isArray(body.stop)) out.stop_sequences = body.stop.filter((s): s is string => typeof s === "string");

	const tools = Array.isArray(body.tools) ? body.tools : [];
	const mapped: Block[] = [];
	for (const tRaw of tools) {
		const fn = asRec(asRec(tRaw)?.function);
		if (fn === null || typeof fn.name !== "string") continue;
		const tool: Block = { name: fn.name, input_schema: asRec(fn.parameters) ?? { type: "object", properties: {} } };
		if (typeof fn.description === "string") tool.description = fn.description;
		mapped.push(tool);
	}
	if (mapped.length > 0) {
		out.tools = mapped;
		const choice = body.tool_choice;
		const disableParallel = body.parallel_tool_calls === false;
		if (choice === "required") out.tool_choice = { type: "any", disable_parallel_tool_use: disableParallel };
		else if (choice === "none") delete out.tools;
		else if (asRec(choice)?.type === "function" && typeof asRec(asRec(choice)?.function)?.name === "string") out.tool_choice = { type: "tool", name: asRec(asRec(choice)?.function)!.name, disable_parallel_tool_use: disableParallel };
		else if (disableParallel) out.tool_choice = { type: "auto", disable_parallel_tool_use: true };
	}

	const reasoning = asRec(body.reasoning);
	if (opts.supportsReasoning && reasoning !== null && reasoning.enabled !== false && typeof reasoning.effort === "string") {
		const budget = THINKING_BUDGET[reasoning.effort];
		if (budget !== undefined) {
			// max_tokens must exceed the budget; thinking also forbids sampling knobs.
			if (maxTokens <= budget) maxTokens = budget + 1024;
			out.thinking = { type: "enabled", budget_tokens: budget };
			delete out.temperature;
			delete out.top_p;
		}
	}
	out.max_tokens = maxTokens;
	return out;
}

/** One SSE frame with its event name; the shared parser drops names, and Anthropic routes on them. */
export interface SseFrame {
	event: string;
	data: string;
}

export async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	let event = "";
	let data: string[] = [];
	const flush = (): SseFrame | null => {
		if (data.length === 0 && event === "") return null;
		const frame = { event, data: data.join("\n") };
		event = "";
		data = [];
		return frame;
	};
	const line = (l: string): SseFrame | null => {
		if (l === "") return flush();
		if (l.startsWith(":")) return null;
		if (l.startsWith("event:")) event = l.slice(6).trim();
		else if (l.startsWith("data:")) data.push(l.slice(5).replace(/^ /, ""));
		return null;
	};
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const l = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				const f = line(l.endsWith("\r") ? l.slice(0, -1) : l);
				if (f !== null) yield f;
			}
		}
		buf += decoder.decode();
		if (buf.length > 0) {
			const f = line(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
			if (f !== null) yield f;
		}
		const f = flush();
		if (f !== null) yield f;
	} finally {
		reader.releaseLock();
	}
}

function mapStop(reason: unknown): FinishReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "tool_calls";
		case "refusal":
			return "content_filter";
		default:
			return "stop";
	}
}

/**
 * Turns Anthropic stream events into the router's chunks, one call per frame.
 * `servedSlug` is the catalog slug (`<id>/<model>`) the chunks report.
 */
export function createAnthropicTranslator(servedSlug: string): { push(frame: SseFrame): UpstreamChunk | null; generationId(): string | null } {
	let id: string | null = null;
	let started = false;
	let toolCount = 0;
	const toolIndexByBlock = new Map<number, number>();
	let inputTokens = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	const created = Math.floor(Date.now() / 1000);
	const chunk = (delta: Record<string, unknown>, finish: FinishReason | null, events: StreamEvent[], usage?: Record<string, unknown>): UpstreamChunk => {
		const raw: Record<string, unknown> = { id: id ?? "", object: "chat.completion.chunk", created, model: servedSlug, choices: [{ index: 0, delta, finish_reason: finish }] };
		if (usage !== undefined) raw.usage = usage;
		return { raw, events };
	};
	return {
		generationId: () => id,
		push(frame) {
			let data: Record<string, unknown> | null = null;
			try {
				data = asRec(JSON.parse(frame.data));
			} catch {
				return null;
			}
			if (data === null) return null;
			const type = typeof data.type === "string" ? data.type : frame.event;
			switch (type) {
				case "message_start": {
					const message = asRec(data.message);
					const usage = asRec(message?.usage);
					id = typeof message?.id === "string" ? message.id : null;
					inputTokens = num(usage?.input_tokens);
					cacheRead = num(usage?.cache_read_input_tokens);
					cacheWrite = num(usage?.cache_creation_input_tokens);
					started = true;
					return chunk({ role: "assistant", content: "" }, null, [{ type: "start", servedSlug, generationId: id }]);
				}
				case "content_block_start": {
					const block = asRec(data.content_block);
					const index = num(data.index);
					if (block?.type === "tool_use") {
						const toolIndex = toolCount++;
						toolIndexByBlock.set(index, toolIndex);
						const callId = typeof block.id === "string" ? block.id : `call_${toolIndex}`;
						const name = typeof block.name === "string" ? block.name : "";
						return chunk({ tool_calls: [{ index: toolIndex, id: callId, type: "function", function: { name, arguments: "" } }] }, null, [{ type: "tool_call", index: toolIndex, id: callId, name }]);
					}
					return null;
				}
				case "content_block_delta": {
					const delta = asRec(data.delta);
					const index = num(data.index);
					if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text !== "") return chunk({ content: delta.text }, null, [{ type: "text", delta: delta.text }]);
					if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking !== "") return chunk({ reasoning: delta.thinking }, null, [{ type: "reasoning", delta: delta.thinking }]);
					if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json !== "") {
						const toolIndex = toolIndexByBlock.get(index) ?? 0;
						return chunk({ tool_calls: [{ index: toolIndex, function: { arguments: delta.partial_json } }] }, null, [{ type: "tool_call", index: toolIndex, argsDelta: delta.partial_json }]);
					}
					return null;
				}
				case "message_delta": {
					const delta = asRec(data.delta);
					const usage = asRec(data.usage);
					const finish = mapStop(delta?.stop_reason);
					const output = num(usage?.output_tokens);
					// A final reading may restate the input side; prefer it when present.
					if (usage?.input_tokens !== undefined) inputTokens = num(usage.input_tokens);
					if (usage?.cache_read_input_tokens !== undefined) cacheRead = num(usage.cache_read_input_tokens);
					if (usage?.cache_creation_input_tokens !== undefined) cacheWrite = num(usage.cache_creation_input_tokens);
					const counts: UsageCounts = { promptTokens: inputTokens + cacheRead + cacheWrite, cachedTokens: cacheRead, cacheWriteTokens: cacheWrite, completionTokens: output, reasoningTokens: 0, images: 0 };
					return chunk({}, finish, [{ type: "finish", reason: finish }, { type: "usage", usage: counts, reportedCostUsd: null }], {
						prompt_tokens: counts.promptTokens,
						completion_tokens: output,
						total_tokens: counts.promptTokens + output,
						prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
					});
				}
				case "error": {
					const err = asRec(data.error);
					const message = typeof err?.message === "string" ? err.message : "Anthropic stream error";
					throw new UpstreamError(err?.type === "overloaded_error" ? "upstream_error" : "upstream_error", 0, message, true, data);
				}
				default:
					// ping, content_block_stop, message_stop: nothing to forward.
					return started ? null : null;
			}
		},
	};
}

/** HTTP status → error kind for the Messages API. */
export function classifyAnthropicStatus(id: string, status: number, body: unknown): UpstreamError {
	const rec = asRec(body);
	const errRec = rec ? asRec(rec.error) : null;
	const msg = errRec?.message ?? rec?.message;
	const message = typeof msg === "string" && msg !== "" ? msg : `${id} HTTP ${status}`;
	const fail = (kind: UpstreamErrorKind, retryable: boolean): UpstreamError => new UpstreamError(kind, status, message, retryable, body);
	if (status === 401 || status === 403) return fail("auth", false);
	if (status === 404) return fail("model_unavailable", true);
	if (status === 413) return fail("context_length", false);
	if (status === 429) return fail("rate_limit", true);
	if (status === 400 || status === 422) return /prompt is too long|too many tokens|context/i.test(message) ? fail("context_length", false) : fail("invalid_request", false);
	if (status === 529) return fail("upstream_error", true);
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

/**
 * Anthropic accepts a Pro/Max subscription token only on Claude Code's own traffic: unless
 * the FIRST system block carries this exact line, the API answers 429 `rate_limit_error`
 * with the message "Error" — a refusal wearing a quota's clothes, not a real rate limit,
 * which the breaker would otherwise read as "slow down" and cool the upstream off.
 *
 * Claude Code sends it itself. Every other client — an OpenAI-wire caller, the router's own
 * classifier and digest chores — would be refused, so an `oauth-bearer` upstream adds it
 * when it is missing. It goes in as its own leading block rather than being merged into the
 * caller's text, because that is the shape Claude Code sends and it keeps the caller's
 * `cache_control` markers attached to the blocks they were written for.
 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function withClaudeCodeIdentity(body: Record<string, unknown>): Record<string, unknown> {
	const system = Array.isArray(body.system) ? (body.system as Block[]) : [];
	const first = asRec(system[0]);
	if (first !== null && typeof first.text === "string" && first.text.startsWith(CLAUDE_CODE_IDENTITY)) return body;
	return { ...body, system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }, ...system] };
}

export function createAnthropicClient(cfg: RouterConfig, id: string, fetchImpl: FetchLike = fetch): NamedUpstreamClient {
	const lookup = upstreamLookup(cfg, id);
	const log = createLogger(cfg.logLevel);
	const entry = (): UpstreamEntry => {
		const e = lookup();
		if (e === undefined) throw new UpstreamError("model_unavailable", 0, `upstream ${id} is no longer configured`, true);
		return e;
	};
	// An overloaded API (529) is a moment, not a fault: a short cooldown like a rate limit.
	const breaker = createBreaker(id, log, (kind) => {
		const e = lookup();
		if (e === undefined) return 0;
		return kind === "quota" ? e.quotaCooldownMs : kind === "rate_limit" || kind === "upstream_error" ? e.rateLimitCooldownMs : 0;
	});

	function modelInfo(e: UpstreamEntry, slug: string): { modelId: string; model: UpstreamModelConfig | undefined } {
		const modelId = upstreamModelId(id, slug);
		return { modelId, model: e.models.find((m) => m.id === modelId) };
	}
	function render(e: UpstreamEntry, body: Record<string, unknown>): { rendered: Record<string, unknown>; servedSlug: string } {
		const slug = typeof body.model === "string" ? body.model : "";
		const { modelId, model } = modelInfo(e, slug);
		const opts: AnthropicBodyOptions = { modelId, supportsReasoning: model?.supportsReasoning ?? false };
		if (model?.maxCompletionTokens !== undefined) opts.maxCompletionTokens = model.maxCompletionTokens;
		const rendered = toAnthropicBody(body, opts);
		return { rendered: e.auth === "oauth-bearer" ? withClaudeCodeIdentity(rendered) : rendered, servedSlug: `${id}/${modelId}` };
	}
	function composeSignal(e: UpstreamEntry, caller: AbortSignal | undefined): AbortSignal | null {
		const timeout = e.timeoutMs > 0 ? AbortSignal.timeout(e.timeoutMs) : null;
		if (caller && timeout) return AbortSignal.any([caller, timeout]);
		return caller ?? timeout;
	}
	async function post(e: UpstreamEntry, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": ANTHROPIC_VERSION, ...e.headers };
		if (e.auth === "oauth-bearer") {
			// A Claude Pro/Max subscription token: Bearer auth at the first-party API, with the OAuth beta. No per-token cost is reported.
			headers["authorization"] = `Bearer ${e.apiKey}`;
			headers["anthropic-beta"] = e.headers["anthropic-beta"] ?? "oauth-2025-04-20,claude-code-20250219";
		} else if (e.apiKey !== "") headers["x-api-key"] = e.apiKey;
		try {
			return await fetchImpl(`${e.baseUrl.replace(/\/+$/, "")}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body), signal: composeSignal(e, signal) });
		} catch (err) {
			throw transportError(id, err);
		}
	}
	async function httpError(res: Response): Promise<UpstreamError> {
		let body: unknown = null;
		try {
			body = await res.json();
		} catch {
			/* status alone */
		}
		const err = classifyAnthropicStatus(id, res.status, body);
		if (err.kind === "rate_limit" || res.status === 529) breaker.trip(err);
		return err;
	}

	return {
		id,
		available: breaker.available,
		cooldownUntilMs: breaker.cooldownUntilMs,
		lastTrip: breaker.lastTrip,

		async dispatch(opts: DispatchOptions): Promise<Dispatch> {
			const e = entry();
			const { rendered, servedSlug } = render(e, { ...opts.body, stream: true });
			const res = await post(e, rendered, opts.signal);
			if (!res.ok) throw await httpError(res);
			if (!res.body) throw new UpstreamError("upstream_error", res.status, "response had no body", true);
			const translator = createAnthropicTranslator(servedSlug);
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
			const frames = readSseFrames(res.body);
			const chunks = (async function* (): AsyncGenerator<UpstreamChunk> {
				try {
					for await (const frame of frames) {
						const c = translator.push(frame);
						if (c === null) continue;
						if (!idResolved && translator.generationId() !== null) resolveOnce(translator.generationId());
						yield c;
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
			const { rendered } = render(e, { ...body, stream: false });
			const res = await post(e, rendered, signal);
			if (!res.ok) throw await httpError(res);
			const json = asRec(await res.json());
			const content = Array.isArray(json?.content) ? json.content : [];
			const text = content.map((b) => (asRec(b)?.type === "text" && typeof asRec(b)?.text === "string" ? (asRec(b)!.text as string) : "")).join("");
			return { text, costUsd: null, toolCalls: anthropicToolCalls(json) };
		},

		async fetchModels(): Promise<unknown[]> {
			return [];
		},
		async fetchModelsForUser(): Promise<unknown[]> {
			return [];
		},
	};
}
