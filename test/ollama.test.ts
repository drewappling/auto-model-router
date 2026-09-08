import { describe, expect, test } from "bun:test";

import { createCompositeCatalog } from "../src/catalog/composite.ts";
import {
	buildOllamaModels,
	createOllamaCatalog,
	isOllamaDotCom,
	mergeSnapshots,
	ollamaApiRoot,
	ollamaModelId,
	ollamaTwinKey,
	parseOllamaListing,
	parseOllamaShow,
	type OllamaListing,
	loadOllamaCatalogCache,
} from "../src/catalog/ollama-catalog.ts";
import { bareCloudName, ollamaRateFor } from "../src/catalog/ollama-prices.ts";
import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot, CatalogSource } from "../src/catalog/types.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { openDb } from "../src/util/sqlite.ts";
import type { OllamaConfig, RouterConfig } from "../src/config/types.ts";
import { buildCandidates } from "../src/router/candidates.ts";
import { extractFeatures } from "../src/router/features.ts";
import { createMultiUpstream } from "../src/upstream/multi.ts";
import { classifyOllamaStatus, createOllamaClient, toOllamaBody } from "../src/upstream/ollama.ts";
import {
	CALIBRATION_MAX_FACTOR,
	CALIBRATION_MIN_FACTOR,
	calibrationFrom,
	createOllamaUsageSource,
	effectiveOllamaBias,
	NO_USAGE,
	ollamaMeter,
	parseOllamaPlan,
	parseOllamaUsage,
	usageFraction,
} from "../src/upstream/ollama-usage.ts";
import type { Dispatch, DispatchOptions, UpstreamClient } from "../src/upstream/types.ts";
import { createLogger } from "../src/util/log.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";

const BASE: RouterConfig = DEFAULT_CONFIG;
const OLLAMA: OllamaConfig = { ...BASE.ollama, enabled: true };
const log = createLogger("silent");

/** An OpenRouter-shaped raw record, for twins. */
function orRaw(id: string, coding: number, prompt: number, ctx = 200_000, image = false): Record<string, unknown> {
	return {
		id,
		canonical_slug: id,
		name: id,
		context_length: ctx,
		pricing: { prompt: String(prompt / 1e6), completion: String((prompt * 4) / 1e6), input_cache_read: String(prompt / 1e7) },
		supported_parameters: ["tools", "reasoning"],
		architecture: { input_modalities: image ? ["text", "image"] : ["text"], tokenizer: "Qwen" },
		benchmarks: { artificial_analysis: { coding_index: coding, intelligence_index: coding - 20, agentic_index: coding - 25 } },
		created: 1_700_000_000,
	};
}
const OR_MODELS: CatalogModel[] = [
	orRaw("z-ai/glm-5.3-flash", 71.5, 0.07, 1_048_576, true),
	orRaw("openai/gpt-oss-120b", 30.4, 0.05),
	orRaw("moonshotai/kimi-k3", 76.2, 2.55),
]
	.map(normalizeCatalogModel)
	.filter((m): m is CatalogModel => m !== null);

/** Daemon-style `/api/tags` records. */
const DAEMON_TAGS: unknown[] = [
	{ name: "glm-5.3-flash:cloud", model: "glm-5.3-flash:cloud", remote_model: "glm-5.3-flash", remote_host: "https://ollama.com", modified_at: "2026-08-29T18:15:35Z", details: { context_length: 1048576 }, capabilities: ["completion", "thinking", "tools", "vision"] },
	{ name: "gpt-oss:120b-cloud", model: "gpt-oss:120b-cloud", remote_model: "gpt-oss:120b", remote_host: "https://ollama.com", modified_at: "2026-08-29T18:15:35Z", details: { context_length: 131072 }, capabilities: ["completion", "tools", "thinking"] },
	{ name: "deepseek-v4-pro:0813-cloud", model: "deepseek-v4-pro:0813-cloud", remote_model: "deepseek-v4-pro:0813", remote_host: "https://ollama.com", modified_at: "2026-08-29T18:15:35Z", details: { context_length: 1048576 }, capabilities: ["completion", "tools", "thinking"] },
	{ name: "mystery-model:cloud", model: "mystery-model:cloud", remote_model: "mystery-model", remote_host: "https://ollama.com", details: { context_length: 65536 }, capabilities: ["completion", "tools"] },
	{ name: "nomic-embed-text:latest", model: "nomic-embed-text:latest", details: { context_length: 2048 }, capabilities: ["embedding"] },
];

function listings(source: "daemon" | "ollama.com" = "daemon"): OllamaListing[] {
	return DAEMON_TAGS.map((r) => parseOllamaListing(r, source)).filter((l): l is OllamaListing => l !== null);
}

describe("ollama prices", () => {
	test("bare cloud name strips the daemon decoration", () => {
		expect(bareCloudName("glm-5.3-flash:cloud")).toBe("glm-5.3-flash");
		expect(bareCloudName("deepseek-v4-pro:0813-cloud")).toBe("deepseek-v4-pro:0813");
		expect(bareCloudName("GPT-OSS:120b")).toBe("gpt-oss:120b");
	});

	test("tagged rate wins, base rate covers other tags, unknown is null", () => {
		expect(ollamaRateFor("gpt-oss:120b-cloud")?.key).toBe("gpt-oss:120b");
		expect(ollamaRateFor("deepseek-v4-pro:0813")?.key).toBe("deepseek-v4-pro");
		expect(ollamaRateFor("mistral-large-3:675b")?.key).toBe("mistral-large-3");
		expect(ollamaRateFor("mystery-model")).toBeNull();
	});

	test("config overrides beat the shipped snapshot and can add models", () => {
		const o = { "glm-5.3-flash": { input: 0.1, output: 0.2 }, "mystery-model": { input: 1, output: 2 } };
		expect(ollamaRateFor("glm-5.3-flash:cloud", o)?.rate.input).toBe(0.1);
		expect(ollamaRateFor("mystery-model:cloud", o)?.rate.output).toBe(2);
	});
});

describe("ollama listing + show parsing", () => {
	test("daemon records carry context, capabilities and the remote name", () => {
		const l = parseOllamaListing(DAEMON_TAGS[0], "daemon")!;
		expect(l.id).toBe("glm-5.3-flash:cloud");
		expect(l.remoteModel).toBe("glm-5.3-flash");
		expect(l.isCloud).toBe(true);
		expect(l.contextLength).toBe(1048576);
		expect(l.capabilities).toContain("vision");
		// A local model on the daemon is not a cloud model.
		expect(parseOllamaListing(DAEMON_TAGS[4], "daemon")!.isCloud).toBe(false);
	});

	test("ollama.com records are all cloud, with the id as the remote name", () => {
		const l = parseOllamaListing({ name: "glm-5.3-flash", model: "glm-5.3-flash", details: {} }, "ollama.com")!;
		expect(l.isCloud).toBe(true);
		expect(l.remoteModel).toBe("glm-5.3-flash");
		expect(l.contextLength).toBeNull();
	});

	test("show yields the architecture's context length and capabilities", () => {
		const s = parseOllamaShow({ capabilities: ["completion", "tools"], model_info: { "glm5_next.context_length": 1048576, "glm5_next.embedding_length": 4096 } });
		expect(s.contextLength).toBe(1048576);
		expect(s.capabilities).toEqual(["completion", "tools"]);
	});

	test("url helpers", () => {
		expect(isOllamaDotCom("https://ollama.com/v1")).toBe(true);
		expect(isOllamaDotCom("http://127.0.0.1:11434/v1")).toBe(false);
		expect(ollamaApiRoot("https://ollama.com/v1/")).toBe("https://ollama.com");
		expect(ollamaModelId("ollama/glm-5.3-flash:cloud")).toBe("glm-5.3-flash:cloud");
		expect(ollamaModelId("z-ai/glm-5.3-flash")).toBe("z-ai/glm-5.3-flash");
	});
});

describe("buildOllamaModels", () => {
	test("prices, twins, capabilities and context are assembled; unpriced and local models are dropped", () => {
		const models = buildOllamaModels({ listings: listings(), openrouter: OR_MODELS, cfg: OLLAMA, log });
		const slugs = models.map((m) => m.slug).sort();
		expect(slugs).toEqual(["ollama/deepseek-v4-pro:0813-cloud", "ollama/glm-5.3-flash:cloud", "ollama/gpt-oss:120b-cloud"]);

		const glm = models.find((m) => m.slug === "ollama/glm-5.3-flash:cloud")!;
		expect(glm.provider).toBe("ollama");
		expect(glm.author).toBe("ollama");
		expect(glm.price.prompt).toBeCloseTo(0.15 / 1e6, 12);
		expect(glm.price.cacheRead).toBeCloseTo(0.03 / 1e6, 12);
		expect(glm.price.cacheWrite).toBeUndefined();
		expect(glm.quality.coding).toBe(71.5); // inherited from z-ai/glm-5.3-flash
		expect(glm.tokenizer).toBe("Qwen"); // twin's tokenizer family
		expect(glm.contextLength).toBe(1048576); // the listing, not the twin
		expect(glm.supportsTools).toBe(true);
		expect(glm.supportsToolChoice).toBe(false);
		expect(glm.inputModalities).toContain("image");
		expect(glm.supportsReasoning).toBe(true);

		// `gpt-oss:120b` ↔ `openai/gpt-oss-120b`: the tag folds into the key.
		expect(ollamaTwinKey("gpt-oss:120b-cloud")).toBe("gpt-oss-120b");
		const oss = models.find((m) => m.slug === "ollama/gpt-oss:120b-cloud")!;
		expect(oss.quality.coding).toBe(30.4);

		// No twin ⇒ unscored, but still a model (trivial-eligible).
		const ds = models.find((m) => m.slug === "ollama/deepseek-v4-pro:0813-cloud")!;
		expect(ds.quality).toEqual({});
	});

	test("a pinned twin beats the name match", () => {
		const cfg: OllamaConfig = { ...OLLAMA, twins: { "deepseek-v4-pro": "moonshotai/kimi-k3" } };
		const ds = buildOllamaModels({ listings: listings(), openrouter: OR_MODELS, cfg, log }).find((m) => m.slug.startsWith("ollama/deepseek"))!;
		expect(ds.quality.coding).toBe(76.2);
	});

	test("includeLocal admits a daemon-local model only when priced", () => {
		const cfg: OllamaConfig = { ...OLLAMA, includeLocal: true, prices: { "nomic-embed-text": { input: 0, output: 0 } } };
		const models = buildOllamaModels({ listings: listings(), openrouter: OR_MODELS, cfg, log });
		expect(models.some((m) => m.slug === "ollama/nomic-embed-text:latest")).toBe(true);
	});

	test("ollama.com listings with no metadata fall back to the twin's context and capabilities", () => {
		const l = parseOllamaListing({ name: "glm-5.3-flash", model: "glm-5.3-flash", details: {} }, "ollama.com")!;
		const [m] = buildOllamaModels({ listings: [l], openrouter: OR_MODELS, cfg: OLLAMA, log });
		expect(m!.slug).toBe("ollama/glm-5.3-flash");
		expect(m!.contextLength).toBe(1_048_576);
		expect(m!.supportsTools).toBe(true);
		expect(m!.inputModalities).toContain("image");
	});
});

describe("createOllamaCatalog", () => {
	test("lists via /api/tags, fills ollama.com metadata via /api/show once per id, caches by TTL", async () => {
		const calls: string[] = [];
		const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
			calls.push(`${init?.method ?? "GET"} ${url}`);
			if (url.endsWith("/api/tags")) return Response.json({ models: [{ name: "glm-5.3-flash", model: "glm-5.3-flash", details: {} }] });
			if (url.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"], model_info: { "glm5_next.context_length": 4096 } });
			return new Response("nope", { status: 404 });
		};
		const cfg: OllamaConfig = { ...OLLAMA, baseUrl: "https://ollama.com/v1", apiKey: "k", catalogTtlMs: 60_000 };
		const src = createOllamaCatalog(cfg, log, fetchImpl);
		const first = await src.get(OR_MODELS);
		expect(first.map((m) => m.slug)).toEqual(["ollama/glm-5.3-flash"]);
		expect(first[0]!.contextLength).toBe(4096); // show beats the twin
		await src.get(OR_MODELS); // within TTL: no network
		expect(calls).toEqual(["GET https://ollama.com/api/tags", "POST https://ollama.com/api/show"]);
		src.invalidate();
		await src.get(OR_MODELS);
		expect(calls).toHaveLength(3); // re-listed, show cached
		expect(src.peek()).toHaveLength(1);
	});

	test("a built set is persisted, and a fresh source hydrates it before its first listing", async () => {
		const db = openDb(":memory:");
		const fetchImpl = async (url: string): Promise<Response> => Response.json({ models: url.endsWith("/api/tags") ? DAEMON_TAGS : [] });
		const src = createOllamaCatalog(OLLAMA, log, fetchImpl, db);
		const built = await src.get(OR_MODELS);
		expect(built.length).toBeGreaterThan(0);
		expect(loadOllamaCatalogCache(db).models.map((m) => m.slug)).toEqual(built.map((m) => m.slug));
		// A new process: peek() answers from disk with no network at all.
		const dead = async (): Promise<Response> => { throw new Error("offline"); };
		const again = createOllamaCatalog(OLLAMA, log, dead, db);
		expect(again.peek().map((m) => m.slug)).toEqual(built.map((m) => m.slug));
		db.close();
	});

	test("a failed listing keeps the previous set", async () => {
		let fail = false;
		const fetchImpl = async (url: string): Promise<Response> => {
			if (fail) throw new Error("boom");
			return Response.json({ models: url.endsWith("/api/tags") ? DAEMON_TAGS : [] });
		};
		const src = createOllamaCatalog({ ...OLLAMA, catalogTtlMs: 10 }, log, fetchImpl);
		expect((await src.get(OR_MODELS)).length).toBe(3);
		fail = true;
		await new Promise((r) => setTimeout(r, 60)); // well past the 10ms TTL, even on a loaded runner
		expect((await src.get(OR_MODELS)).length).toBe(3);
	});
});

describe("toOllamaBody", () => {
	test("strips OpenRouter-only fields, maps reasoning, drops cache_control, requests usage", () => {
		const body = toOllamaBody({
			model: "ollama/glm-5.3-flash:cloud",
			models: ["ollama/glm-5.3-flash:cloud", "ollama/gpt-oss:120b-cloud"],
			session_id: "s",
			tool_choice: "auto",
			stream: true,
			stream_options: { include_usage: false },
			reasoning: { effort: "xhigh" },
			messages: [
				{ role: "system", content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] },
				{ role: "user", content: "hi" },
			],
		});
		expect(body.model).toBe("glm-5.3-flash:cloud");
		expect(body.models).toBeUndefined();
		expect(body.session_id).toBeUndefined();
		expect(body.tool_choice).toBeUndefined();
		expect(body.reasoning).toBeUndefined();
		expect(body.reasoning_effort).toBe("high");
		expect(body.stream_options).toEqual({ include_usage: true });
		const sys = (body.messages as { content: unknown }[])[0]!.content as Record<string, unknown>[];
		expect(sys[0]).toEqual({ type: "text", text: "sys" });
	});

	test("reasoning off is simply omitted", () => {
		const body = toOllamaBody({ model: "ollama/x", reasoning: { enabled: false }, stream: false });
		expect(body.reasoning_effort).toBeUndefined();
		expect(body.stream_options).toBeUndefined();
	});
});

describe("classifyOllamaStatus", () => {
	test("402 is quota: retryable and account-level", () => {
		const e = classifyOllamaStatus(402, { error: { message: "out of credits" } });
		expect(e.kind).toBe("quota");
		expect(e.retryable).toBe(true);
	});
	test("429 is a rate limit; 401 is auth; 404 is model_unavailable", () => {
		expect(classifyOllamaStatus(429, {}).kind).toBe("rate_limit");
		expect(classifyOllamaStatus(401, {}).retryable).toBe(false);
		expect(classifyOllamaStatus(404, {}).kind).toBe("model_unavailable");
	});
	test("a 403 about billing is quota, any other 403 is moderation", () => {
		expect(classifyOllamaStatus(403, { error: "plan limit reached" }).kind).toBe("quota");
		expect(classifyOllamaStatus(403, { error: "content blocked" }).kind).toBe("moderation");
	});
});

describe("ollama client", () => {
	function cfgWith(o: Partial<OllamaConfig>): RouterConfig {
		return { ...BASE, ollama: { ...OLLAMA, ...o }, logLevel: "silent" };
	}
	const sse = (lines: string[]): Response =>
		new Response(new ReadableStream({
			start(c) {
				for (const l of lines) c.enqueue(new TextEncoder().encode(`data: ${l}\n\n`));
				c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
				c.close();
			},
		}), { status: 200, headers: { "content-type": "text/event-stream" } });

	test("dispatch strips the slug prefix on the way out and re-adds it on the served model", async () => {
		let sent: Record<string, unknown> | null = null;
		let auth: string | null = null;
		const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
			sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
			auth = (init?.headers as Record<string, string>).authorization ?? null;
			return sse([
				JSON.stringify({ id: "g1", model: "glm-5.3-flash:cloud", choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
				JSON.stringify({ id: "g1", model: "glm-5.3-flash:cloud", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
			]);
		});
		const client = createOllamaClient(cfgWith({ apiKey: "sk" }), fetchImpl);
		const d = await client.dispatch({ body: { model: "ollama/glm-5.3-flash:cloud", messages: [], stream: true }, sessionId: "s", signal: new AbortController().signal });
		const chunks = [];
		for await (const c of d.chunks) chunks.push(c);
		expect(sent!.model).toBe("glm-5.3-flash:cloud");
		expect(auth as string | null).toBe("Bearer sk"); // assigned inside the fetch closure; TS narrows the declaration
		const start = chunks[0]!.events.find((e) => e.type === "start");
		expect(start && start.type === "start" ? start.servedSlug : null).toBe("ollama/glm-5.3-flash:cloud");
		expect(chunks[0]!.raw.model).toBe("ollama/glm-5.3-flash:cloud");
		expect(await d.generationId()).toBe("g1");
		expect(client.available()).toBe(true);
	});

	test("a 402 trips the breaker for quotaCooldownMs and surfaces as a retryable quota error", async () => {
		const fetchImpl = (async (): Promise<Response> => Response.json({ error: { message: "credits exhausted" } }, { status: 402 }));
		const client = createOllamaClient(cfgWith({ quotaCooldownMs: 60_000 }), fetchImpl);
		let caught: unknown = null;
		try {
			await client.dispatch({ body: { model: "ollama/x", messages: [] }, sessionId: "s", signal: new AbortController().signal });
		} catch (e) {
			caught = e;
		}
		expect((caught as { kind: string }).kind).toBe("quota");
		expect((caught as { retryable: boolean }).retryable).toBe(true);
		expect(client.available()).toBe(false);
		expect(client.cooldownUntilMs()).toBeGreaterThan(Date.now());
		expect(client.lastTrip()?.kind).toBe("quota");
	});

	test("a 429 with a zero cooldown does not trip the breaker", async () => {
		const fetchImpl = (async (): Promise<Response> => new Response("slow down", { status: 429 }));
		const client = createOllamaClient(cfgWith({ rateLimitCooldownMs: 0, planCreditsUsd: 0 }), fetchImpl);
		await client.dispatch({ body: { model: "ollama/x", messages: [] }, sessionId: "s", signal: new AbortController().signal }).catch(() => {});
		expect(client.available()).toBe(true);
	});
});

describe("multi upstream + composite catalog", () => {
	const stub = (name: string, calls: string[]): UpstreamClient => ({
		dispatch: async (opts: DispatchOptions): Promise<Dispatch> => {
			calls.push(`${name}:${String(opts.body.model)}`);
			return { chunks: (async function* () {})(), generationId: async () => null };
		},
		complete: async (body) => {
			calls.push(`${name}:complete:${String(body.model)}`);
			return { text: "", costUsd: null };
		},
		fetchModels: async () => {
			calls.push(`${name}:models`);
			return [];
		},
		fetchModelsForUser: async () => [],
	});

	test("dispatch and complete go to the provider named by the slug prefix; catalog fetches stay on OpenRouter", async () => {
		const calls: string[] = [];
		const multi = createMultiUpstream(stub("or", calls), stub("ol", calls));
		const sig = new AbortController().signal;
		await multi.dispatch({ body: { model: "ollama/glm-5.3-flash:cloud" }, sessionId: "s", signal: sig });
		await multi.dispatch({ body: { model: "z-ai/glm-5.3-flash" }, sessionId: "s", signal: sig });
		await multi.complete({ model: "qwen/qwen3.7-flash" }, sig);
		await multi.fetchModels();
		expect(calls).toEqual(["ol:ollama/glm-5.3-flash:cloud", "or:z-ai/glm-5.3-flash", "or:complete:qwen/qwen3.7-flash", "or:models"]);
	});

	test("the merged snapshot hides Ollama models while the breaker is open and keeps its identity otherwise", async () => {
		const base: CatalogSnapshot = { models: OR_MODELS, fetchedAtMs: 1, keyScoped: true };
		const openrouter: CatalogSource = { get: async () => base, refresh: async () => base, peek: () => base, find: (s) => OR_MODELS.find((m) => m.slug === s) };
		const ollamaModels = buildOllamaModels({ listings: listings(), openrouter: OR_MODELS, cfg: OLLAMA, log });
		let available = true;
		const source = { get: async () => ollamaModels, peek: () => ollamaModels, invalidate: () => {} };
		const breaker = { available: () => available, cooldownUntilMs: () => null, lastTrip: () => null };
		const catalog = createCompositeCatalog(openrouter, source, breaker);

		const a = await catalog.get();
		expect(a.models.length).toBe(OR_MODELS.length + 3);
		expect(a.keyScoped).toBe(true);
		expect(await catalog.get()).toBe(a); // same inputs ⇒ same object (tier plan memo holds)
		expect(catalog.find("ollama/glm-5.3-flash:cloud")?.provider).toBe("ollama");
		expect(catalog.find("z-ai/glm-5.3-flash")?.provider).toBe("openrouter");

		available = false;
		const b = await catalog.get();
		expect(b.models.length).toBe(OR_MODELS.length);
		expect(b).not.toBe(a);
		expect(catalog.ollamaModels()).toHaveLength(3); // still known, just hidden
		expect(mergeSnapshots(base, []).models).toBe(base.models);
	});

	test("without an OpenRouter key only the Ollama models are served; the OpenRouter catalog still feeds metadata and lookups", async () => {
		const base: CatalogSnapshot = { models: OR_MODELS, fetchedAtMs: 1, keyScoped: false };
		const openrouter: CatalogSource = { get: async () => base, refresh: async () => base, peek: () => base, find: (s) => OR_MODELS.find((m) => m.slug === s) };
		const ollamaModels = buildOllamaModels({ listings: listings(), openrouter: OR_MODELS, cfg: OLLAMA, log });
		let available = true;
		let keyed = false;
		const source = { get: async () => ollamaModels, peek: () => ollamaModels, invalidate: () => {} };
		const breaker = { available: () => available, cooldownUntilMs: () => null, lastTrip: () => null };
		const catalog = createCompositeCatalog(openrouter, source, breaker, { costBias: 1, biasUntilUsage: 1, usage: NO_USAGE, serveOpenRouter: () => keyed });

		const a = await catalog.get();
		expect(a.models.map((m) => m.provider)).toEqual(["ollama", "ollama", "ollama"]);
		expect(a.fetchedAtMs).toBe(1);
		expect(await catalog.get()).toBe(a); // memoised while nothing changes
		expect(catalog.find("z-ai/glm-5.3-flash")?.provider).toBe("openrouter"); // lookups (served-model attribution) still resolve
		expect(a.models[0]?.quality).toEqual(OR_MODELS.find((m) => m.slug === "z-ai/glm-5.3-flash")?.quality); // twin metadata borrowed

		available = false;
		expect((await catalog.get()).models).toEqual([]); // nothing can serve: breaker open, no key
		available = true;
		keyed = true; // a hot-reloaded key brings OpenRouter back without a restart
		const c = await catalog.get();
		expect(c.models.length).toBe(OR_MODELS.length + 3);
		expect(c).not.toBe(a);
	});
});

describe("selection over a mixed catalog", () => {
	const req = parseChatRequest(
		{
			model: "auto",
			tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {} } } }],
			messages: [{ role: "user", content: "rename the helper" }],
		},
		new Headers(),
	);
	const features = extractFeatures(req, 50_000);
	const ollamaModels = buildOllamaModels({ listings: listings(), openrouter: OR_MODELS, cfg: OLLAMA, log });
	const snapshot: CatalogSnapshot = { models: [...OR_MODELS, ...ollamaModels], fetchedAtMs: 1 };

	function build(costBias: number) {
		return buildCandidates({
			req,
			features,
			tier: "simple",
			task: "coding",
			snapshot,
			ledger: null,
			cfg: { ...BASE, adaptiveTierFloors: false, ollama: { ...OLLAMA, costBias } },
			expectedCompletionTokens: 512,
			warmSlug: null,
		});
	}

	test("Ollama models rank alongside OpenRouter ones on the same economics", () => {
		const { candidates } = build(1);
		const slugs = candidates.map((c) => c.model.slug);
		expect(slugs).toContain("ollama/glm-5.3-flash:cloud");
		expect(slugs).toContain("z-ai/glm-5.3-flash");
		// $0.07/M on OpenRouter beats $0.15/M on Ollama at list price.
		expect(slugs.indexOf("z-ai/glm-5.3-flash")).toBeLessThan(slugs.indexOf("ollama/glm-5.3-flash:cloud"));
	});

	test("costBias below 1 tilts the ranking toward Ollama and says so", () => {
		const { candidates } = build(0.25);
		const slugs = candidates.map((c) => c.model.slug);
		expect(slugs.indexOf("ollama/glm-5.3-flash:cloud")).toBeLessThan(slugs.indexOf("z-ai/glm-5.3-flash"));
		expect(candidates.find((c) => c.model.slug === "ollama/glm-5.3-flash:cloud")!.reasons.some((r) => r.startsWith("provider bias"))).toBe(true);
	});
});

describe("ollama plan usage (credit-aware bias)", () => {
	// The shape ollama.com/api/usage returned on 2026-09-06 for a Pro account.
	const PAYLOAD = {
		activity: { cost: "0.00000", period: { type: "last_4_weeks", starting_at: "2026-08-10T00:00:00Z", ending_at: "2026-09-06T04:57:02Z" }, models: [] },
		limits: { monthly: { usage: 0, models: [{ name: "glm-5.3", request_count: 1 }, { name: "nemotron-3-super", request_count: 2 }] } },
	};

	test("parses the observed payload", () => {
		const u = parseOllamaUsage(PAYLOAD, 5)!;
		expect(u.monthlyUsedFraction).toBe(0);
		expect(u.monthlyUsageRaw).toBe(0);
		expect(u.activityCostUsd).toBe(0);
		expect(u.requestsThisMonth).toBe(3);
		expect(u.fetchedAtMs).toBe(5);
		expect(parseOllamaUsage({ unrelated: true })).toBeNull();
		expect(parseOllamaUsage("nope")).toBeNull();
	});

	test("infers the usage scale: percent above 1, fraction at or below 1, exactly 1 read as 1%", () => {
		expect(usageFraction(0)).toBe(0);
		expect(usageFraction(37)).toBeCloseTo(0.37, 6);
		expect(usageFraction(250)).toBe(1);
		expect(usageFraction(0.42)).toBeCloseTo(0.42, 6);
		expect(usageFraction(1)).toBeCloseTo(0.01, 6);
	});

	test("the bias holds under the threshold, switches to list price above it, and stays on when usage is unknown", () => {
		const at = (f: number | null) => (f === null ? null : { monthlyUsedFraction: f, monthlyUsageRaw: f, activityCostUsd: null, requestsThisMonth: 0, plan: null, fetchedAtMs: 0 });
		expect(effectiveOllamaBias(0.1, 0.9, at(0.5))).toBe(0.1);
		expect(effectiveOllamaBias(0.1, 0.9, at(0.9))).toBe(1);
		expect(effectiveOllamaBias(0.1, 0.9, at(1))).toBe(1);
		expect(effectiveOllamaBias(0.1, 0.9, at(null))).toBe(0.1);
		expect(effectiveOllamaBias(0.1, 0.9, null)).toBe(0.1);
		expect(effectiveOllamaBias(1, 0.9, at(0))).toBe(1);
	});

	test("the source polls on its interval, keeps the last reading on failure, and is inert without a key", async () => {
		let calls = 0;
		let fail = false;
		const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
			expect((init?.headers as Record<string, string>).authorization).toBe("Bearer k");
			// The plan rides along on every poll: POST /api/me (GET answers 405).
			if (url === "https://ollama.com/api/me") {
				expect(init?.method).toBe("POST");
				return Response.json({ ID: "x", Email: "e", Plan: "Pro" });
			}
			calls++;
			expect(url).toBe("https://ollama.com/api/usage");
			if (fail) return new Response("down", { status: 503 });
			return Response.json({ ...PAYLOAD, limits: { monthly: { usage: 42, models: [] } } });
		};
		const src = createOllamaUsageSource({ apiKey: "k", pollMs: 20, timeoutMs: 1000, log, fetchImpl });
		expect(src.peek()).toBeNull();
		expect((await src.get())?.monthlyUsedFraction).toBeCloseTo(0.42, 6);
		expect(src.peek()?.plan).toBe("pro");
		await src.get();
		expect(calls).toBe(1); // within the interval
		fail = true;
		await new Promise((r) => setTimeout(r, 120)); // well past the 20ms poll interval
		expect((await src.get())?.monthlyUsedFraction).toBeCloseTo(0.42, 6); // last good reading survives a 503
		expect(calls).toBe(2);
		expect(createOllamaUsageSource({ apiKey: "", pollMs: 50, timeoutMs: 1000, log, fetchImpl })).toBe(NO_USAGE);
	});

	test("the composite snapshot carries the live bias and re-merges when it flips", async () => {
		const base: CatalogSnapshot = { models: OR_MODELS, fetchedAtMs: 1, keyScoped: true };
		const openrouter: CatalogSource = { get: async () => base, refresh: async () => base, peek: () => base, find: (s) => OR_MODELS.find((m) => m.slug === s) };
		const ollamaModels = buildOllamaModels({ listings: listings(), openrouter: OR_MODELS, cfg: OLLAMA, log });
		const source = { get: async () => ollamaModels, peek: () => ollamaModels, invalidate: () => {} };
		const breaker = { available: () => true, cooldownUntilMs: () => null, lastTrip: () => null };
		let used = 0.2;
		const usage = { get: async () => ({ monthlyUsedFraction: used, monthlyUsageRaw: used * 100, activityCostUsd: null, requestsThisMonth: 0, plan: null, fetchedAtMs: 0 }), peek: () => ({ monthlyUsedFraction: used, monthlyUsageRaw: used * 100, activityCostUsd: null, requestsThisMonth: 0, plan: null, fetchedAtMs: 0 }), calibration: () => null };
		const catalog = createCompositeCatalog(openrouter, source, breaker, { costBias: 0.1, biasUntilUsage: 0.9, usage });

		const a = await catalog.get();
		expect(a.providerBias).toEqual({ ollama: 0.1 });
		expect(catalog.ollamaBias()).toBe(0.1);
		expect(await catalog.get()).toBe(a);

		// Candidate scoring reads the bias off the snapshot, not the config.
		const req = parseChatRequest({ model: "auto", tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object", properties: {} } } }], messages: [{ role: "user", content: "rename the helper" }] }, new Headers());
		const features = extractFeatures(req, 50_000);
		const rank = (snap: CatalogSnapshot) => buildCandidates({ req, features, tier: "simple", task: "coding", snapshot: snap, ledger: null, cfg: { ...BASE, adaptiveTierFloors: false, ollama: { ...OLLAMA, costBias: 1 } }, expectedCompletionTokens: 512, warmSlug: null }).candidates.map((c) => c.model.slug);
		expect(rank(a).indexOf("ollama/glm-5.3-flash:cloud")).toBeLessThan(rank(a).indexOf("z-ai/glm-5.3-flash"));

		used = 0.95; // credits nearly gone: list price
		const b = await catalog.get();
		expect(b).not.toBe(a);
		expect(b.providerBias).toEqual({ ollama: 1 });
		expect(rank(b).indexOf("z-ai/glm-5.3-flash")).toBeLessThan(rank(b).indexOf("ollama/glm-5.3-flash:cloud"));
	});
});


describe("ollamaMeter", () => {
	const usage = (plan: string | null, frac: number | null = 0.104) => ({ monthlyUsedFraction: frac, monthlyUsageRaw: frac, activityCostUsd: 0, requestsThisMonth: 1250, plan, fetchedAtMs: 1 });

	test("a detected plan applies its published allowance: 10.4% of Pro's $60 is the $6.24 ollama.com shows", () => {
		expect(ollamaMeter(usage("pro"), 0)).toEqual({ usedUsd: 6.24, creditsUsd: 60, plan: "pro" });
		expect(ollamaMeter(usage("max"), 0)).toEqual({ usedUsd: 31.2, creditsUsd: 300, plan: "max" });
	});

	test("a configured override wins over the detected plan; an unknown plan without one yields no meter", () => {
		expect(ollamaMeter(usage("pro"), 100)).toEqual({ usedUsd: 10.4, creditsUsd: 100, plan: "pro" });
		expect(ollamaMeter(usage("team"), 0)).toBeNull();
		expect(ollamaMeter(usage("team"), 500)?.creditsUsd).toBe(500);
		expect(ollamaMeter(usage(null), 0)).toBeNull();
	});

	test("no usage reading yields no meter", () => {
		expect(ollamaMeter(null, 60)).toBeNull();
		expect(ollamaMeter(usage("pro", null), 60)).toBeNull();
	});

	test("parseOllamaPlan reads the account payload case-insensitively", () => {
		expect(parseOllamaPlan({ ID: "x", Plan: "Pro" })).toBe("pro");
		expect(parseOllamaPlan({ plan: "max" })).toBe("max");
		expect(parseOllamaPlan({ Plan: "" })).toBeNull();
		expect(parseOllamaPlan("nope")).toBeNull();
	});
});

describe("ollama calibration", () => {
	const s = (h: number, meterUsd: number, ledgerUsd: number) => ({ atMs: h * 3_600_000, meterUsd, ledgerUsd });

	test("compares the newest reading with the oldest since the last meter reset", () => {
		// Ledger estimated $4 over the span; the meter moved $5 ⇒ estimates run 20% low.
		const c = calibrationFrom([s(0, 10, 20), s(12, 12.5, 22), s(24, 15, 24)])!;
		expect(c.factor).toBeCloseTo(1.25, 6);
		expect(c.spanHours).toBe(24);
		expect(c.samples).toBe(3);
		// A billing-cycle reset (meter drops) ends the span.
		const reset = calibrationFrom([s(0, 50, 40), s(12, 0.5, 41), s(24, 1.5, 42)])!;
		expect(reset.samples).toBe(2);
		expect(reset.factor).toBeCloseTo(1, 6);
	});

	test("needs enough metered spend to mean anything, and clamps to 0.5–2×", () => {
		expect(calibrationFrom([s(0, 1, 1), s(1, 1.03, 1.2)])).toBeNull(); // meter moved less than its resolution
		expect(calibrationFrom([s(0, 1, 1), s(1, 2, 1.3)])).toBeNull(); // ledger moved less than $0.50
		expect(calibrationFrom([s(0, 0, 0), s(1, 10, 1)])!.factor).toBe(CALIBRATION_MAX_FACTOR);
		expect(calibrationFrom([s(0, 0, 0), s(1, 0.1, 10)])!.factor).toBe(CALIBRATION_MIN_FACTOR);
		expect(calibrationFrom([s(0, 1, 1)])).toBeNull();
	});

	test("the source records a sample per poll and exposes the calibration", async () => {
		const db = openDb(":memory:");
		let ledgerUsd = 1;
		let frac = 0.1;
		const fetchImpl = async (url: string): Promise<Response> => {
			if (url.endsWith("/api/me")) return Response.json({ Plan: "pro" });
			return Response.json({ limits: { monthly: { usage: frac, models: [] } } });
		};
		const src = createOllamaUsageSource({ apiKey: "k", pollMs: 5, timeoutMs: 1000, log, fetchImpl, calibration: { db, ledgerUsd: () => ledgerUsd, planCreditsOverrideUsd: 0 } });
		await src.get(); // meter $6 (10% of $60), ledger $1
		expect(src.calibration()).toBeNull(); // one sample
		await new Promise((r) => setTimeout(r, 20));
		ledgerUsd = 3; // ledger +$2
		frac = 0.15; // meter +$3
		await src.get();
		const c = src.calibration()!;
		expect(c.factor).toBeCloseTo(1.5, 6);
		expect((db.query("SELECT COUNT(*) n FROM ollama_meter_samples").get() as { n: number }).n).toBe(2);
		db.close();
	});
});
