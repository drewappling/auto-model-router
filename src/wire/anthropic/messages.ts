/**
 * Anthropic Messages API front end (`POST /v1/messages`), the wire Claude Code
 * speaks. Two halves, like the Responses wire:
 *
 *  - Request: a Messages body is translated into the chat-completions shape
 *    the rest of the router understands, then parsed by the existing parser.
 *    `system` (string or text blocks) becomes the system message; content
 *    blocks become chat parts (`tool_use` → an assistant tool call,
 *    `tool_result` → a tool message, `image` → an image part); custom tools
 *    become chat tools; `tool_choice`, `stop_sequences`, `thinking` and
 *    `output_config.effort` map to their chat equivalents. Server-side tools
 *    (web search, code execution) and Anthropic-schema client tools have no
 *    upstream meaning and are dropped; replayed `thinking` blocks are dropped
 *    (the router's thinking blocks carry no signature, so nothing is lost).
 *    Client `cache_control` markers are dropped too: the router plans cache
 *    breakpoints itself and Anthropic allows four.
 *  - Response: the upstream chat stream is re-rendered as Messages SSE events
 *    (message_start … message_stop) with text, tool_use and thinking blocks,
 *    or, for non-streaming callers, one Message object. The routing summary
 *    rides on `message_delta` as `x_auto_model_router`, as the other wires do.
 *
 * Model names: Claude Code asks for `claude-*` models. A glob table maps them
 * to router profiles (haiku → the cheap profile, everything else → `auto`);
 * profile names pass through, so `auto-max` still means what it means.
 */

import { encoder, sseDataFrame } from "../../util/sse.ts";
import type { Ledger } from "../../cost/types.ts";
import { estimateTokens } from "../../tokens/estimate.ts";
import type { NormRequest, ResponseSink, TurnSummary, UpstreamChunk, WireError } from "../types.ts";
import { invalidRequest, WireErrorException } from "../openai/errors.ts";
import { parseChatRequest } from "../openai/request.ts";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------
// Model names
// ---------------------------------------------------------------------------

/** Order matters: the first glob that matches wins. */
export const DEFAULT_ANTHROPIC_MODELS: Record<string, string> = { "*haiku*": "auto-cheap", "claude-*": "auto" };

function globMatch(glob: string, s: string): boolean {
	const re = new RegExp(`^${glob.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
	return re.test(s);
}

/** The router profile a Messages `model` means; unmatched names pass through (they may be profile ids). */
export function mapAnthropicModel(model: string, models: Record<string, string> = DEFAULT_ANTHROPIC_MODELS): string {
	for (const [glob, target] of Object.entries(models)) if (globMatch(glob, model)) return target;
	return model;
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

function textBlocks(v: unknown): string {
	if (typeof v === "string") return v;
	if (!Array.isArray(v)) return "";
	return v
		.filter(isRec)
		.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : b.type === "image" ? "[image]" : b.type === "document" ? "[document]" : ""))
		.filter((t) => t !== "")
		.join("\n");
}

function imagePart(block: Rec): Rec | null {
	const src = block.source;
	if (!isRec(src)) return null;
	if (src.type === "base64" && typeof src.data === "string") return { type: "image_url", image_url: { url: `data:${typeof src.media_type === "string" ? src.media_type : "image/png"};base64,${src.data}` } };
	if (src.type === "url" && typeof src.url === "string") return { type: "image_url", image_url: { url: src.url } };
	return null;
}

/** One Messages message → one or more chat messages (tool results become tool messages, first). */
function translateMessage(raw: unknown, index: number): Rec[] {
	if (!isRec(raw)) throw invalidRequest(`messages[${index}] must be an object`);
	const role = raw.role;
	// Claude Code 2.1 also places system-role messages inside `messages`.
	if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") throw invalidRequest(`messages[${index}].role must be user, assistant or system`);
	const content = raw.content;
	if (role === "system" || role === "developer") return [{ role: "system", content: typeof content === "string" ? content : textBlocks(content) }];
	if (typeof content === "string") return [{ role, content }];
	if (!Array.isArray(content)) throw invalidRequest(`messages[${index}].content must be a string or an array of content blocks`);

	if (role === "user") {
		const toolMessages: Rec[] = [];
		const parts: Rec[] = [];
		for (const block of content) {
			if (!isRec(block)) continue;
			switch (block.type) {
				case "tool_result": {
					const body = textBlocks(block.content);
					toolMessages.push({ role: "tool", tool_call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "", content: block.is_error === true ? `[tool error] ${body}` : body });
					break;
				}
				case "text":
					if (typeof block.text === "string") parts.push({ type: "text", text: block.text });
					break;
				case "image": {
					const p = imagePart(block);
					if (p !== null) parts.push(p);
					break;
				}
				case "document":
					parts.push({ type: "text", text: typeof block.title === "string" ? `[document: ${block.title}]` : "[document]" });
					break;
				default:
					break;
			}
		}
		const out = [...toolMessages];
		if (parts.length > 0) out.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => p.text as string).join("\n") : parts });
		if (out.length === 0) out.push({ role: "user", content: "" });
		return out;
	}

	const texts: string[] = [];
	const toolCalls: Rec[] = [];
	for (const block of content) {
		if (!isRec(block)) continue;
		if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
		else if (block.type === "tool_use") {
			toolCalls.push({ id: typeof block.id === "string" ? block.id : `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`, type: "function", function: { name: typeof block.name === "string" ? block.name : "", arguments: JSON.stringify(isRec(block.input) ? block.input : {}) } });
		}
		// thinking / redacted_thinking: dropped on replay.
	}
	const text = texts.join("\n");
	return [{ role: "assistant", content: text === "" ? null : text, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }];
}

const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

/** The chat-completions body a Messages request means. */
export function messagesToChatBody(body: unknown, models: Record<string, string> = DEFAULT_ANTHROPIC_MODELS): Rec {
	if (!isRec(body)) throw invalidRequest("Request body must be a JSON object");
	if (typeof body.model !== "string" || body.model === "") throw invalidRequest("model must be a non-empty string");
	if (!Array.isArray(body.messages) || body.messages.length === 0) throw invalidRequest("messages must be a non-empty array");
	const out: Rec = { model: mapAnthropicModel(body.model, models) };

	const messages: Rec[] = [];
	const system = typeof body.system === "string" ? body.system : textBlocks(body.system);
	if (system !== "") messages.push({ role: "system", content: system });
	body.messages.forEach((m, i) => messages.push(...translateMessage(m, i)));
	out.messages = messages;

	if (Array.isArray(body.tools)) {
		const tools: Rec[] = [];
		for (const t of body.tools) {
			if (!isRec(t) || typeof t.name !== "string") continue;
			// Anything with a versioned type is a server tool or an Anthropic-schema client tool: nothing upstream can serve it.
			if (typeof t.type === "string" && t.type !== "custom") continue;
			tools.push({ type: "function", function: { name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), parameters: isRec(t.input_schema) ? t.input_schema : { type: "object", properties: {} } } });
		}
		if (tools.length > 0) out.tools = tools;
	}
	const tc = body.tool_choice;
	if (isRec(tc) && out.tools !== undefined) {
		if (tc.type === "auto") out.tool_choice = "auto";
		else if (tc.type === "any") out.tool_choice = "required";
		else if (tc.type === "none") out.tool_choice = "none";
		else if (tc.type === "tool" && typeof tc.name === "string") out.tool_choice = { type: "function", function: { name: tc.name } };
		if (tc.disable_parallel_tool_use === true) out.parallel_tool_calls = false;
	}

	if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
	if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences.filter((s) => typeof s === "string");
	for (const k of ["temperature", "top_p", "top_k"]) if (typeof body[k] === "number") out[k] = body[k];

	const th = body.thinking;
	if (isRec(th)) {
		if (th.type === "enabled") {
			const budget = typeof th.budget_tokens === "number" ? th.budget_tokens : 0;
			out.reasoning = { effort: budget <= 2048 ? "low" : budget <= 8192 ? "medium" : "high" };
		} else if (th.type === "adaptive") out.reasoning = { effort: "medium" };
		else if (th.type === "disabled") out.reasoning = { enabled: false };
	}
	const oc = body.output_config;
	if (isRec(oc) && typeof oc.effort === "string" && EFFORTS.has(oc.effort)) out.reasoning = { effort: oc.effort };

	out.stream = body.stream === true;
	return out;
}

/** The session id inside `metadata.user_id`: Claude Code 2.1 sends JSON with `session_id`; older builds `…_session_<uuid>`. */
export function sessionFromUserId(userId: string): string | null {
	try {
		const parsed: unknown = JSON.parse(userId);
		if (isRec(parsed) && typeof parsed.session_id === "string" && parsed.session_id !== "") return parsed.session_id;
	} catch {
		/* not JSON */
	}
	const m = /session(?:_id)?["']?\s*[:=_]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(userId);
	return m === null ? null : m[1]!;
}

/**
 * Claude Code carries no router headers, so identity is derived: the harness
 * from its user agent (`claude-cli/…` ⇒ `claude-code`), the session from the
 * `metadata.user_id` it sends. Explicit headers win.
 */
export function anthropicIdentityHeaders(body: unknown, headers: Headers): Headers {
	const h = new Headers(headers);
	if ((h.get("x-omp-harness") ?? "").trim() === "") h.set("x-omp-harness", /claude-cli/i.test(h.get("user-agent") ?? "") ? "claude-code" : "anthropic");
	if ((h.get("x-omp-session") ?? "").trim() === "" && isRec(body) && isRec(body.metadata) && typeof body.metadata.user_id === "string") {
		const session = sessionFromUserId(body.metadata.user_id);
		if (session !== null) h.set("x-omp-session", session);
	}
	return h;
}

export function parseMessagesRequest(body: unknown, headers: Headers, models: Record<string, string> = DEFAULT_ANTHROPIC_MODELS): NormRequest {
	const norm = parseChatRequest(messagesToChatBody(body, models), anthropicIdentityHeaders(body, headers));
	return { ...norm, protocol: "anthropic-messages" };
}

/** `POST /v1/messages/count_tokens`: the router's own estimate over the prompt bytes. */
export function countAnthropicTokens(body: unknown, models: Record<string, string>, ledger: Ledger | null): number {
	const norm = parseChatRequest(messagesToChatBody({ ...(isRec(body) ? body : {}), stream: false }, models), new Headers());
	return estimateTokens(norm.promptBytes, "anthropic", ledger);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function anthropicErrorType(status: number): string {
	if (status === 400) return "invalid_request_error";
	if (status === 401) return "authentication_error";
	if (status === 403) return "permission_error";
	if (status === 404) return "not_found_error";
	if (status === 429) return "rate_limit_error";
	if (status === 529) return "overloaded_error";
	return status >= 500 ? "api_error" : "invalid_request_error";
}

/** The Anthropic error envelope. */
export function renderAnthropicError(err: WireError): Rec {
	return { type: "error", error: { type: anthropicErrorType(err.status), message: err.message, code: err.code } };
}

export function anthropicErrorResponse(err: WireError): Response {
	return new Response(JSON.stringify(renderAnthropicError(err)), { status: err.status, headers: { "content-type": "application/json" } });
}

export { WireErrorException };

// ---------------------------------------------------------------------------
// Response rendering
// ---------------------------------------------------------------------------

type Block = { type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "tool_use"; id: string; name: string; args: string };

function summaryFields(summary: TurnSummary): Rec {
	return { model: summary.servedSlug, tier: summary.tier, cost_usd: summary.reportedUsd ?? summary.predictedUsd, attempts: summary.attempts };
}

/** Anthropic counts cache reads and writes outside `input_tokens`; OpenAI-style prompt tokens include them. */
function usageJson(summary: TurnSummary): Rec {
	const u = summary.usage;
	return {
		input_tokens: Math.max(0, u.promptTokens - u.cachedTokens - u.cacheWriteTokens),
		cache_read_input_tokens: u.cachedTokens,
		cache_creation_input_tokens: u.cacheWriteTokens,
		output_tokens: u.completionTokens,
	};
}

function blockJson(b: Block): Rec {
	if (b.type === "text") return { type: "text", text: b.text };
	if (b.type === "thinking") return { type: "thinking", thinking: b.thinking };
	let input: unknown = {};
	try {
		const parsed: unknown = b.args === "" ? {} : JSON.parse(b.args);
		input = isRec(parsed) ? parsed : {};
	} catch {
		input = {};
	}
	return { type: "tool_use", id: b.id, name: b.name, input };
}

const STOP: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", content_filter: "end_turn", error: "end_turn" };

/**
 * Turns the upstream chat stream into Messages content blocks, emitting the
 * standard event sequence through `emit`. Shared by the streaming and the
 * buffered sink; the buffered one simply ignores the events.
 */
class MessageBuilder {
	readonly id = `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
	readonly blocks: Block[] = [];
	private started = false;
	private open: number | null = null;
	private stopReason: string | null = null;
	private readonly toolBlockByIndex = new Map<number, number>();

	constructor(
		private readonly model: string,
		private readonly emit: (type: string, payload: Rec) => void,
	) {}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.emit("message_start", { type: "message_start", message: { id: this.id, type: "message", role: "assistant", content: [], model: this.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
		this.emit("ping", { type: "ping" });
	}

	private closeOpen(): void {
		if (this.open === null) return;
		this.emit("content_block_stop", { type: "content_block_stop", index: this.open });
		this.open = null;
	}

	private openBlock(block: Block): number {
		this.closeOpen();
		this.blocks.push(block);
		const index = this.blocks.length - 1;
		this.open = index;
		const start = block.type === "tool_use" ? { type: "tool_use", id: block.id, name: block.name, input: {} } : block.type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
		this.emit("content_block_start", { type: "content_block_start", index, content_block: start });
		return index;
	}

	private current(type: "text" | "thinking"): { index: number; block: Block } {
		if (this.open !== null) {
			const open = this.blocks[this.open];
			if (open !== undefined && open.type === type) return { index: this.open, block: open };
		}
		const block: Block = type === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" };
		return { index: this.openBlock(block), block };
	}

	chunk(chunk: UpstreamChunk): void {
		for (const ev of chunk.events) {
			if (ev.type === "start") this.start();
			else if (ev.type === "text") {
				if (ev.delta === "") continue;
				this.start();
				const { index, block } = this.current("text");
				if (block.type === "text") block.text += ev.delta;
				this.emit("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: ev.delta } });
			} else if (ev.type === "reasoning") {
				if (ev.delta === "") continue;
				this.start();
				const { index, block } = this.current("thinking");
				if (block.type === "thinking") block.thinking += ev.delta;
				this.emit("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: ev.delta } });
			} else if (ev.type === "tool_call") {
				this.start();
				let index = this.toolBlockByIndex.get(ev.index);
				if (index === undefined) {
					index = this.openBlock({ type: "tool_use", id: ev.id ?? `toolu_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`, name: ev.name ?? "", args: "" });
					this.toolBlockByIndex.set(ev.index, index);
				}
				const block = this.blocks[index];
				if (block === undefined || block.type !== "tool_use") continue;
				if (ev.name !== undefined && block.name === "") block.name = ev.name;
				if (ev.argsDelta !== undefined && ev.argsDelta !== "") {
					block.args += ev.argsDelta;
					this.emit("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: ev.argsDelta } });
				}
			} else if (ev.type === "finish") {
				this.stopReason = STOP[ev.reason] ?? "end_turn";
				this.closeOpen();
			}
			// usage: carried by the summary.
		}
	}

	private stop(): string {
		return this.stopReason ?? (this.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
	}

	message(summary: TurnSummary): Rec {
		return { id: this.id, type: "message", role: "assistant", model: this.model, content: this.blocks.map(blockJson), stop_reason: this.stop(), stop_sequence: null, usage: usageJson(summary), x_auto_model_router: summaryFields(summary) };
	}

	finish(summary: TurnSummary): Rec {
		this.start();
		this.closeOpen();
		this.emit("message_delta", { type: "message_delta", delta: { stop_reason: this.stop(), stop_sequence: null }, usage: usageJson(summary), x_auto_model_router: summaryFields(summary) });
		this.emit("message_stop", { type: "message_stop" });
		return this.message(summary);
	}

	fail(error: WireError): void {
		this.emit("error", renderAnthropicError(error));
	}
}

export function createMessagesStreamingSink(virtualModel: string): { sink: ResponseSink; response: Response } {
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let closed = false;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const send = (text: string): void => {
		if (closed) return;
		try {
			controller?.enqueue(encoder.encode(text));
		} catch {
			closed = true;
		}
	};
	const close = (): void => {
		if (closed) return;
		closed = true;
		try {
			controller?.close();
		} catch {
			// Already closed by the runtime.
		}
	};
	const builder = new MessageBuilder(virtualModel, (type, payload) => send(`event: ${type}\n${sseDataFrame(payload)}`));
	const sink: ResponseSink = {
		chunk(chunk) {
			builder.chunk(chunk);
		},
		error(error) {
			builder.fail(error);
			close();
		},
		finish(summary) {
			builder.finish(summary);
			close();
		},
	};
	return { sink, response: new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } }) };
}

export function createMessagesBufferedSink(virtualModel: string): { sink: ResponseSink; response: Promise<Response> } {
	let resolve!: (r: Response) => void;
	const response = new Promise<Response>((r) => {
		resolve = r;
	});
	let settled = false;
	const builder = new MessageBuilder(virtualModel, () => {});
	const sink: ResponseSink = {
		chunk(chunk) {
			builder.chunk(chunk);
		},
		error(error) {
			if (settled) return;
			settled = true;
			resolve(anthropicErrorResponse(error));
		},
		finish(summary) {
			if (settled) return;
			settled = true;
			const f = summaryFields(summary);
			resolve(
				new Response(JSON.stringify(builder.finish(summary)), {
					status: 200,
					headers: {
						"content-type": "application/json",
						"x-auto-model-router-model": String(f.model),
						"x-auto-model-router-tier": String(f.tier),
						"x-auto-model-router-cost-usd": String(f.cost_usd),
						"x-auto-model-router-attempts": String(f.attempts),
					},
				}),
			);
		},
	};
	return { sink, response };
}

/** The wire's `model` for the client: the name it asked for, so its own bookkeeping matches. */
export function createMessagesWire(models: Record<string, string>): {
	parse(body: unknown, headers: Headers): NormRequest;
	streaming(model: string): { sink: ResponseSink; response: Response };
	buffered(model: string): { sink: ResponseSink; response: Promise<Response> };
	error(err: WireError): Response;
} {
	return { parse: (body, headers) => parseMessagesRequest(body, headers, models), streaming: createMessagesStreamingSink, buffered: createMessagesBufferedSink, error: anthropicErrorResponse };
}
