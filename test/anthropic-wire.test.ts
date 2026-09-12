import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { EMPTY_USAGE } from "../src/cost/types.ts";
import { startServer, type StartedServer } from "../src/server/http.ts";
import { readFileSync } from "node:fs";
import { anthropicIdentityHeaders, countAnthropicTokens, sessionFromUserId, createMessagesBufferedSink, createMessagesStreamingSink, mapAnthropicModel, messagesToChatBody, parseMessagesRequest, renderAnthropicError } from "../src/wire/anthropic/messages.ts";
import type { StreamEvent, TurnSummary, UpstreamChunk, UpstreamMutations } from "../src/wire/types.ts";

/**
 * The Anthropic Messages wire Claude Code speaks: a Messages body becomes the
 * chat shape the core understands (system, tool_use/tool_result, images,
 * tools, tool_choice, thinking), the identity is derived from what Claude
 * Code sends, and the upstream stream is rendered back as Messages events or
 * one Message object, with the Anthropic error envelope on failure.
 */

const MUT: UpstreamMutations = { slug: "x/y", fallbacks: [], sessionId: "s", cacheBreakpointMessageIndices: [], reasoning: undefined, maxTokens: undefined, stripAssistantReasoning: false };

const CLAUDE_CODE_BODY = {
	model: "claude-sonnet-4-5-20250929",
	max_tokens: 32000,
	system: [
		{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } },
		{ type: "text", text: "# Environment\nWorking directory: E:/projects/x" },
	],
	messages: [
		{ role: "user", content: [{ type: "text", text: "read package.json and tell me the version" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "I should read the file.", signature: "abc" }, { type: "text", text: "Reading it." }, { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: "package.json" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: [{ type: "text", text: '{"version":"1.2.3"}' }] }, { type: "text", text: "thanks" }] },
	],
	tools: [
		{ name: "Read", description: "Reads a file", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
		{ type: "web_search_20250305", name: "web_search", max_uses: 5 },
		{ type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
	],
	tool_choice: { type: "auto", disable_parallel_tool_use: true },
	metadata: { user_id: "user_9f8e_account_a1b2c3d4-0000-4000-8000-000000000001_session_0c8d5f1e-1234-4bcd-9abc-def012345678" },
	thinking: { type: "enabled", budget_tokens: 4096 },
	stream: true,
};

describe("messagesToChatBody", () => {
	test("translates a Claude Code turn: system blocks, tool_use/tool_result, custom tools only, tool_choice, thinking budget", async () => {
		const b = messagesToChatBody(CLAUDE_CODE_BODY);
		expect(b.model).toBe("auto");
		const messages = b.messages as { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }[];
		expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
		expect(messages[0]!.content).toBe("You are Claude Code, Anthropic's official CLI for Claude.\n# Environment\nWorking directory: E:/projects/x");
		expect(messages[1]!.content).toBe("read package.json and tell me the version");
		expect(messages[2]).toEqual({ role: "assistant", content: "Reading it.", tool_calls: [{ id: "toolu_01", type: "function", function: { name: "Read", arguments: '{"file_path":"package.json"}' } }] });
		expect(messages[3]).toEqual({ role: "tool", tool_call_id: "toolu_01", content: '{"version":"1.2.3"}' });
		expect(messages[4]!.content).toBe("thanks");
		const tools = b.tools as { type: string; function: { name: string; parameters: unknown } }[];
		expect(tools.map((t) => t.function.name)).toEqual(["Read"]); // server and Anthropic-schema tools dropped
		expect(tools[0]!.function.parameters).toEqual(CLAUDE_CODE_BODY.tools[0]!.input_schema);
		expect(b.tool_choice).toBe("auto");
		expect(b.parallel_tool_calls).toBe(false);
		expect(b.max_tokens).toBe(32000);
		expect(b.reasoning).toEqual({ effort: "medium" });
		expect(b.stream).toBe(true);
		for (const k of ["system", "metadata", "thinking", "tool_choice_anthropic", "cache_control"]) expect(k in b && k !== "tool_choice").toBe(false);
	});

	test("string bodies, images, documents, error tool results, tool_choice variants, stop sequences, effort", async () => {
		const b = messagesToChatBody({
			model: "auto-max",
			system: "sys",
			max_tokens: 10,
			stop_sequences: ["END", 5],
			temperature: 0.2,
			top_k: 3,
			messages: [
				{ role: "user", content: [{ type: "text", text: "look" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: "x" } }] },
				{ role: "assistant", content: "ok" },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "boom", is_error: true }] },
			],
			tools: [{ type: "custom", name: "f", input_schema: { type: "object" } }],
			tool_choice: { type: "tool", name: "f" },
			thinking: { type: "disabled" },
			output_config: { effort: "xhigh" },
		});
		expect(b.model).toBe("auto-max"); // profile ids pass through
		const messages = b.messages as { role: string; content: unknown; tool_call_id?: string }[];
		expect(messages[0]).toEqual({ role: "system", content: "sys" });
		expect(messages[1]!.content).toEqual([{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "[document: spec.pdf]" }]);
		expect(messages[3]).toEqual({ role: "tool", tool_call_id: "t1", content: "[tool error] boom" });
		expect(b.stop).toEqual(["END"]);
		expect(b.temperature).toBe(0.2);
		expect(b.top_k).toBe(3);
		expect(b.tool_choice).toEqual({ type: "function", function: { name: "f" } });
		expect(b.reasoning).toEqual({ effort: "xhigh" }); // output_config wins over thinking
		expect(messagesToChatBody({ model: "m", messages: [{ role: "user", content: "x" }], tools: [{ name: "f", input_schema: {} }], tool_choice: { type: "any" } }).tool_choice).toBe("required");
		expect(messagesToChatBody({ model: "m", messages: [{ role: "user", content: "x" }], tool_choice: { type: "any" } }).tool_choice).toBeUndefined(); // no tools ⇒ no choice
		expect(messagesToChatBody({ model: "m", messages: [{ role: "user", content: "x" }], thinking: { type: "enabled", budget_tokens: 30000 } }).reasoning).toEqual({ effort: "high" });
		expect(messagesToChatBody({ model: "m", messages: [{ role: "user", content: "x" }], thinking: { type: "adaptive" } }).reasoning).toEqual({ effort: "medium" });
	});

	test("rejects what cannot be a turn", async () => {
		expect(() => messagesToChatBody("nope")).toThrow("JSON object");
		expect(() => messagesToChatBody({ model: "", messages: [{ role: "user", content: "x" }] })).toThrow("model");
		expect(() => messagesToChatBody({ model: "m", messages: [] })).toThrow("messages");
		expect(() => messagesToChatBody({ model: "m", messages: [{ role: "tool", content: "x" }] })).toThrow("user, assistant or system");
		expect(() => messagesToChatBody({ model: "m", messages: [{ role: "user", content: 5 }] })).toThrow("content");
	});

	test("model names map by glob, first match wins, profile ids pass through", async () => {
		expect(mapAnthropicModel("claude-haiku-4-5-20251001")).toBe("auto-cheap");
		expect(mapAnthropicModel("claude-opus-4-8")).toBe("auto");
		expect(mapAnthropicModel("auto-sub")).toBe("auto-sub");
		expect(mapAnthropicModel("claude-opus-4-8", { "claude-opus-*": "auto-max", "claude-*": "auto" })).toBe("auto-max");
		expect(mapAnthropicModel("Claude-Sonnet-5", { "claude-*": "auto" })).toBe("auto"); // case-insensitive
	});
});

describe("parseMessagesRequest", () => {
	test("derives the harness from the user agent and the session from metadata; explicit headers win; the rendered body is chat-shaped", async () => {
		const headers = new Headers({ "user-agent": "claude-cli/2.1.263 (external, cli)", "x-api-key": "k", "anthropic-version": "2023-06-01" });
		const norm = parseMessagesRequest(CLAUDE_CODE_BODY, headers);
		expect(norm.protocol).toBe("anthropic-messages");
		expect(norm.harnessId).toBe("claude-code");
		expect(norm.ompSessionId).toBe("0c8d5f1e-1234-4bcd-9abc-def012345678");
		expect(norm.requestedModel).toBe("auto");
		expect(norm.tools.map((t) => t.name)).toEqual(["Read"]);
		expect(norm.forcedToolChoice).toBe(false);
		expect(norm.reasoning).toBe("medium");
		expect(norm.stream).toBe(true);
		expect(norm.messages.at(-1)?.text).toBe("thanks");
		const body = norm.renderUpstreamBody({ ...MUT, cacheBreakpointMessageIndices: [0] });
		expect(body.model).toBe("x/y");
		expect((body.messages as { content: unknown }[])[0]!.content).toEqual([{ type: "text", text: expect.stringContaining("Claude Code"), cache_control: { type: "ephemeral" } }]);
		expect("system" in body).toBe(false);
		expect("metadata" in body).toBe(false);
		const explicit = anthropicIdentityHeaders(CLAUDE_CODE_BODY, new Headers({ "x-omp-harness": "mine", "x-omp-session": "s-1" }));
		expect(explicit.get("x-omp-harness")).toBe("mine");
		expect(explicit.get("x-omp-session")).toBe("s-1");
		expect(anthropicIdentityHeaders({}, new Headers({ "user-agent": "python-requests" })).get("x-omp-harness")).toBe("anthropic");
	});

	test("the agentdox scope and layer headers reach the request on the Anthropic path too", async () => {
		const plain = parseMessagesRequest(CLAUDE_CODE_BODY, new Headers({ "user-agent": "claude-cli/2.1.263" }));
		expect(plain.agentdoxScope).toBe("");
		expect(plain.agentdoxGroup).toBe("");
		expect(plain.agentdoxPersonal).toBe("");
		const team = parseMessagesRequest(
			CLAUDE_CODE_BODY,
			new Headers({ "user-agent": "claude-cli/2.1.263", "x-omp-harness": "u_ada", "x-agentdox-scope": "proj", "x-agentdox-group": "group.g1", "x-agentdox-personal": "proj.u.u_ada" }),
		);
		expect(team.harnessId).toBe("u_ada");
		expect(team.agentdoxScope).toBe("proj");
		expect(team.agentdoxGroup).toBe("group.g1");
		expect(team.agentdoxPersonal).toBe("proj.u.u_ada");
		expect(parseMessagesRequest(CLAUDE_CODE_BODY, new Headers({ "x-agentdox-group": "Not A Slug" })).agentdoxGroup).toBe("");
	});

	test("the origin fingerprint reaches the request on the Anthropic path too", async () => {
		expect(parseMessagesRequest(CLAUDE_CODE_BODY, new Headers({ "user-agent": "claude-cli/2.1.263" })).agentdoxOrigin).toBe("");
		expect(parseMessagesRequest(CLAUDE_CODE_BODY, new Headers({ "x-agentdox-origin": "github.com/drewappling/omp-router" })).agentdoxOrigin).toBe("github.com/drewappling/omp-router");
		expect(parseMessagesRequest(CLAUDE_CODE_BODY, new Headers({ "x-agentdox-origin": "https://github.com/a/b" })).agentdoxOrigin).toBe("");
	});

	test("a request captured from Claude Code 2.1: system inside messages, JSON user_id, adaptive thinking with effort, 23 custom tools", async () => {
		const fixture = JSON.parse(readFileSync("test/fixtures/harness/claude-code.json", "utf8")) as { headers: Record<string, string>; body: Record<string, unknown> };
		const norm = parseMessagesRequest(fixture.body, new Headers(fixture.headers));
		expect(norm.harnessId).toBe("claude-code");
		expect(norm.ompSessionId).toBe("a2321f8a-1ce0-44f7-831b-839a35035f9c");
		expect(norm.requestedModel).toBe("auto");
		expect(norm.tools).toHaveLength(23);
		expect(norm.tools.map((t) => t.name)).toContain("Read");
		expect(norm.messages.map((m) => m.role)).toEqual(["system", "user", "system"]);
		expect(norm.reasoning).toBe("high"); // output_config.effort over adaptive thinking
		expect(norm.maxTokens).toBe(64000);
		expect(norm.stream).toBe(true);
		const body = norm.renderUpstreamBody(MUT);
		for (const k of ["system", "metadata", "thinking", "context_management", "output_config"]) expect(k in body).toBe(false);
		expect((body.tools as unknown[]).length).toBe(23);
		expect(sessionFromUserId("user_9f8e_account_a1b2_session_0c8d5f1e-1234-4bcd-9abc-def012345678")).toBe("0c8d5f1e-1234-4bcd-9abc-def012345678");
		expect(sessionFromUserId("nothing here")).toBeNull();
	});

	test("count_tokens estimates from the prompt bytes", async () => {
		expect(countAnthropicTokens(CLAUDE_CODE_BODY, DEFAULT_CONFIG.anthropic.models, null)).toBeGreaterThan(50);
		expect(() => countAnthropicTokens({ model: "m", messages: [] }, {}, null)).toThrow("messages");
	});
});

// ---------------------------------------------------------------- rendering

const chunk = (events: StreamEvent[]): UpstreamChunk => ({ raw: {}, events });
const summary: TurnSummary = { servedSlug: "anthropic/claude-sonnet-5", tier: "moderate", attempts: 1, predictedUsd: 0.01, reportedUsd: 0.012, usage: { ...EMPTY_USAGE, promptTokens: 1200, cachedTokens: 900, cacheWriteTokens: 100, completionTokens: 40, reasoningTokens: 10 }, reasons: ["r"], escalated: false };

async function drain(res: Response): Promise<{ type: string; data: Record<string, unknown> }[]> {
	const text = await res.text();
	const out: { type: string; data: Record<string, unknown> }[] = [];
	for (const frame of text.split("\n\n")) {
		const ev = /^event: (.+)$/m.exec(frame)?.[1];
		const data = /^data: (.+)$/m.exec(frame)?.[1];
		if (ev !== undefined && data !== undefined) out.push({ type: ev, data: JSON.parse(data) as Record<string, unknown> });
	}
	return out;
}

describe("Messages rendering", () => {
	test("streams thinking, text and a tool call as Messages events with Anthropic usage and the routing summary", async () => {
		const { sink, response } = createMessagesStreamingSink("claude-sonnet-4-5");
		sink.chunk(chunk([{ type: "start", servedSlug: "anthropic/claude-sonnet-5", generationId: "g" }]));
		sink.chunk(chunk([{ type: "reasoning", delta: "Let me " }, { type: "reasoning", delta: "think." }]));
		sink.chunk(chunk([{ type: "text", delta: "Hel" }, { type: "text", delta: "lo" }]));
		sink.chunk(chunk([{ type: "tool_call", index: 0, id: "call_1", name: "Read", argsDelta: '{"file_' }]));
		sink.chunk(chunk([{ type: "tool_call", index: 0, argsDelta: 'path":"a.ts"}' }]));
		sink.chunk(chunk([{ type: "finish", reason: "tool_calls" }, { type: "usage", usage: summary.usage, reportedCostUsd: 0.012 }]));
		sink.finish(summary);
		const events = await drain(response);
		expect(events.map((e) => e.type)).toEqual(["message_start", "ping", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
		const start = events[0]!.data.message as { model: string; role: string; content: unknown[] };
		expect(start).toMatchObject({ model: "claude-sonnet-4-5", role: "assistant", content: [] });
		expect(events[2]!.data.content_block).toEqual({ type: "thinking", thinking: "" });
		expect(events[3]!.data.delta).toEqual({ type: "thinking_delta", thinking: "Let me " });
		expect(events[6]!.data).toMatchObject({ index: 1, content_block: { type: "text", text: "" } });
		expect(events[7]!.data.delta).toEqual({ type: "text_delta", text: "Hel" });
		expect(events[10]!.data).toMatchObject({ index: 2, content_block: { type: "tool_use", id: "call_1", name: "Read", input: {} } });
		expect(events[11]!.data.delta).toEqual({ type: "input_json_delta", partial_json: '{"file_' });
		const delta = events[14]!.data as { delta: { stop_reason: string }; usage: Record<string, number>; x_auto_model_router: { model: string } };
		expect(delta.delta.stop_reason).toBe("tool_use");
		expect(delta.usage).toEqual({ input_tokens: 200, cache_read_input_tokens: 900, cache_creation_input_tokens: 100, output_tokens: 40 });
		expect(delta.x_auto_model_router.model).toBe("anthropic/claude-sonnet-5");
	});

	test("a buffered turn is one Message with parsed tool input, end_turn, and the summary headers", async () => {
		const { sink, response } = createMessagesBufferedSink("claude-opus-4-8");
		sink.chunk(chunk([{ type: "start", servedSlug: "x/y", generationId: null }, { type: "text", delta: "done" }, { type: "finish", reason: "stop" }]));
		sink.finish(summary);
		const res = await response;
		expect(res.status).toBe(200);
		expect(res.headers.get("x-auto-model-router-tier")).toBe("moderate");
		const msg = (await res.json()) as { type: string; role: string; model: string; content: unknown[]; stop_reason: string; usage: Record<string, number>; x_auto_model_router: unknown };
		expect(msg).toMatchObject({ type: "message", role: "assistant", model: "claude-opus-4-8", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { output_tokens: 40 } });

		const tool = createMessagesBufferedSink("m");
		tool.sink.chunk(chunk([{ type: "tool_call", index: 0, id: "t", name: "f", argsDelta: '{"a":1}' }, { type: "tool_call", index: 1, id: "u", name: "g", argsDelta: "not json" }, { type: "finish", reason: "length" }]));
		tool.sink.finish(summary);
		const m2 = (await (await tool.response).json()) as { content: { type: string; id?: string; name?: string; input?: unknown }[]; stop_reason: string };
		expect(m2.content).toEqual([{ type: "tool_use", id: "t", name: "f", input: { a: 1 } }, { type: "tool_use", id: "u", name: "g", input: {} }]);
		expect(m2.stop_reason).toBe("max_tokens");
	});

	test("failures use the Anthropic envelope, streaming as an error event", async () => {
		const { sink, response } = createMessagesStreamingSink("m");
		sink.chunk(chunk([{ type: "start", servedSlug: "x/y", generationId: null }]));
		sink.error({ status: 429, code: "rate_limited", message: "slow down" });
		const events = await drain(response);
		expect(events.at(-1)).toEqual({ type: "error", data: { type: "error", error: { type: "rate_limit_error", message: "slow down", code: "rate_limited" } } });
		const buffered = createMessagesBufferedSink("m");
		buffered.sink.error({ status: 502, code: "upstream", message: "no" });
		const res = await buffered.response;
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: { type: string } }).error.type).toBe("api_error");
		expect(renderAnthropicError({ status: 401, code: "u", message: "m" })).toMatchObject({ type: "error", error: { type: "authentication_error" } });
		expect(renderAnthropicError({ status: 529, code: "o", message: "m" })).toMatchObject({ error: { type: "overloaded_error" } });
	});
});

// ---------------------------------------------------------------- HTTP

describe("POST /v1/messages over HTTP", () => {
	let handle: StartedServer;
	let base: string;
	beforeAll(() => {
		const cfg: RouterConfig = {
			...DEFAULT_CONFIG,
			server: { host: "127.0.0.1", port: 0, maxConcurrentTurns: 4, subagentProfile: "auto-sub", apiKey: "rk" },
			ledger: { ...DEFAULT_CONFIG.ledger, path: ":memory:" },
			context: { ...DEFAULT_CONFIG.context, enabled: false },
			logLevel: "silent",
		};
		handle = startServer(cfg);
		base = `http://127.0.0.1:${handle.server.port}`;
	});
	afterAll(async () => {
		await handle.stop();
	});

	test("x-api-key authenticates like a bearer, and refusals come in the Anthropic envelope", async () => {
		const body = JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
		const noKey = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body });
		expect(noKey.status).toBe(401);
		expect(((await noKey.json()) as { type: string; error: { type: string } })).toMatchObject({ type: "error", error: { type: "authentication_error" } });
		const bad = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "rk" }, body: "{" });
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as { error: { type: string } }).error.type).toBe("invalid_request_error");
		const noMessages = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "rk" }, body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 5, messages: [] }) });
		expect(noMessages.status).toBe(400);
		expect(((await noMessages.json()) as { error: { message: string } }).error.message).toContain("messages");
		// The OpenAI routes keep their own envelope.
		const chat = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body });
		expect(((await chat.json()) as { error: { type: string } }).error.type).toBe("authentication_error");
		expect("type" in ((await (await fetch(`${base}/v1/models`, { headers: { "x-api-key": "rk" } })).json()) as Record<string, unknown>)).toBe(false);
	});

	test("count_tokens answers with an estimate", async () => {
		const res = await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "rk", "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: "claude-sonnet-4-5", system: "You are terse.", messages: [{ role: "user", content: "Summarise the repository layout in three lines." }] }) });
		expect(res.status).toBe(200);
		const n = ((await res.json()) as { input_tokens: number }).input_tokens;
		expect(n).toBeGreaterThan(10);
		expect(n).toBeLessThan(100);
		expect((await fetch(`${base}/v1/messages/count_tokens`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "rk" }, body: "nope" })).status).toBe(400);
	});
});
