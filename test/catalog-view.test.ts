import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import { buildUpstreamModels } from "../src/catalog/static-catalog.ts";
import type { CatalogModel } from "../src/catalog/types.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { completeUpstreamEntry } from "../src/config/upstreams.ts";
import { catalogView, vendorOf, type CatalogView, type CatalogViewModel } from "../src/server/catalog-view.ts";
import { startServer, type StartedServer } from "../src/server/http.ts";
import { openDb } from "../src/util/sqlite.ts";

/**
 * The catalog as data for a front door's governance views: every model the
 * router knows, and under a policy whether a turn could reach it and why not.
 * Pinned over the pure view and over `GET /v1/router/catalog`, which judges
 * with the router's own matcher — the same globs, the same order as
 * `buildCandidates`, a pin that only bites when the pinned model is in.
 */

const FIXTURE = (await Bun.file("test/fixtures/openrouter-models.json").json()) as { data: unknown[] };

function model(over: Partial<CatalogModel> & { slug: string }): CatalogModel {
	return {
		provider: "openrouter",
		canonicalSlug: `${over.slug}-20260101`,
		name: over.slug,
		contextLength: 200_000,
		supportsTools: true,
		supportsReasoning: false,
		reasoningMandatory: false,
		supportsToolChoice: true,
		inputModalities: ["text"],
		price: { prompt: 0.000003, completion: 0.000015 },
		priceTiers: [],
		quality: { intelligence: 60 },
		tokenizer: "Claude",
		isFree: false,
		createdAtMs: 0,
		author: over.slug.split("/")[0] ?? "",
		...over,
	};
}

const vllm = completeUpstreamEntry({ id: "vllm", kind: "openai", baseUrl: "http://vllm:8000/v1", apiKey: "", models: [{ id: "meta-llama/Llama-3", input: 0, output: 0, contextLength: 8_000 }] });
const azure = completeUpstreamEntry({ id: "azure-eu", kind: "azure", enabled: false, baseUrl: "https://r.openai.azure.com", apiKey: "k", models: [{ id: "gpt-4o-deploy", input: 2.5, output: 10, cachedInput: 1.25 }] });

const MODELS: CatalogModel[] = [
	model({ slug: "openai/gpt-5", quality: { intelligence: 70, coding: 72 }, maxCompletionTokens: 128_000, price: { prompt: 0.00000125, completion: 0.00001, cacheRead: 0.000000125 } }),
	model({ slug: "anthropic/claude-sonnet-5", supportsReasoning: true }),
	model({ slug: "anthropic/claude-haiku-5" }),
	model({ slug: "anthropic/claude-opus-5:batch" }),
	model({ slug: "liquid/lfm:free", isFree: true, price: { prompt: 0, completion: 0 } }),
	model({ slug: "tencent/translator", supportsTools: false }),
	model({ slug: "ollama/glm-5.3-flash", provider: "ollama", author: "ollama" }),
	...buildUpstreamModels(vllm, []),
	...buildUpstreamModels(azure, []),
];

const served = () => null;
const bySlug = (view: CatalogView): Map<string, CatalogViewModel> => new Map(view.models.map((m) => [m.slug, m]));

describe("catalogView", () => {
	test("sorted by slug, prices per million, vendor per slug, and no verdict without a policy", () => {
		const view = catalogView({ models: MODELS, fetchedAtMs: 123, unserved: served });
		expect(view.fetchedAtMs).toBe(123);
		expect(view.models.map((m) => m.slug)).toEqual([...MODELS.map((m) => m.slug)].sort());
		const gpt = bySlug(view).get("openai/gpt-5")!;
		expect(gpt).toEqual({
			slug: "openai/gpt-5",
			canonicalSlug: "openai/gpt-5-20260101",
			name: "openai/gpt-5",
			provider: "openrouter",
			vendor: "openai",
			contextLength: 200_000,
			maxCompletionTokens: 128_000,
			supportsTools: true,
			supportsReasoning: false,
			reasoningMandatory: false,
			inputModalities: ["text"],
			price: { prompt: 1.25, completion: 10, cacheRead: 0.125 },
			quality: { intelligence: 70, coding: 72 },
			isFree: false,
		});
		expect("admitted" in gpt).toBe(false);
		expect("reason" in gpt).toBe(false);
		expect("maxCompletionTokens" in bySlug(view).get("anthropic/claude-haiku-5")!).toBe(false);
		// A named upstream's prices are per million already; they round-trip.
		expect(bySlug(view).get("azure-eu/gpt-4o-deploy")!.price).toEqual({ prompt: 2.5, completion: 10, cacheRead: 1.25 });
	});

	test("vendor: the namespace before the first slash; a named upstream's model id may carry its own", () => {
		expect(vendorOf({ slug: "anthropic/claude-sonnet-5", provider: "openrouter" })).toBe("anthropic");
		expect(vendorOf({ slug: "ollama/glm-5.3-flash", provider: "ollama" })).toBe("ollama");
		expect(vendorOf({ slug: "vllm/meta-llama/Llama-3", provider: "vllm" })).toBe("meta-llama");
		expect(vendorOf({ slug: "azure-eu/gpt-4o-deploy", provider: "azure-eu" })).toBe("azure-eu");
		const view = bySlug(catalogView({ models: MODELS, fetchedAtMs: 0, unserved: served }));
		expect(view.get("vllm/meta-llama/Llama-3")!.vendor).toBe("meta-llama");
		expect(view.get("azure-eu/gpt-4o-deploy")!.vendor).toBe("azure-eu");
	});

	test("an empty policy still judges: the router's own filters and the upstream's state", () => {
		const unserved = (p: string) => (p === "azure-eu" ? "upstream azure-eu is disabled" : null);
		const view = bySlug(catalogView({ models: MODELS, fetchedAtMs: 0, verdict: { filters: DEFAULT_CONFIG.filters }, unserved }));
		expect(view.get("openai/gpt-5")).toMatchObject({ admitted: true });
		expect("reason" in view.get("openai/gpt-5")!).toBe(false);
		expect(view.get("anthropic/claude-opus-5:batch")).toMatchObject({ admitted: false, reason: "built-in deny: floating alias, batch endpoint, stealth, or meta-router" });
		expect(view.get("liquid/lfm:free")).toMatchObject({ admitted: false, reason: "free models excluded (filters.includeFree)" });
		expect(view.get("tencent/translator")).toMatchObject({ admitted: false, reason: "no tool support (filters.requireToolSupport)" });
		expect(view.get("azure-eu/gpt-4o-deploy")).toMatchObject({ admitted: false, reason: "upstream azure-eu is disabled" });
		// A $0 named-upstream model is self-hosted, never "free".
		expect(view.get("vllm/meta-llama/Llama-3")).toMatchObject({ admitted: true });
		// Filters relaxed: the same models come in.
		const open = bySlug(catalogView({ models: MODELS, fetchedAtMs: 0, verdict: { filters: { ...DEFAULT_CONFIG.filters, includeFree: true, requireToolSupport: false } }, unserved: served }));
		expect(open.get("liquid/lfm:free")!.admitted).toBe(true);
		expect(open.get("tencent/translator")!.admitted).toBe(true);
	});

	test("allow list, deny glob and pin, in the order a turn applies them", () => {
		const filters = { ...DEFAULT_CONFIG.filters, allow: ["anthropic/*", "vllm/*"], deny: ["*haiku*"] };
		const view = bySlug(catalogView({ models: MODELS, fetchedAtMs: 0, verdict: { filters }, unserved: served }));
		expect(view.get("openai/gpt-5")).toMatchObject({ admitted: false, reason: "not in the allow list" });
		expect(view.get("anthropic/claude-haiku-5")).toMatchObject({ admitted: false, reason: "denied by *haiku*" });
		expect(view.get("anthropic/claude-sonnet-5")).toMatchObject({ admitted: true });
		expect(view.get("vllm/meta-llama/Llama-3")).toMatchObject({ admitted: true });
		// A pin keeps every other model out.
		const pinned = bySlug(catalogView({ models: MODELS, fetchedAtMs: 0, verdict: { filters, pin: "anthropic/claude-sonnet-5" }, unserved: served }));
		expect(pinned.get("anthropic/claude-sonnet-5")).toMatchObject({ admitted: true });
		expect(pinned.get("vllm/meta-llama/Llama-3")).toMatchObject({ admitted: false, reason: "pinned to anthropic/claude-sonnet-5" });
		expect(pinned.get("openai/gpt-5")).toMatchObject({ admitted: false, reason: "not in the allow list" }); // the earlier reason stands
		// A pin the filters drop is ignored, as select ignores it: nothing else is pinned out.
		const dropped = bySlug(catalogView({ models: MODELS, fetchedAtMs: 0, verdict: { filters, pin: "anthropic/claude-haiku-5" }, unserved: served }));
		expect(dropped.get("anthropic/claude-haiku-5")).toMatchObject({ admitted: false, reason: "denied by *haiku*" });
		expect(dropped.get("anthropic/claude-sonnet-5")).toMatchObject({ admitted: true });
		// So is a pin naming no model.
		expect(bySlug(catalogView({ models: MODELS, fetchedAtMs: 0, verdict: { filters, pin: "nobody/here" }, unserved: served })).get("anthropic/claude-sonnet-5")!.admitted).toBe(true);
	});
});

describe("GET /v1/router/catalog", () => {
	let handle: StartedServer;
	let empty: StartedServer;
	const dir = mkdtempSync(join(tmpdir(), "amr-catalog-"));
	const FETCHED = Date.now() - 60_000;
	beforeAll(() => {
		const cfg = structuredClone(DEFAULT_CONFIG);
		cfg.server.host = "127.0.0.1";
		cfg.server.port = 0;
		cfg.server.apiKey = "k";
		cfg.logLevel = "silent";
		// Nothing reaches the network: the catalog is served from its on-disk
		// cache (within TTL), the periodic refresh is off, and the base URL is dead.
		cfg.openrouter.apiKey = "sk-test";
		cfg.openrouter.baseUrl = "http://127.0.0.1:9/api/v1";
		cfg.openrouter.catalogRefreshMs = 0;
		cfg.benchmarks.enabled = false;
		cfg.upstreams = [vllm, azure];
		cfg.ledger.path = join(dir, "router.db");
		const db = openDb(cfg.ledger.path);
		db.run("INSERT INTO catalog_cache (id, payload, fetched_at_ms, etag, key_scoped) VALUES (1, ?, ?, NULL, 0)", [JSON.stringify(FIXTURE.data), FETCHED]);
		db.close();
		handle = startServer(cfg);
		const bare = structuredClone(cfg);
		bare.upstreams = [];
		bare.ledger.path = join(dir, "empty.db");
		empty = startServer(bare);
	});
	afterAll(async () => {
		await handle.stop();
		await empty.stop();
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* Windows may hold the WAL briefly */
		}
	});
	const get = (path: string, port = handle.server.port) => fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: "Bearer k" } });
	const view = async (path: string): Promise<Map<string, CatalogViewModel>> => bySlug((await (await get(path)).json()) as CatalogView);

	test("the catalog as data: authenticated, sorted, every upstream's models, no verdict without a policy", async () => {
		expect((await fetch(`http://127.0.0.1:${handle.server.port}/v1/router/catalog`)).status).toBe(401);
		const res = await get("/v1/router/catalog");
		expect(res.status).toBe(200);
		const body = (await res.json()) as CatalogView;
		expect(body.fetchedAtMs).toBe(FETCHED);
		const slugs = body.models.map((m) => m.slug);
		expect(slugs).toEqual([...slugs].sort());
		// Every OpenRouter model the fixture normalises to, plus both named upstreams' — the disabled one too.
		expect(slugs).toHaveLength(FIXTURE.data.filter((m) => normalizeCatalogModel(m) !== null).length + 2);
		const models = bySlug(body);
		const opus = models.get("anthropic/claude-opus-5")!;
		const raw = normalizeCatalogModel(FIXTURE.data.find((m) => (m as { id: string }).id === "anthropic/claude-opus-5"))!;
		expect(opus).toEqual({
			slug: "anthropic/claude-opus-5",
			canonicalSlug: raw.canonicalSlug,
			name: raw.name,
			provider: "openrouter",
			vendor: "anthropic",
			contextLength: raw.contextLength,
			maxCompletionTokens: 128_000,
			supportsTools: true,
			supportsReasoning: raw.supportsReasoning,
			reasoningMandatory: raw.reasoningMandatory,
			inputModalities: raw.inputModalities,
			price: { prompt: 5, completion: raw.price.completion * 1e6, cacheRead: 0.5, ...(raw.price.cacheWrite === undefined ? {} : { cacheWrite: raw.price.cacheWrite * 1e6 }) },
			quality: raw.quality,
			isFree: false,
		});
		expect(models.get("vllm/meta-llama/Llama-3")).toMatchObject({ provider: "vllm", vendor: "meta-llama", contextLength: 8_000 });
		expect(models.get("azure-eu/gpt-4o-deploy")).toMatchObject({ provider: "azure-eu", vendor: "azure-eu", price: { prompt: 2.5, completion: 10, cacheRead: 1.25 } });
		expect(body.models.some((m) => "admitted" in m || "reason" in m)).toBe(false);
	});

	test("judged under a policy: allow, deny, pin, the router's filters and the upstream's state", async () => {
		const allowed = await view(`/v1/router/catalog?policy=${encodeURIComponent(JSON.stringify({ allow: ["anthropic/*", "azure-eu/*"], deny: ["anthropic/claude-opus-5"], maxTier: "simple" }))}`);
		expect(allowed.get("anthropic/claude-sonnet-4.5")).toMatchObject({ admitted: true });
		expect(allowed.get("anthropic/claude-opus-5")).toMatchObject({ admitted: false, reason: "denied by anthropic/claude-opus-5" });
		expect(allowed.get("anthropic/claude-opus-5:batch")).toMatchObject({ admitted: false, reason: "built-in deny: floating alias, batch endpoint, stealth, or meta-router" });
		expect(allowed.get("openai/gpt-5.6-luna")).toMatchObject({ admitted: false, reason: "not in the allow list" });
		expect(allowed.get("azure-eu/gpt-4o-deploy")).toMatchObject({ admitted: false, reason: "upstream azure-eu is disabled" });
		// The configured deny list stays in force under a policy's, as applyRequestPolicy adds rather than replaces.
		const pinned = await view(`/v1/router/catalog?policy=${encodeURIComponent(JSON.stringify({ pin: "vllm/meta-llama/Llama-3" }))}`);
		expect(pinned.get("vllm/meta-llama/Llama-3")).toMatchObject({ admitted: true });
		expect(pinned.get("anthropic/claude-sonnet-4.5")).toMatchObject({ admitted: false, reason: "pinned to vllm/meta-llama/Llama-3" });
		expect(pinned.get("tencent/hy-mt2-1.8b")).toMatchObject({ admitted: false, reason: "no tool support (filters.requireToolSupport)" });
		expect(pinned.get("liquid/lfm-2.5-2.6b:free")).toMatchObject({ admitted: false, reason: "free models excluded (filters.includeFree)" });
		// `{}` is a policy too: every model carries a verdict.
		const plain = await view("/v1/router/catalog?policy=%7B%7D");
		expect(plain.get("anthropic/claude-sonnet-4.5")).toMatchObject({ admitted: true });
		expect([...plain.values()].every((m) => typeof m.admitted === "boolean")).toBe(true);
	});

	test("a malformed policy is a 400 in the wire error shape", async () => {
		for (const bad of ["%7B", "not-json", "%5B%5D", "null", "1"]) {
			const res = await get(`/v1/router/catalog?policy=${bad}`);
			expect(res.status).toBe(400);
			const body = (await res.json()) as { error: { message: string; type: string; code: string } };
			expect(body.error.code).toBe("invalid_request_error");
			expect(body.error.message).toContain("policy");
		}
	});

	test("before the first fetch: empty, never a wait", async () => {
		expect((await (await get("/v1/router/catalog", empty.server.port)).json()) as CatalogView).toEqual({ fetchedAtMs: 0, models: [] });
		expect((await (await get("/v1/router/catalog?policy=%7B%7D", empty.server.port)).json()) as CatalogView).toEqual({ fetchedAtMs: 0, models: [] });
	});
});
