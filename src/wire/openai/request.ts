import type {
	NormMessage,
	NormRequest,
	NormTool,
	NormToolCall,
	ReasoningLevel,
	Role,
	UpstreamMutations,
} from "../types.ts";
import { conversationKeyOf } from "../../util/hash.ts";
import { invalidRequest, modelNotFound } from "./errors.ts";

const ROLES: Record<string, true> = { system: true, developer: true, user: true, assistant: true, tool: true };

const REASONING_LEVELS: Record<string, true> = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true,
};

/**
 * UTF-8 byte length without allocating an encoded copy. Lone surrogates count
 * as 3 bytes, matching TextEncoder's U+FFFD replacement.
 */
function utf8Bytes(s: string): number {
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		if (c < 0x80) n += 1;
		else if (c < 0x800) n += 2;
		else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			n += 4;
			i++;
		} else n += 3;
	}
	return n;
}

function normalizeMessage(raw: unknown, index: number): NormMessage {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw invalidRequest(`messages[${index}] must be an object`);
	}
	const m = raw as {
		role?: unknown;
		content?: unknown;
		tool_calls?: unknown;
		tool_call_id?: unknown;
		name?: unknown;
	};
	if (typeof m.role !== "string" || !(m.role in ROLES)) {
		throw invalidRequest(`messages[${index}].role must be one of: system, developer, user, assistant, tool`);
	}

	// Flatten content into lossy text plus an image count. The flattened view
	// feeds classification only; dispatch bytes come from renderUpstreamBody.
	let text = "";
	let images = 0;
	if (typeof m.content === "string") {
		text = m.content;
	} else if (Array.isArray(m.content)) {
		const parts: string[] = [];
		for (const part of m.content) {
			if (typeof part !== "object" || part === null) continue;
			const p = part as { type?: unknown; text?: unknown };
			if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
			else if (p.type === "image_url") images++;
		}
		text = parts.join("\n");
	} else if (m.content !== null && m.content !== undefined) {
		throw invalidRequest(`messages[${index}].content must be a string or a content-part array`);
	}

	const toolCalls: NormToolCall[] = [];
	if (Array.isArray(m.tool_calls)) {
		for (const tc of m.tool_calls) {
			if (typeof tc !== "object" || tc === null) continue;
			const t = tc as { id?: unknown; function?: unknown };
			const fn =
				typeof t.function === "object" && t.function !== null
					? (t.function as { name?: unknown; arguments?: unknown })
					: {};
			toolCalls.push({
				id: typeof t.id === "string" ? t.id : "",
				name: typeof fn.name === "string" ? fn.name : "",
				argsJson: typeof fn.arguments === "string" ? fn.arguments : "",
			});
		}
	}

	const msg: NormMessage = {
		role: m.role as Role,
		text,
		images,
		textBytes: utf8Bytes(text),
		toolCalls,
	};
	if (m.role === "tool") {
		if (typeof m.tool_call_id === "string") msg.toolCallId = m.tool_call_id;
		if (typeof m.name === "string") msg.toolName = m.name;
	}
	return msg;
}

function normalizeTools(raw: unknown): NormTool[] {
	if (!Array.isArray(raw)) return [];
	const tools: NormTool[] = [];
	for (const t of raw) {
		if (typeof t !== "object" || t === null) continue;
		const fn = (t as { function?: unknown }).function;
		if (typeof fn !== "object" || fn === null) continue;
		const f = fn as { name?: unknown; description?: unknown; parameters?: unknown };
		tools.push({
			name: typeof f.name === "string" ? f.name : "",
			description: typeof f.description === "string" ? f.description : "",
			schemaBytes: utf8Bytes(JSON.stringify(f.parameters ?? {})),
		});
	}
	return tools;
}

function parseReasoning(b: { reasoning?: unknown; reasoning_effort?: unknown }): ReasoningLevel | undefined {
	// The OpenRouter-style object wins over the OpenAI-style flat field: it is
	// the spelling we emit upstream, so it is the client's clearest intent.
	if (typeof b.reasoning === "object" && b.reasoning !== null) {
		const r = b.reasoning as { effort?: unknown; enabled?: unknown };
		if (typeof r.effort === "string" && r.effort in REASONING_LEVELS) return r.effort as ReasoningLevel;
		if (r.enabled === false) return "off";
	}
	if (typeof b.reasoning_effort === "string" && b.reasoning_effort in REASONING_LEVELS) {
		return b.reasoning_effort as ReasoningLevel;
	}
	return undefined;
}

function renderUpstreamBody(
	original: Record<string, unknown>,
	m: UpstreamMutations,
): Record<string, unknown> {
	// Deep clone: an escalation retry renders the same original again for a
	// different model, so a render must never touch the stored body.
	const body = structuredClone(original);
	body.model = m.slug;
	if (m.fallbacks.length > 0) body.models = [m.slug, ...m.fallbacks];
	body.session_id = m.sessionId;
	// The guard always consumes a stream; the sink re-buffers for non-streaming clients.
	body.stream = true;
	// OpenRouter returns usage unconditionally and the parameter is deprecated.
	delete body.stream_options;

	if (m.maxTokens !== undefined) {
		// Respect whichever max-token spelling the client used.
		if ("max_completion_tokens" in body) body.max_completion_tokens = m.maxTokens;
		else body.max_tokens = m.maxTokens;
	}

	// Normalize to the OpenRouter spelling; the two fields must never coexist.
	delete body.reasoning_effort;
	if (m.reasoning === undefined) delete body.reasoning;
	else if (m.reasoning === "off") body.reasoning = { enabled: false };
	else body.reasoning = { effort: m.reasoning };

	// messages was validated to be an array of objects at parse time.
	const messages = body.messages as Record<string, unknown>[];
	if (m.stripAssistantReasoning) {
		// omp replays reasoning fields for what it believes is a local backend;
		// most OpenRouter upstreams reject every spelling.
		for (const msg of messages) {
			if (msg.role !== "assistant") continue;
			delete msg.reasoning;
			delete msg.reasoning_content;
			delete msg.reasoning_details;
		}
	}
	for (const idx of m.cacheBreakpointMessageIndices) {
		const msg = messages[idx];
		if (!msg) continue;
		const content = msg.content;
		if (typeof content === "string") {
			msg.content = [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
		} else if (Array.isArray(content)) {
			for (let i = content.length - 1; i >= 0; i--) {
				const part = content[i] as { type?: unknown; cache_control?: unknown } | undefined;
				if (part && typeof part === "object" && part.type === "text") {
					part.cache_control = { type: "ephemeral" };
					break;
				}
			}
		}
	}
	return body;
}

export function parseChatRequest(body: unknown, headers: Headers): NormRequest {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw invalidRequest("Request body must be a JSON object");
	}
	const b = body as Record<string, unknown>;

	// Harness identity for per-harness budgets and toast scoping. omp sends
	// this via the provider block's `headers:` override; absent ⇒ single harness.
	const harnessId = (headers.get("x-omp-harness") ?? "").trim();

	// omp UI session id for per-session toast scoping. The embed extension sets
	// this header to ctx.sessionManager.getSessionId(); absent ⇒ unknown session.
	const ompSessionId = (headers.get("x-omp-session") ?? "").trim();

	if (typeof b.model !== "string" || b.model.length === 0) {
		throw invalidRequest("model must be a non-empty string");
	}
	// Strip any provider prefix so `auto` and `auto-model-router/auto` both resolve to
	// the profile id.
	const requestedModel = b.model.slice(b.model.lastIndexOf("/") + 1);
	if (requestedModel.length === 0) throw modelNotFound(b.model);

	if (!Array.isArray(b.messages) || b.messages.length === 0) {
		throw invalidRequest("messages must be a non-empty array");
	}
	const messages = b.messages.map((msg, i) => normalizeMessage(msg, i));
	const tools = normalizeTools(b.tools);

	const tc = b.tool_choice;
	const forcedToolChoice =
		tc !== null &&
		tc !== undefined &&
		(typeof tc === "object" || (typeof tc === "string" && tc !== "auto" && tc !== "none"));

	let promptBytes = 0;
	for (const msg of messages) promptBytes += msg.textBytes;
	for (const t of tools) promptBytes += t.schemaBytes + utf8Bytes(t.name) + utf8Bytes(t.description);

	let hasImages = false;
	for (const msg of messages) {
		if (msg.images > 0) {
			hasImages = true;
			break;
		}
	}

	// Conversation identity: the leading system/developer run plus the first
	// message after it, matching how OpenRouter fingerprints conversations.
	const systemParts: string[] = [];
	let firstNonSystemText = "";
	for (const msg of messages) {
		if (msg.role === "system" || msg.role === "developer") systemParts.push(msg.text);
		else {
			firstNonSystemText = msg.text;
			break;
		}
	}
	const conversationKey = conversationKeyOf(systemParts.join("\n"), firstNonSystemText);

	const maxTokens =
		typeof b.max_completion_tokens === "number"
			? b.max_completion_tokens
			: typeof b.max_tokens === "number"
				? b.max_tokens
				: undefined;
	const temperature = typeof b.temperature === "number" ? b.temperature : undefined;
	const reasoning = parseReasoning(b);

	return {
		protocol: "openai-chat",
		conversationKey,
		harnessId,
		ompSessionId,
		requestedModel,
		messages,
		tools,
		forcedToolChoice,
		stream: b.stream === true,
		hasImages,
		promptBytes,
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(temperature !== undefined ? { temperature } : {}),
		...(reasoning !== undefined ? { reasoning } : {}),
		renderUpstreamBody(m: UpstreamMutations): Record<string, unknown> {
			return renderUpstreamBody(b, m);
		},
	};
}
