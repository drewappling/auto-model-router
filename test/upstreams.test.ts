import { describe, expect, test } from "bun:test";

import { createCompositeCatalog } from "../src/catalog/composite.ts";
import type { OllamaCatalogSource } from "../src/catalog/ollama-catalog.ts";
import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import { buildUpstreamModels, createStaticCatalogSource } from "../src/catalog/static-catalog.ts";
import type { CatalogModel, CatalogSnapshot, CatalogSource } from "../src/catalog/types.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { configInputSchema, RESERVED_UPSTREAM_IDS } from "../src/config/schema.ts";
import type { RouterConfig, UpstreamEntry } from "../src/config/types.ts";
import { completeUpstreamEntry } from "../src/config/upstreams.ts";
import { applyConfigPatch } from "../src/config/apply.ts";
import { providerOfSlug, setKnownUpstreamIds } from "../src/cost/report.ts";
import { NO_USAGE } from "../src/upstream/ollama-usage.ts";
import { ANTHROPIC_VERSION, classifyAnthropicStatus, createAnthropicClient, createAnthropicTranslator, readSseFrames, toAnthropicBody } from "../src/upstream/anthropic.ts";
import { classifyCompatStatus, compatEndpoint, createCompatClient, toCompatBody } from "../src/upstream/compat.ts";
import { createMultiUpstream, namedUpstreamOf } from "../src/upstream/multi.ts";
import type { Dispatch, DispatchOptions, UpstreamClient } from "../src/upstream/types.ts";

const NL = String.fromCharCode(10);

function entry(over: Partial<UpstreamEntry> & { id: string; kind: UpstreamEntry["kind"] }): UpstreamEntry {
	return completeUpstreamEntry({ baseUrl: "https://api.example/v1", apiKey: "sk-x", models: [{ id: "m1", input: 1, output: 4 }], ...over });
}

function cfgWith(upstreams: UpstreamEntry[], logLevel: RouterConfig["logLevel"] = "silent"): RouterConfig {
	return { ...structuredClone(DEFAULT_CONFIG), upstreams, logLevel };
}

/** An OpenRouter-shaped record, for twins. */
function orRaw(id: string, coding: number, image = false): Record<string, unknown> {
	return {
		id,
		canonical_slug: id,
		name: id,
		context_length: 128_000,
		top_provider: { max_completion_tokens: 16_000 },
		pricing: { prompt: "0.0000025", completion: "0.00001" },
		supported_parameters: ["tools", "reasoning", "tool_choice"],
		architecture: { input_modalities: image ? ["text", "image"] : ["text"], tokenizer: "GPT" },
		benchmarks: { artificial_analysis: { coding_index: coding, intelligence_index: coding - 10, agentic_index: coding - 20 } },
		created: 1_700_000_000,
	};
}

function sse(frames: string[]): Response {
	return new Response(new ReadableStream({ start: (c) => { for (const f of frames) c.enqueue(new TextEncoder().encode(`${f}${NL}${NL}`)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("upstreams config", () => {
	test("an entry is accepted with defaults filled; a reserved or malformed id is refused", async () => {
		const ok = configInputSchema.safeParse({ upstreams: [{ id: "openai-direct", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk", models: [{ id: "gpt-4o", input: 2.5, output: 10 }] }] });
		expect(ok.success).toBe(true);
		const full = completeUpstreamEntry({ id: "vllm", kind: "openai", baseUrl: "http://vllm:8000/v1", models: [] });
		expect(full).toMatchObject({ enabled: true, apiKey: "", apiVersion: "2024-10-21", headers: {}, timeoutMs: 600_000, rateLimitCooldownMs: 60_000, quotaCooldownMs: 900_000 });
		for (const id of ["openai", "anthropic", "ollama", "openrouter"]) {
			expect(RESERVED_UPSTREAM_IDS).toContain(id);
			expect(configInputSchema.safeParse({ upstreams: [{ id, kind: "openai", baseUrl: "https://x", models: [] }] }).success).toBe(false);
		}
		expect(configInputSchema.safeParse({ upstreams: [{ id: "Bad Id", kind: "openai", baseUrl: "https://x", models: [] }] }).success).toBe(false);
		expect(configInputSchema.safeParse({ upstreams: [{ id: "x", kind: "bedrock", baseUrl: "https://x", models: [] }] }).success).toBe(false);
	});

	test("a live patch replaces the list and completes sparse entries", async () => {
		const cfg = cfgWith([]);
		const changed = applyConfigPatch(cfg, { upstreams: [{ id: "azure-eu", kind: "azure", baseUrl: "https://r.openai.azure.com", apiKey: "k", models: [{ id: "gpt-4o-deploy", input: 2.5, output: 10 }] }] } as never);
		expect(changed).toEqual(["upstreams"]);
		expect(cfg.upstreams[0]).toMatchObject({ id: "azure-eu", enabled: true, apiVersion: "2024-10-21", headers: {}, timeoutMs: 600_000 });
	});
});

describe("static catalog", () => {
	const twins = [normalizeCatalogModel(orRaw("openai/gpt-4o", 70, true))!, normalizeCatalogModel(orRaw("anthropic/claude-sonnet-4", 80))!];

	test("models are priced per token, namespaced by the entry id, and borrow the twin's scores and modalities", async () => {
		const e = entry({ id: "openai-direct", kind: "openai", models: [{ id: "gpt-4o", input: 2.5, output: 10, cachedInput: 1.25 }, { id: "custom-ft", input: 3, output: 12, contextLength: 32_000, quality: { coding: 55 }, supportsTools: false }] });
		const models = buildUpstreamModels(e, twins);
		expect(models.map((m) => m.slug)).toEqual(["openai-direct/gpt-4o", "openai-direct/custom-ft"]);
		const gpt = models[0]!;
		expect(gpt.provider).toBe("openai-direct");
		expect(gpt.price).toEqual({ prompt: 2.5e-6, completion: 1e-5, cacheRead: 1.25e-6 });
		expect(gpt.quality).toEqual({ coding: 70, intelligence: 60, agentic: 50 }); // the twin openai/gpt-4o
		expect(gpt.inputModalities).toEqual(["text", "image"]);
		expect(gpt.contextLength).toBe(128_000);
		expect(gpt.maxCompletionTokens).toBe(16_000);
		expect(gpt.tokenizer).toBe("GPT");
		const ft = models[1]!;
		expect(ft.quality).toEqual({ coding: 55 });
		expect(ft.contextLength).toBe(32_000);
		expect(ft.supportsTools).toBe(false);
		expect(ft.inputModalities).toEqual(["text"]);
	});

	test("an explicit twin wins over the name match; an anthropic entry defaults to the Claude tokenizer", async () => {
		const e = entry({ id: "anthropic-direct", kind: "anthropic", models: [{ id: "claude-sonnet-4-20250514", input: 3, output: 15, twin: "anthropic/claude-sonnet-4", cacheWrite: 3.75, cachedInput: 0.3 }, { id: "claude-unknown", input: 1, output: 5 }] });
		const [sonnet, unknown] = buildUpstreamModels(e, twins);
		expect(sonnet!.quality.coding).toBe(80);
		expect(sonnet!.price.cacheWrite).toBe(3.75e-6);
		expect(unknown!.quality).toEqual({});
		expect(unknown!.tokenizer).toBe("Claude");
	});

	test("a subscription model with no price of its own inherits the twin's, so it never ranks as free", async () => {
		// A Pro/Max subscription publishes no per-token rates, and pricing it at zero would beat
		// every model in every tier outright. The twin sells the same weights, so it is the rate.
		const e = entry({ id: "anthropic-subscription", kind: "anthropic", costBias: 0.1, models: [{ id: "claude-sonnet-4-20250514", twin: "anthropic/claude-sonnet-4" }] });
		const [sub] = buildUpstreamModels(e, twins);
		const twin = twins.find((m) => m.slug === "anthropic/claude-sonnet-4")!;
		expect(sub!.price.prompt).toBe(twin.price.prompt);
		expect(sub!.price.completion).toBe(twin.price.completion);
		expect(sub!.price.prompt).toBeGreaterThan(0);
		expect(sub!.isFree).toBe(false);
		// The discount is a RANKING bias on the entry, never a rewrite of the recorded price.
		expect(e.costBias).toBe(0.1);
		// An explicit zero still means zero: a self-hosted server is genuinely free.
		const free = entry({ id: "vllm", kind: "openai", models: [{ id: "local", input: 0, output: 0 }] });
		expect(buildUpstreamModels(free, twins)[0]!.price).toEqual({ prompt: 0, completion: 0 });
	});

	test("the source rebuilds only when the entries or the OpenRouter models change", async () => {
		const cfg = cfgWith([entry({ id: "vllm", kind: "openai" })]);
		const src = createStaticCatalogSource(cfg);
		const first = src.get(twins);
		expect(src.get(twins)).toBe(first);
		applyConfigPatch(cfg, { upstreams: [{ id: "vllm", kind: "openai", baseUrl: "http://vllm:8000/v1", models: [{ id: "llama", input: 0, output: 0 }] }] } as never);
		const second = src.get(twins);
		expect(second).not.toBe(first);
		expect(second[0]!.isFree).toBe(false); // $0 self-hosted models must not fall under the free-tier exclusion
	});
});

describe("dispatch by slug prefix", () => {
	const fake = (name: string, seen: string[]): UpstreamClient => ({
		dispatch: async (o: DispatchOptions): Promise<Dispatch> => {
			seen.push(`${name}:${String(o.body.model)}`);
			return { chunks: (async function* () {})(), generationId: async () => null };
		},
		complete: async (b) => {
			seen.push(`${name}:complete:${String(b.model)}`);
			return { text: "", costUsd: null, toolCalls: [] };
		},
		fetchModels: async () => [],
		fetchModelsForUser: async () => [],
	});

	test("ollama/, a named id, and everything else", async () => {
		const seen: string[] = [];
		const named = new Map([["azure-eu", fake("azure", seen)]]);
		const multi = createMultiUpstream(fake("openrouter", seen), fake("ollama", seen), (id) => named.get(id), () => named.keys());
		const signal = new AbortController().signal;
		await multi.dispatch({ body: { model: "ollama/glm" }, sessionId: "s", signal });
		await multi.dispatch({ body: { model: "azure-eu/gpt-4o" }, sessionId: "s", signal });
		await multi.dispatch({ body: { model: "openai/gpt-4o" }, sessionId: "s", signal });
		await multi.complete({ model: "azure-eu/gpt-4o" }, signal);
		expect(seen).toEqual(["ollama:ollama/glm", "azure:azure-eu/gpt-4o", "openrouter:openai/gpt-4o", "azure:complete:azure-eu/gpt-4o"]);
		expect(namedUpstreamOf("openai/gpt-4o", ["openai-direct"])).toBeNull();
		expect(namedUpstreamOf("openai-direct/gpt-4o", ["openai-direct"])).toBe("openai-direct");
	});

	test("the ledger names the provider of a slug from the known ids", async () => {
		setKnownUpstreamIds(["azure-eu", "bad id"]);
		expect(providerOfSlug("azure-eu/gpt-4o")).toBe("azure-eu");
		expect(providerOfSlug("openai/gpt-4o")).toBe("openrouter");
		expect(providerOfSlug("ollama/glm")).toBe("ollama");
		expect(providerOfSlug("bad id/x")).toBe("openrouter");
		setKnownUpstreamIds([]);
	});
});

describe("the OpenAI-compatible client", () => {
	test("the body loses the router's OpenRouter dialect: prefix, cascade, session, cache markers; reasoning becomes reasoning_effort", async () => {
		const out = toCompatBody("vllm", { model: "vllm/llama", models: ["vllm/llama", "vllm/other"], session_id: "s", stream: true, reasoning: { effort: "xhigh" }, messages: [{ role: "system", content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] }, { role: "user", content: "hi" }] });
		expect(out.model).toBe("llama");
		expect(out.models).toBeUndefined();
		expect(out.session_id).toBeUndefined();
		expect(out.reasoning).toBeUndefined();
		expect(out.reasoning_effort).toBe("high");
		expect(out.stream_options).toEqual({ include_usage: true });
		expect((out.messages as { content: Record<string, unknown>[] }[])[0]!.content[0]).toEqual({ type: "text", text: "sys" });
		expect(toCompatBody("vllm", { model: "vllm/llama", reasoning: { enabled: false } }).reasoning_effort).toBeUndefined();
	});

	test("endpoints: OpenAI bears a token; Azure names the deployment in the path and keys with api-key", async () => {
		const oa = compatEndpoint(entry({ id: "openai-direct", kind: "openai", baseUrl: "https://api.openai.com/v1/", headers: { "x-org": "o" } }), "gpt-4o");
		expect(oa.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(oa.headers).toMatchObject({ authorization: "Bearer sk-x", "x-org": "o" });
		const az = compatEndpoint(entry({ id: "azure-eu", kind: "azure", baseUrl: "https://r.openai.azure.com", apiVersion: "2024-10-21" }), "gpt-4o-deploy");
		expect(az.url).toBe("https://r.openai.azure.com/openai/deployments/gpt-4o-deploy/chat/completions?api-version=2024-10-21");
		expect(az.headers["api-key"]).toBe("sk-x");
		expect(az.headers.authorization).toBeUndefined();
	});

	test("statuses: OpenAI's insufficient_quota 429 is the account, a plain 429 the moment; 400 context is final", async () => {
		expect(classifyCompatStatus("x", 429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } })).toMatchObject({ kind: "quota", retryable: true });
		expect(classifyCompatStatus("x", 429, { error: { message: "Rate limit reached" } })).toMatchObject({ kind: "rate_limit", retryable: true });
		expect(classifyCompatStatus("x", 400, { error: { message: "This model's maximum context length is 8192 tokens" } })).toMatchObject({ kind: "context_length", retryable: false });
		expect(classifyCompatStatus("x", 401, {})).toMatchObject({ kind: "auth", retryable: false });
		expect(classifyCompatStatus("x", 503, {})).toMatchObject({ kind: "upstream_error", retryable: true });
	});

	test("dispatch: the served model is re-prefixed, the key travels, and a quota answer opens the breaker", async () => {
		let sent: Record<string, unknown> | null = null;
		let url = "";
		let auth: string | null = null;
		const fetchImpl = async (u: string, init?: RequestInit): Promise<Response> => {
			url = u;
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			auth = (init?.headers as Record<string, string>).authorization ?? null;
			return sse([
				`data: ${JSON.stringify({ id: "g1", model: "gpt-4o-2024-08-06", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] })}`,
				`data: ${JSON.stringify({ id: "g1", model: "gpt-4o-2024-08-06", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } } })}`,
				"data: [DONE]",
			]);
		};
		const cfg = cfgWith([entry({ id: "openai-direct", kind: "openai", baseUrl: "https://api.openai.com/v1", models: [{ id: "gpt-4o", input: 2.5, output: 10 }] })]);
		const client = createCompatClient(cfg, "openai-direct", fetchImpl);
		const d = await client.dispatch({ body: { model: "openai-direct/gpt-4o", messages: [], stream: true }, sessionId: "s", signal: new AbortController().signal });
		const chunks = [];
		for await (const c of d.chunks) chunks.push(c);
		expect(url).toBe("https://api.openai.com/v1/chat/completions");
		expect(sent!.model).toBe("gpt-4o");
		expect(auth as string | null).toBe("Bearer sk-x");
		const start = chunks[0]!.events.find((e) => e.type === "start");
		expect(start && start.type === "start" ? start.servedSlug : null).toBe("openai-direct/gpt-4o-2024-08-06");
		expect(chunks[0]!.raw.model).toBe("openai-direct/gpt-4o-2024-08-06");
		expect(await d.generationId()).toBe("g1");
		const usage = chunks[1]!.events.find((e) => e.type === "usage");
		expect(usage && usage.type === "usage" ? usage.usage.cachedTokens : null).toBe(4);

		// Out of quota: retryable elsewhere, and this upstream is hidden for its quota cooldown.
		const broke = createCompatClient(cfg, "openai-direct", async () => Response.json({ error: { code: "insufficient_quota", message: "quota" } }, { status: 429 }));
		let caught: unknown = null;
		try {
			await broke.dispatch({ body: { model: "openai-direct/gpt-4o", messages: [] }, sessionId: "s", signal: new AbortController().signal });
		} catch (err) {
			caught = err;
		}
		expect(caught).toMatchObject({ kind: "quota", retryable: true });
		expect(broke.available()).toBe(false);
		expect(broke.lastTrip()?.kind).toBe("quota");
		// The live key applies to the next call without a new client.
		applyConfigPatch(cfg, { upstreams: [{ id: "openai-direct", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-new", models: [{ id: "gpt-4o", input: 2.5, output: 10 }] }] } as never);
		await client.dispatch({ body: { model: "openai-direct/gpt-4o", messages: [], stream: true }, sessionId: "s", signal: new AbortController().signal });
		expect(auth as string | null).toBe("Bearer sk-new");
	});
});

describe("the Anthropic client", () => {
	test("the request: system blocks keep cache markers, turns alternate, tools and results map, thinking follows the effort", async () => {
		const body = {
			model: "anthropic-direct/claude-sonnet-4",
			stream: true,
			max_tokens: 1000,
			temperature: 0.2,
			reasoning: { effort: "medium" },
			tool_choice: "required",
			tools: [{ type: "function", function: { name: "read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
			messages: [
				{ role: "system", content: [{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }] },
				{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] },
				{ role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"a.ts\"}" } }] },
				{ role: "tool", tool_call_id: "call_1", content: "contents of a" },
				{ role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "second" }] },
				{ role: "user", content: "and now?" },
			],
		};
		const out = toAnthropicBody(body, { modelId: "claude-sonnet-4", supportsReasoning: true, maxCompletionTokens: 64_000 });
		expect(out.model).toBe("claude-sonnet-4");
		expect(out.system).toEqual([{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }]);
		const msgs = out.messages as { role: string; content: Record<string, unknown>[] }[];
		expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(msgs[0]!.content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
		expect(msgs[1]!.content).toEqual([{ type: "tool_use", id: "call_1", name: "read", input: { path: "a.ts" } }]);
		// Two tool results and the next user turn fold into one user message.
		expect(msgs[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "call_1", content: "contents of a" }, { type: "tool_result", tool_use_id: "call_2", content: "second" }, { type: "text", text: "and now?" }]);
		expect(out.tools).toEqual([{ name: "read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } }]);
		expect(out.tool_choice).toEqual({ type: "any", disable_parallel_tool_use: false });
		// Thinking: the budget for medium, max_tokens raised above it, sampling knobs dropped.
		expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
		expect(out.max_tokens).toBe(8192 + 1024);
		expect(out.temperature).toBeUndefined();
		// Without reasoning support the effort is ignored and the caller's cap stands, bounded by the model's.
		const plain = toAnthropicBody({ ...body, max_tokens: 100_000, reasoning: undefined }, { modelId: "m", supportsReasoning: false, maxCompletionTokens: 8192 });
		expect(plain.thinking).toBeUndefined();
		expect(plain.max_tokens).toBe(8192);
		expect(plain.temperature).toBe(0.2);
	});

	test("the stream: message_start opens, text and tool blocks become chunks, message_delta closes with usage in the OpenAI convention", async () => {
		const t = createAnthropicTranslator("anthropic-direct/claude-sonnet-4");
		const push = (event: string, data: Record<string, unknown>) => t.push({ event, data: JSON.stringify(data) });
		const start = push("message_start", { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-4-20250514", usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } } })!;
		expect(start.events).toEqual([{ type: "start", servedSlug: "anthropic-direct/claude-sonnet-4", generationId: "msg_1" }]);
		expect(start.raw).toMatchObject({ id: "msg_1", model: "anthropic-direct/claude-sonnet-4", object: "chat.completion.chunk" });
		expect(push("ping", { type: "ping" })).toBeNull();
		expect(push("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })).toBeNull();
		const text = push("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })!;
		expect(text.events).toEqual([{ type: "text", delta: "Hello" }]);
		expect((text.raw.choices as { delta: { content: string } }[])[0]!.delta.content).toBe("Hello");
		const think = push("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } })!;
		expect(think.events).toEqual([{ type: "reasoning", delta: "hmm" }]);
		const toolStart = push("content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "read", input: {} } })!;
		expect(toolStart.events).toEqual([{ type: "tool_call", index: 0, id: "toolu_1", name: "read" }]);
		expect((toolStart.raw.choices as { delta: { tool_calls: unknown[] } }[])[0]!.delta.tool_calls).toEqual([{ index: 0, id: "toolu_1", type: "function", function: { name: "read", arguments: "" } }]);
		const args = push("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":" } })!;
		expect(args.events).toEqual([{ type: "tool_call", index: 0, argsDelta: "{\"path\":" }]);
		// A second tool block gets the next tool index whatever its block index.
		const tool2 = push("content_block_start", { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "toolu_2", name: "write", input: {} } })!;
		expect(tool2.events[0]).toMatchObject({ type: "tool_call", index: 1, id: "toolu_2" });
		const end = push("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 25 } })!;
		expect(end.events).toEqual([
			{ type: "finish", reason: "tool_calls" },
			{ type: "usage", usage: { promptTokens: 150, cachedTokens: 40, cacheWriteTokens: 10, completionTokens: 25, reasoningTokens: 0, images: 0 }, reportedCostUsd: null },
		]);
		expect(end.raw.usage).toEqual({ prompt_tokens: 150, completion_tokens: 25, total_tokens: 175, prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 } });
		expect((end.raw.choices as { finish_reason: string }[])[0]!.finish_reason).toBe("tool_calls");
		expect(push("message_stop", { type: "message_stop" })).toBeNull();
		expect(() => push("error", { type: "error", error: { type: "overloaded_error", message: "Overloaded" } })).toThrow("Overloaded");
	});

	test("SSE frames keep their event names, across split chunks and CRLF", async () => {
		const bytes = new TextEncoder().encode("event: message_start\r\ndata: {\"a\":1}\r\n\r\n: keepalive\r\nevent: ping\r\ndata: {}\r\n\r\ndata: {\"tail\":true}");
		const stream = new ReadableStream({ start: (c) => { c.enqueue(bytes.slice(0, 20)); c.enqueue(bytes.slice(20)); c.close(); } });
		const frames = [];
		for await (const f of readSseFrames(stream)) frames.push(f);
		expect(frames).toEqual([{ event: "message_start", data: "{\"a\":1}" }, { event: "ping", data: "{}" }, { event: "", data: "{\"tail\":true}" }]);
	});

	test("dispatch: the Messages request goes out with the version and key, and the chunks come back router-shaped", async () => {
		let url = "";
		let headers: Record<string, string> = {};
		let sent: Record<string, unknown> | null = null;
		const fetchImpl = async (u: string, init?: RequestInit): Promise<Response> => {
			url = u;
			headers = init?.headers as Record<string, string>;
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sse([
				`event: message_start${NL}data: ${JSON.stringify({ type: "message_start", message: { id: "msg_9", model: "claude-sonnet-4-20250514", usage: { input_tokens: 5 } } })}`,
				`event: content_block_delta${NL}data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } })}`,
				`event: message_delta${NL}data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } })}`,
				`event: message_stop${NL}data: {"type":"message_stop"}`,
			]);
		};
		const cfg = cfgWith([entry({ id: "anthropic-direct", kind: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant", models: [{ id: "claude-sonnet-4", input: 3, output: 15, supportsReasoning: true, maxCompletionTokens: 64_000 }] })]);
		const client = createAnthropicClient(cfg, "anthropic-direct", fetchImpl);
		const d = await client.dispatch({ body: { model: "anthropic-direct/claude-sonnet-4", messages: [{ role: "user", content: "ping" }], max_tokens: 50 }, sessionId: "s", signal: new AbortController().signal });
		const chunks = [];
		for await (const c of d.chunks) chunks.push(c);
		expect(url).toBe("https://api.anthropic.com/v1/messages");
		expect(headers).toMatchObject({ "x-api-key": "sk-ant", "anthropic-version": ANTHROPIC_VERSION });
		expect(sent).toMatchObject({ model: "claude-sonnet-4", stream: true, max_tokens: 50, messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }] });
		expect(await d.generationId()).toBe("msg_9");
		const types = chunks.flatMap((c) => c.events.map((e) => e.type));
		expect(types).toEqual(["start", "text", "finish", "usage"]);
		expect(chunks[0]!.raw.model).toBe("anthropic-direct/claude-sonnet-4");
		// A 529 is a moment: retryable, and the breaker opens for the rate-limit cooldown.
		const overloaded = createAnthropicClient(cfg, "anthropic-direct", async () => Response.json({ error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 }));
		let caught: unknown = null;
		try {
			await overloaded.dispatch({ body: { model: "anthropic-direct/claude-sonnet-4", messages: [] }, sessionId: "s", signal: new AbortController().signal });
		} catch (err) {
			caught = err;
		}
		expect(caught).toMatchObject({ kind: "upstream_error", retryable: true });
		expect(overloaded.available()).toBe(false);
		expect(classifyAnthropicStatus("a", 400, { error: { message: "prompt is too long: 250000 tokens" } })).toMatchObject({ kind: "context_length", retryable: false });
		expect(classifyAnthropicStatus("a", 401, {})).toMatchObject({ kind: "auth", retryable: false });
	});

	test("a subscription upstream: OAuth bearer instead of x-api-key, and the Claude Code identity leads the system blocks", async () => {
		// Anthropic answers a Pro/Max token 429 "Error" unless the first system block says this,
		// so the literal is the wire contract and is spelled out here rather than imported.
		const identity = "You are Claude Code, Anthropic's official CLI for Claude.";
		let headers: Record<string, string> = {};
		let sent: Record<string, unknown> = {};
		const fetchImpl = async (_u: string, init?: RequestInit): Promise<Response> => {
			headers = init?.headers as Record<string, string>;
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return sse([`event: message_stop${NL}data: {"type":"message_stop"}`]);
		};
		const cfg = cfgWith([entry({ id: "sub", kind: "anthropic", auth: "oauth-bearer", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-oat01-x", models: [{ id: "claude-sonnet-5", input: 0, output: 0 }] })]);
		const drain = async (messages: unknown[]): Promise<void> => {
			const d = await (await createAnthropicClient(cfg, "sub", fetchImpl)).dispatch({ body: { model: "sub/claude-sonnet-5", messages, max_tokens: 16 }, sessionId: "s", signal: new AbortController().signal });
			for await (const c of d.chunks) void c;
		};
		await drain([{ role: "user", content: "ping" }]);
		expect(headers.authorization).toBe("Bearer sk-ant-oat01-x");
		expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20");
		expect(headers["x-api-key"]).toBeUndefined();
		expect(sent.system).toEqual([{ type: "text", text: identity }]);
		// A caller that already identifies as Claude Code keeps its own block; it is not said twice.
		await drain([{ role: "system", content: `${identity} Be brief.` }, { role: "user", content: "ping" }]);
		expect(sent.system).toEqual([{ type: "text", text: `${identity} Be brief.` }]);
	});
});

describe("the composite catalog with named upstreams", () => {
	const twins = [normalizeCatalogModel(orRaw("openai/gpt-4o", 70))!];
	const base: CatalogSnapshot = { models: twins, fetchedAtMs: 1 };
	const openrouter: CatalogSource = { get: async () => base, refresh: async () => base, peek: () => base, find: (s) => twins.find((m) => m.slug === s) };
	const none: CatalogModel[] = [];
	const ollama: OllamaCatalogSource = { get: async () => none, peek: () => none, invalidate: () => {} };
	const always = { available: () => true, cooldownUntilMs: () => null, lastTrip: () => null };

	test("named models join the snapshot, keep its identity while nothing changes, and vanish while their breaker is open", async () => {
		const cfg = cfgWith([entry({ id: "vllm", kind: "openai", models: [{ id: "llama", input: 0.1, output: 0.4 }] })]);
		const staticSrc = createStaticCatalogSource(cfg);
		let serving = true;
		const cat = createCompositeCatalog(openrouter, ollama, always, { costBias: 1, biasUntilUsage: 1, usage: NO_USAGE, named: { models: (b) => staticSrc.get(b), serving: () => serving } });
		const snap = await cat.get();
		expect(snap.models.map((m: CatalogModel) => m.slug)).toEqual(["openai/gpt-4o", "vllm/llama"]);
		expect(await cat.get()).toBe(snap);
		expect(cat.find("vllm/llama")?.provider).toBe("vllm");
		serving = false;
		const hidden = await cat.get();
		expect(hidden).not.toBe(snap);
		expect(hidden.models.map((m: CatalogModel) => m.slug)).toEqual(["openai/gpt-4o"]);
		serving = true;
		expect((await cat.get()).models).toHaveLength(2);
	});
});
