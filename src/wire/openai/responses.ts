/**
 * OpenAI Responses API front end (`POST /v1/responses`), the wire Codex CLI
 * speaks (it dropped chat completions in 0.150). Two halves:
 *
 *  - Request: a Responses body is translated into the chat-completions shape
 *    the rest of the router already understands, then parsed by the existing
 *    parser. `instructions` becomes the system message, `input` items become
 *    messages (function_call → an assistant tool call, function_call_output →
 *    a tool message), flat function tools become chat tools. Fields that only
 *    mean something to OpenAI's stateful store are dropped.
 *  - Response: the upstream chat stream is re-rendered as Responses SSE
 *    events (response.created … response.completed) or, for non-streaming
 *    callers, one Response object. The routing summary rides on the final
 *    event as `x_auto_model_router`, as the chat wire does.
 *
 * Stateless only: `previous_response_id` is rejected, because the router keeps
 * no response store. Codex sends `store: false` and the full input each turn.
 */

import { encoder, sseDataFrame } from "../../util/sse.ts";
import type { NormRequest, ResponseSink, TurnSummary, UpstreamChunk, WireError } from "../types.ts";
import { invalidRequest, renderErrorEnvelope } from "./errors.ts";
import { parseChatRequest } from "./request.ts";

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

/** Responses-only fields with no chat-completions meaning; never forwarded. */
export const RESPONSES_ONLY_PARAMS: readonly string[] = ["instructions", "input", "include", "store", "prompt_cache_key", "client_metadata", "text", "truncation", "metadata", "previous_response_id", "max_output_tokens", "max_tool_calls", "background", "conversation", "safety_identifier", "service_tier"];

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

/** One Responses content part → one chat content part (text or image). */
function contentPart(part: unknown): Rec | null {
	if (typeof part === "string") return { type: "text", text: part };
	if (!isRec(part)) return null;
	const type = typeof part.type === "string" ? part.type : "";
	if (type === "input_text" || type === "output_text" || type === "text") return { type: "text", text: typeof part.text === "string" ? part.text : "" };
	if (type === "input_image") {
		const url = typeof part.image_url === "string" ? part.image_url : isRec(part.image_url) && typeof part.image_url.url === "string" ? part.image_url.url : "";
		return url === "" ? null : { type: "image_url", image_url: { url } };
	}
	if (type === "refusal") return { type: "text", text: typeof part.refusal === "string" ? part.refusal : "" };
	// input_file and unknown parts: keep a placeholder so the turn still classifies.
	return { type: "text", text: `[${type || "unknown"} part]` };
}

function messageContent(raw: unknown): string | Rec[] {
	if (typeof raw === "string") return raw;
	if (!Array.isArray(raw)) return "";
	const parts = raw.map(contentPart).filter((p): p is Rec => p !== null);
	// A pure-text message is cheaper to carry as a string.
	if (parts.every((p) => p.type === "text")) return parts.map((p) => p.text as string).join("");
	return parts;
}

function outputText(raw: unknown): string {
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw)) return raw.map((p) => (typeof p === "string" ? p : isRec(p) && typeof p.text === "string" ? p.text : "")).join("");
	if (isRec(raw)) return JSON.stringify(raw);
	return "";
}

/** Translates a Responses body into the chat-completions shape; throws WireErrorException on a malformed body. */
export function responsesToChatBody(body: unknown): Rec {
	if (!isRec(body)) throw invalidRequest("Request body must be a JSON object");
	if (typeof body.previous_response_id === "string" && body.previous_response_id !== "") {
		throw invalidRequest("previous_response_id is not supported: the router keeps no response store; send the full input (Codex does with store=false)");
	}
	const messages: Rec[] = [];
	if (typeof body.instructions === "string" && body.instructions !== "") messages.push({ role: "system", content: body.instructions });

	const input = body.input;
	if (typeof input === "string") messages.push({ role: "user", content: input });
	else if (Array.isArray(input)) {
		for (const item of input) {
			if (!isRec(item)) continue;
			const type = typeof item.type === "string" ? item.type : typeof item.role === "string" ? "message" : "";
			if (type === "message") {
				const role = typeof item.role === "string" ? item.role : "user";
				messages.push({ role, content: messageContent(item.content) });
			} else if (type === "function_call") {
				const call = {
					id: typeof item.call_id === "string" ? item.call_id : typeof item.id === "string" ? item.id : `call_${messages.length}`,
					type: "function",
					function: { name: typeof item.name === "string" ? item.name : "", arguments: typeof item.arguments === "string" ? item.arguments : "{}" },
				};
				// Parallel calls arrive as consecutive items; they belong to one assistant message.
				const last = messages[messages.length - 1];
				if (last !== undefined && last.role === "assistant" && Array.isArray(last.tool_calls)) (last.tool_calls as Rec[]).push(call);
				else messages.push({ role: "assistant", content: null, tool_calls: [call] });
			} else if (type === "function_call_output") {
				messages.push({ role: "tool", tool_call_id: typeof item.call_id === "string" ? item.call_id : "", content: outputText(item.output) });
			}
			// reasoning, item references, built-in tool calls: nothing the upstream can use.
		}
	} else if (input !== undefined) throw invalidRequest("input must be a string or an array of items");
	if (messages.length === 0) throw invalidRequest("input must contain at least one message");

	const tools: Rec[] = [];
	if (Array.isArray(body.tools)) {
		for (const t of body.tools) {
			if (!isRec(t) || t.type !== "function" || typeof t.name !== "string") continue;
			tools.push({ type: "function", function: { name: t.name, ...(typeof t.description === "string" ? { description: t.description } : {}), ...(isRec(t.parameters) ? { parameters: t.parameters } : {}) } });
		}
	}

	const out: Rec = {};
	for (const [k, v] of Object.entries(body)) {
		if (RESPONSES_ONLY_PARAMS.includes(k) || k === "tools" || k === "tool_choice" || k === "reasoning") continue;
		out[k] = v;
	}
	out.messages = messages;
	if (tools.length > 0) out.tools = tools;
	const tc = body.tool_choice;
	if (isRec(tc) && tc.type === "function" && typeof tc.name === "string") out.tool_choice = { type: "function", function: { name: tc.name } };
	else if (typeof tc === "string") out.tool_choice = tc;
	if (typeof body.max_output_tokens === "number") out.max_tokens = body.max_output_tokens;
	if (isRec(body.reasoning) && typeof body.reasoning.effort === "string") out.reasoning = { effort: body.reasoning.effort };
	out.stream = body.stream === true;
	return out;
}

/**
 * Codex carries its identity in the body, not in headers: the thread id under
 * `client_metadata` (also the `prompt_cache_key`), and the agent name inside
 * the JSON-encoded `x-codex-turn-metadata` (`/root` is the main agent). When
 * the caller sent no X-Omp-Session / X-Omp-Subagent header, they are derived
 * from those, so Codex gets per-session reports, feedback and the subagent
 * profile without a plugin.
 */
export function identityHeadersFromBody(body: unknown, headers: Headers): Headers {
	if (!isRec(body)) return headers;
	const h = new Headers(headers);
	const cm = isRec(body.client_metadata) ? body.client_metadata : {};
	if ((h.get("x-omp-session") ?? "").trim() === "") {
		const id = [cm.thread_id, cm.session_id, body.prompt_cache_key].find((v): v is string => typeof v === "string" && v !== "");
		if (id !== undefined) h.set("x-omp-session", id);
	}
	if ((h.get("x-omp-subagent") ?? "").trim() === "" && typeof cm["x-codex-turn-metadata"] === "string") {
		try {
			const meta: unknown = JSON.parse(cm["x-codex-turn-metadata"]);
			if (isRec(meta) && typeof meta.agent_name === "string" && meta.agent_name !== "" && meta.agent_name !== "/root") h.set("x-omp-subagent", "1");
		} catch {
			// Not JSON: no subagent signal.
		}
	}
	return h;
}

export function parseResponsesRequest(body: unknown, headers: Headers): NormRequest {
	const norm = parseChatRequest(responsesToChatBody(body), identityHeadersFromBody(body, headers));
	return { ...norm, protocol: "openai-responses" };
}

// ---------------------------------------------------------------------------
// Response rendering
// ---------------------------------------------------------------------------

interface MessageItem {
	kind: "message";
	id: string;
	text: string;
	open: boolean;
}
interface CallItem {
	kind: "function_call";
	id: string;
	callId: string;
	name: string;
	args: string;
	open: boolean;
}
type Item = MessageItem | CallItem;

function summaryFields(summary: TurnSummary): Record<string, unknown> {
	return { model: summary.servedSlug, tier: summary.tier, cost_usd: summary.reportedUsd ?? summary.predictedUsd, attempts: summary.attempts };
}

function itemJson(it: Item, status: "in_progress" | "completed"): Rec {
	return it.kind === "message"
		? { id: it.id, type: "message", role: "assistant", status, content: [{ type: "output_text", text: it.text, annotations: [] }] }
		: { id: it.id, type: "function_call", call_id: it.callId, name: it.name, arguments: it.args, status };
}

function usageJson(summary: TurnSummary): Rec {
	const u = summary.usage;
	return {
		input_tokens: u.promptTokens,
		input_tokens_details: { cached_tokens: u.cachedTokens },
		output_tokens: u.completionTokens,
		output_tokens_details: { reasoning_tokens: u.reasoningTokens },
		total_tokens: u.promptTokens + u.completionTokens,
	};
}

/**
 * Turns the upstream chat stream into Responses output items, emitting the
 * standard event sequence through `emit`. Shared by the streaming and the
 * buffered sink; the buffered one simply ignores the events.
 */
class ResponseBuilder {
	readonly id = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
	readonly createdAt = Math.floor(Date.now() / 1000);
	private seq = 0;
	private started = false;
	readonly items: Item[] = [];
	private readonly callsByIndex = new Map<number, CallItem>();
	private message: MessageItem | null = null;

	constructor(
		private readonly model: string,
		private readonly emit: (type: string, payload: Rec) => void,
	) {}

	private event(type: string, payload: Rec): void {
		this.emit(type, { type, sequence_number: this.seq++, ...payload });
	}

	private response(status: string, extra: Rec = {}): Rec {
		return { id: this.id, object: "response", created_at: this.createdAt, status, model: this.model, output: this.items.map((it) => itemJson(it, "completed")), ...extra };
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		this.event("response.created", { response: this.response("in_progress") });
		this.event("response.in_progress", { response: this.response("in_progress") });
	}

	private openMessage(): MessageItem {
		if (this.message !== null && this.message.open) return this.message;
		const item: MessageItem = { kind: "message", id: `msg_${crypto.randomUUID().replaceAll("-", "")}`, text: "", open: true };
		this.items.push(item);
		this.message = item;
		const output_index = this.items.length - 1;
		this.event("response.output_item.added", { output_index, item: itemJson(item, "in_progress") });
		this.event("response.content_part.added", { item_id: item.id, output_index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
		return item;
	}

	private closeMessage(): void {
		const item = this.message;
		if (item === null || !item.open) return;
		item.open = false;
		const output_index = this.items.indexOf(item);
		this.event("response.output_text.done", { item_id: item.id, output_index, content_index: 0, text: item.text });
		this.event("response.content_part.done", { item_id: item.id, output_index, content_index: 0, part: { type: "output_text", text: item.text, annotations: [] } });
		this.event("response.output_item.done", { output_index, item: itemJson(item, "completed") });
	}

	private closeCall(item: CallItem): void {
		if (!item.open) return;
		item.open = false;
		const output_index = this.items.indexOf(item);
		this.event("response.function_call_arguments.done", { item_id: item.id, output_index, arguments: item.args });
		this.event("response.output_item.done", { output_index, item: itemJson(item, "completed") });
	}

	chunk(chunk: UpstreamChunk): void {
		for (const ev of chunk.events) {
			if (ev.type === "start") this.start();
			else if (ev.type === "text") {
				if (ev.delta === "") continue;
				this.start();
				const item = this.openMessage();
				item.text += ev.delta;
				this.event("response.output_text.delta", { item_id: item.id, output_index: this.items.indexOf(item), content_index: 0, delta: ev.delta });
			} else if (ev.type === "tool_call") {
				this.start();
				let item = this.callsByIndex.get(ev.index);
				if (item === undefined) {
					this.closeMessage();
					item = {
						kind: "function_call",
						id: `fc_${crypto.randomUUID().replaceAll("-", "")}`,
						callId: ev.id ?? `call_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
						name: ev.name ?? "",
						args: "",
						open: true,
					};
					this.callsByIndex.set(ev.index, item);
					this.items.push(item);
					this.event("response.output_item.added", { output_index: this.items.length - 1, item: itemJson(item, "in_progress") });
				} else if (ev.name !== undefined && item.name === "") item.name = ev.name;
				if (ev.argsDelta !== undefined && ev.argsDelta !== "") {
					item.args += ev.argsDelta;
					this.event("response.function_call_arguments.delta", { item_id: item.id, output_index: this.items.indexOf(item), delta: ev.argsDelta });
				}
			} else if (ev.type === "finish") {
				this.closeMessage();
				for (const c of this.callsByIndex.values()) this.closeCall(c);
			}
			// reasoning and usage: carried by the summary, not the item stream.
		}
	}

	finish(summary: TurnSummary): Rec {
		this.start();
		this.closeMessage();
		for (const c of this.callsByIndex.values()) this.closeCall(c);
		const response = this.response("completed", { usage: usageJson(summary) });
		this.event("response.completed", { response, x_auto_model_router: summaryFields(summary) });
		return { ...response, x_auto_model_router: summaryFields(summary) };
	}

	fail(error: WireError): void {
		this.event("error", { code: error.code, message: error.message });
		this.event("response.failed", { response: this.response("failed", { error: { code: error.code, message: error.message } }) });
	}
}

export function createResponsesStreamingSink(virtualModel: string): { sink: ResponseSink; response: Response } {
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
	const builder = new ResponseBuilder(virtualModel, (type, payload) => send(`event: ${type}\n${sseDataFrame(payload)}`));
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

export function createResponsesBufferedSink(virtualModel: string): { sink: ResponseSink; response: Promise<Response> } {
	let resolve!: (r: Response) => void;
	const response = new Promise<Response>((r) => {
		resolve = r;
	});
	let settled = false;
	const builder = new ResponseBuilder(virtualModel, () => {});
	const sink: ResponseSink = {
		chunk(chunk) {
			builder.chunk(chunk);
		},
		error(error) {
			if (settled) return;
			settled = true;
			resolve(new Response(JSON.stringify(renderErrorEnvelope(error)), { status: error.status, headers: { "content-type": "application/json" } }));
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
