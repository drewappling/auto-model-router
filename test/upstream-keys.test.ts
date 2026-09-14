import { describe, expect, test } from "bun:test";

import { buildUpstreamModels } from "../src/catalog/static-catalog.ts";
import type { CatalogSnapshot } from "../src/catalog/types.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig, UpstreamEntry } from "../src/config/types.ts";
import { completeUpstreamEntry } from "../src/config/upstreams.ts";
import { buildCandidates } from "../src/router/candidates.ts";
import { extractFeatures } from "../src/router/features.ts";
import type { Rejection } from "../src/router/types.ts";
import { createAnthropicClient } from "../src/upstream/anthropic.ts";
import { compatEndpoint, createCompatClient } from "../src/upstream/compat.ts";
import { createOllamaClient } from "../src/upstream/ollama.ts";
import { createOpenRouterClient } from "../src/upstream/openrouter.ts";
import { parseMessagesRequest } from "../src/wire/anthropic/messages.ts";
import { parseChatRequest, parseUpstreamKeysHeader } from "../src/wire/openai/request.ts";
import { parseResponsesRequest } from "../src/wire/openai/responses.ts";

/**
 * Per-turn upstream credentials (X-Omp-Upstream-Keys): a front door whose
 * callers bring their own keys sends the turn's credentials in a header, so one
 * router fleet serves every tenant instead of one process per credential set.
 *
 * The property everything else rests on: the credential belongs to the TURN.
 * The shared `UpstreamEntry` is never written to, so two concurrent turns
 * cannot see each other's key.
 */

const NL = String.fromCharCode(10);

function entry(over: Partial<UpstreamEntry> & { id: string; kind: UpstreamEntry["kind"] }): UpstreamEntry {
	return completeUpstreamEntry({ baseUrl: "https://api.example/v1", apiKey: "sk-configured", models: [{ id: "m1", input: 1, output: 4 }], ...over });
}

function cfgWith(upstreams: UpstreamEntry[]): RouterConfig {
	return { ...structuredClone(DEFAULT_CONFIG), upstreams, logLevel: "silent" };
}

function sse(frames: string[]): Response {
	return new Response(
		new ReadableStream({
			start: (c) => {
				for (const f of frames) c.enqueue(new TextEncoder().encode(`${f}${NL}${NL}`));
				c.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

/** Drains a dispatch so the fake upstream's stream is consumed like a real turn's. */
async function drain(d: { chunks: AsyncIterable<unknown> }): Promise<void> {
	for await (const c of d.chunks) void c;
}

const OK_FRAMES = [`data: ${JSON.stringify({ id: "gen-1", model: "m1", choices: [{ delta: { content: "hi" } }] })}`, "data: [DONE]"];
const ANTHROPIC_FRAMES = [
	`event: message_start${NL}data: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: "claude-sonnet-4", usage: { input_tokens: 1, output_tokens: 0 } } })}`,
	`event: message_stop${NL}data: ${JSON.stringify({ type: "message_stop" })}`,
];

const SIGNAL = new AbortController().signal;

describe("parseUpstreamKeysHeader", () => {
	test("accepts an id→credential object, drops junk, and never rejects a turn", async () => {
		// Same defensive contract as X-Omp-Policy: anything unusable is simply no override.
		expect(parseUpstreamKeysHeader(null)).toBeUndefined();
		expect(parseUpstreamKeysHeader("   ")).toBeUndefined();
		expect(parseUpstreamKeysHeader("not json")).toBeUndefined();
		expect(parseUpstreamKeysHeader('["sk-x"]')).toBeUndefined();
		expect(parseUpstreamKeysHeader('"sk-x"')).toBeUndefined();
		expect(parseUpstreamKeysHeader("{}")).toBeUndefined();
		// Non-string values are dropped; an empty string is KEPT — it means "no credential this turn".
		expect(parseUpstreamKeysHeader(JSON.stringify({ openrouter: "sk-or-1", " azure-eu ": "az", bad: 7, worse: null, "": "x", off: "" }))).toEqual({
			openrouter: "sk-or-1",
			"azure-eu": "az",
			off: "",
		});
		// The credential is copied verbatim: trimming one would break a key whose bytes matter.
		expect(parseUpstreamKeysHeader(JSON.stringify({ up: " sk-pad " }))).toEqual({ up: " sk-pad " });
	});

	test("every wire carries the map, and its absence leaves the property off", async () => {
		const header = new Headers({ "X-Omp-Upstream-Keys": '{"openrouter":"sk-or-tenant"}' });
		const chat = parseChatRequest({ model: "auto", messages: [{ role: "user", content: "hi" }] }, header);
		const messages = parseMessagesRequest({ model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }, header);
		const responses = parseResponsesRequest({ model: "auto", input: "hi" }, header);
		for (const req of [chat, messages, responses]) expect(req.upstreamKeys).toEqual({ openrouter: "sk-or-tenant" });
		expect([chat.protocol, messages.protocol, responses.protocol]).toEqual(["openai-chat", "anthropic-messages", "openai-responses"]);
		// exactOptionalPropertyTypes: absent means absent, not `undefined`.
		expect("upstreamKeys" in parseChatRequest({ model: "auto", messages: [{ role: "user", content: "hi" }] }, new Headers())).toBe(false);
		expect("upstreamKeys" in parseMessagesRequest({ model: "claude-sonnet-4", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }, new Headers())).toBe(false);
		expect("upstreamKeys" in parseResponsesRequest({ model: "auto", input: "hi" }, new Headers())).toBe(false);
	});
});

describe("per-turn credentials at dispatch", () => {
	test("compatEndpoint prefers the per-turn key without touching the entry", async () => {
		const e = entry({ id: "openai-direct", kind: "openai" });
		expect(compatEndpoint(e, "m1").headers.authorization).toBe("Bearer sk-configured");
		expect(compatEndpoint(e, "m1", "sk-turn").headers.authorization).toBe("Bearer sk-turn");
		// Azure keys with its own header, and an empty credential sends none at all.
		const az = entry({ id: "azure-eu", kind: "azure" });
		expect(compatEndpoint(az, "dep", "az-turn").headers["api-key"]).toBe("az-turn");
		expect(compatEndpoint(az, "dep", "").headers["api-key"]).toBeUndefined();
		expect(e.apiKey).toBe("sk-configured");
	});

	test("an OpenAI-compatible upstream uses the turn's key, else the configured one", async () => {
		const seen: Array<string | null> = [];
		const cfg = cfgWith([entry({ id: "openai-direct", kind: "openai" })]);
		const client = createCompatClient(cfg, "openai-direct", async (_url, init) => {
			seen.push(new Headers(init?.headers).get("authorization"));
			return sse(OK_FRAMES);
		});
		const body = { model: "openai-direct/m1", messages: [] };
		await drain(await client.dispatch({ body, sessionId: "s", signal: SIGNAL, upstreamKeys: { "openai-direct": "sk-turn" } }));
		await drain(await client.dispatch({ body, sessionId: "s", signal: SIGNAL }));
		// A map that names a DIFFERENT upstream leaves this one on its own key.
		await drain(await client.dispatch({ body, sessionId: "s", signal: SIGNAL, upstreamKeys: { openrouter: "sk-or" } }));
		// An empty credential is "none", never a fallback to the configured key.
		await drain(await client.dispatch({ body, sessionId: "s", signal: SIGNAL, upstreamKeys: { "openai-direct": "" } }));
		expect(seen).toEqual(["Bearer sk-turn", "Bearer sk-configured", "Bearer sk-configured", null]);
		expect(cfg.upstreams[0]!.apiKey).toBe("sk-configured");
	});

	test("an Anthropic upstream uses the turn's key on both auth shapes", async () => {
		const seen: Array<Record<string, string | null>> = [];
		const cfg = cfgWith([
			entry({ id: "anthropic-direct", kind: "anthropic", apiKey: "sk-ant-configured" }),
			entry({ id: "claude-sub", kind: "anthropic", auth: "oauth-bearer", apiKey: "oauth-configured" }),
		]);
		const fetchImpl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
			const h = new Headers(init?.headers);
			seen.push({ "x-api-key": h.get("x-api-key"), authorization: h.get("authorization") });
			return sse(ANTHROPIC_FRAMES);
		};
		const direct = createAnthropicClient(cfg, "anthropic-direct", fetchImpl);
		const sub = createAnthropicClient(cfg, "claude-sub", fetchImpl);
		await drain(await direct.dispatch({ body: { model: "anthropic-direct/m1", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }, sessionId: "s", signal: SIGNAL, upstreamKeys: { "anthropic-direct": "sk-ant-turn" } }));
		await drain(await direct.dispatch({ body: { model: "anthropic-direct/m1", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }, sessionId: "s", signal: SIGNAL }));
		await drain(await sub.dispatch({ body: { model: "claude-sub/m1", messages: [{ role: "user", content: "hi" }], max_tokens: 16 }, sessionId: "s", signal: SIGNAL, upstreamKeys: { "claude-sub": "oauth-turn" } }));
		expect(seen).toEqual([
			{ "x-api-key": "sk-ant-turn", authorization: null },
			{ "x-api-key": "sk-ant-configured", authorization: null },
			{ "x-api-key": null, authorization: "Bearer oauth-turn" },
		]);
		expect(cfg.upstreams.map((u) => u.apiKey)).toEqual(["sk-ant-configured", "oauth-configured"]);
	});

	test("OpenRouter and Ollama take an override under their own reserved ids", async () => {
		const cfg = cfgWith([]);
		cfg.openrouter.apiKey = "sk-or-configured";
		cfg.ollama = { ...cfg.ollama, apiKey: "sk-ollama-configured" };
		const seen: Array<string | null> = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("authorization"));
			return sse(OK_FRAMES);
		}) as unknown as typeof fetch;
		try {
			const or = createOpenRouterClient(cfg);
			await drain(await or.dispatch({ body: { model: "a/b", messages: [] }, sessionId: "s", signal: SIGNAL, upstreamKeys: { openrouter: "sk-or-turn" } }));
			await drain(await or.dispatch({ body: { model: "a/b", messages: [] }, sessionId: "s", signal: SIGNAL }));
		} finally {
			globalThis.fetch = realFetch;
		}
		const ollama = createOllamaClient(cfg, async (_url, init) => {
			seen.push(new Headers(init?.headers).get("authorization"));
			return sse(OK_FRAMES);
		});
		await drain(await ollama.dispatch({ body: { model: "ollama/m", messages: [] }, sessionId: "s", signal: SIGNAL, upstreamKeys: { ollama: "sk-ollama-turn" } }));
		await drain(await ollama.dispatch({ body: { model: "ollama/m", messages: [] }, sessionId: "s", signal: SIGNAL }));
		expect(seen).toEqual(["Bearer sk-or-turn", "Bearer sk-or-configured", "Bearer sk-ollama-turn", "Bearer sk-ollama-configured"]);
		expect(cfg.openrouter.apiKey).toBe("sk-or-configured");
		expect(cfg.ollama.apiKey).toBe("sk-ollama-configured");
	});

	test("two concurrent turns over one entry never see each other's credential", async () => {
		const cfg = cfgWith([entry({ id: "openai-direct", kind: "openai" })]);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const seen: Array<string | null> = [];
		let inFlight = 0;
		const client = createCompatClient(cfg, "openai-direct", async (_url, init) => {
			const auth = new Headers(init?.headers).get("authorization");
			// Hold both requests open at once: a mutation-based implementation
			// would have overwritten the first turn's key by the time it reads.
			inFlight++;
			if (inFlight === 1) await gate;
			else release();
			seen.push(auth);
			return sse(OK_FRAMES);
		});
		const turn = async (key: string): Promise<void> => {
			const d = await client.dispatch({ body: { model: "openai-direct/m1", messages: [] }, sessionId: "s", signal: SIGNAL, upstreamKeys: { "openai-direct": key } });
			await drain(d);
		};
		await Promise.all([turn("sk-tenant-a"), turn("sk-tenant-b")]);
		expect(seen.sort()).toEqual(["Bearer sk-tenant-a", "Bearer sk-tenant-b"]);
		// The shared config is exactly as it was configured.
		expect(cfg.upstreams[0]!.apiKey).toBe("sk-configured");
	});
});

describe("candidate selection with per-turn credentials", () => {
	const twoUpstreams = [
		...buildUpstreamModels(entry({ id: "up-a", kind: "openai", models: [{ id: "m1", input: 1, output: 4, quality: { coding: 80, intelligence: 80, agentic: 80 } }] }), []),
		...buildUpstreamModels(entry({ id: "up-b", kind: "openai", models: [{ id: "m1", input: 1, output: 4, quality: { coding: 80, intelligence: 80, agentic: 80 } }] }), []),
	];
	const snapshot: CatalogSnapshot = { models: twoUpstreams, fetchedAtMs: Date.now(), keyScoped: true };
	const cfg: RouterConfig = { ...DEFAULT_CONFIG, adaptiveTierFloors: false, filters: { ...DEFAULT_CONFIG.filters, minTrust: 0 }, tiers: { ...DEFAULT_CONFIG.tiers, moderate: { ...DEFAULT_CONFIG.tiers.moderate, minQuality: 0, maxInputPerMtok: 10 } } };

	function build(keys: Record<string, string> | undefined): { slugs: string[]; rejected: Rejection[] } {
		const req = parseChatRequest(
			{ model: "auto", messages: [{ role: "user", content: "hi" }] },
			new Headers(keys === undefined ? {} : { "x-omp-upstream-keys": JSON.stringify(keys) }),
		);
		const { candidates, rejected } = buildCandidates({ req, features: extractFeatures(req, 100), tier: "moderate", task: "chat", snapshot, cfg, expectedCompletionTokens: 128, warmSlug: null });
		return { slugs: candidates.map((c) => c.model.slug), rejected };
	}

	test("an upstream with an empty credential is excluded for that turn only", async () => {
		expect(build(undefined).slugs.sort()).toEqual(["up-a/m1", "up-b/m1"]);
		// A real credential changes nothing about who may be selected.
		expect(build({ "up-a": "sk-turn" }).slugs.sort()).toEqual(["up-a/m1", "up-b/m1"]);
		const off = build({ "up-a": "" });
		expect(off.slugs).toEqual(["up-b/m1"]);
		expect(off.rejected).toContainEqual({ slug: "up-a/m1", reason: "no_credential", detail: "upstream up-a has no credential on this turn" });
		// The next turn, carrying a key, sees it again: nothing was recorded anywhere.
		expect(build({ "up-a": "sk-turn" }).slugs.sort()).toEqual(["up-a/m1", "up-b/m1"]);
	});

	test("no rejection reason repeats the credential", async () => {
		const { rejected } = build({ "up-a": "", "up-b": "sk-secret-value" });
		expect(JSON.stringify(rejected)).not.toContain("sk-secret-value");
	});
});
