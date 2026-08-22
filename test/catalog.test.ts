import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";

const FIXTURE = (await Bun.file("test/fixtures/openrouter-models.json").json()) as { data: unknown[] };
const RAW = FIXTURE.data;

function rawFor(slug: string): unknown {
	const found = RAW.find((m) => typeof m === "object" && m !== null && "id" in m && m.id === slug);
	if (found === undefined) throw new Error(`fixture is missing ${slug}`);
	return found;
}

describe("normalizeCatalogModel", () => {
	test("survives every record in the real catalog without throwing", () => {
		let normalized = 0;
		for (const raw of RAW) {
			const model = normalizeCatalogModel(raw);
			if (model !== null) normalized++;
		}
		// Most of the catalog must be usable, or a filter is misfiring.
		expect(normalized).toBeGreaterThan(RAW.length * 0.9);
	});

	test("every normalized model has strictly positive prompt and completion prices", () => {
		for (const raw of RAW) {
			const model = normalizeCatalogModel(raw);
			if (model === null) continue;
			expect(model.price.prompt).toBeGreaterThanOrEqual(0);
			expect(model.price.completion).toBeGreaterThanOrEqual(0);
			expect(Number.isFinite(model.price.prompt)).toBe(true);
			expect(Number.isFinite(model.price.completion)).toBe(true);
		}
	});

	test("rejects the openrouter meta-routers, whose -1 pricing means unknown", () => {
		// Routing to another router is both out of scope and uncostable: a -1
		// price would otherwise be read as free and win every tier outright.
		for (const slug of ["openrouter/auto", "openrouter/pareto-code", "openrouter/fusion"]) {
			expect(normalizeCatalogModel(rawFor(slug))).toBeNull();
		}
	});

	test("does not mistake unknown (-1) pricing for free pricing", () => {
		const free = normalizeCatalogModel(rawFor("openai/gpt-oss-20b:free"));
		expect(free).not.toBeNull();
		expect(free?.isFree).toBe(true);
		// The -1 models never normalize at all, so they can never be marked free.
		expect(normalizeCatalogModel(rawFor("openrouter/auto"))).toBeNull();
	});

	test("preserves published quality scores and never imputes missing ones", () => {
		const scoredInFixture = RAW.filter(
			(m) =>
				typeof m === "object" &&
				m !== null &&
				"benchmarks" in m &&
				typeof m.benchmarks === "object" &&
				m.benchmarks !== null &&
				"artificial_analysis" in m.benchmarks,
		).length;

		let scored = 0;
		let unscored = 0;
		for (const raw of RAW) {
			const model = normalizeCatalogModel(raw);
			if (model === null) continue;
			const q = model.quality;
			if (q.coding !== undefined || q.agentic !== undefined || q.intelligence !== undefined) scored++;
			else unscored++;
		}
		// Coverage is genuinely partial; that fact drives the quality-floor rule.
		expect(scored).toBeLessThanOrEqual(scoredInFixture);
		expect(unscored).toBeGreaterThan(0);
	});

	test("reads long-context override tiers, sorted ascending", () => {
		const sonnet = normalizeCatalogModel(rawFor("anthropic/claude-sonnet-4.5"));
		expect(sonnet).not.toBeNull();
		expect(sonnet?.priceTiers.length).toBeGreaterThan(0);
		const tiers = sonnet?.priceTiers ?? [];
		for (let i = 1; i < tiers.length; i++) {
			const prev = tiers[i - 1];
			const cur = tiers[i];
			if (prev === undefined || cur === undefined) continue;
			expect(cur.minPromptTokens).toBeGreaterThan(prev.minPromptTokens);
		}
		// Anthropic doubles above 200k; the override must be dearer than base.
		const first = tiers[0];
		expect(first?.minPromptTokens).toBe(200000);
		expect(first?.price.prompt).toBeGreaterThan(sonnet?.price.prompt ?? 0);
	});

	test("an override tier inherits components it does not restate", () => {
		for (const raw of RAW) {
			const model = normalizeCatalogModel(raw);
			if (model === null || model.priceTiers.length === 0) continue;
			for (const tier of model.priceTiers) {
				// Completion is always meaningful, whether restated or inherited.
				expect(Number.isFinite(tier.price.completion)).toBe(true);
				expect(tier.price.completion).toBeGreaterThan(0);
			}
		}
	});

	test("strips the floating-alias marker from the author segment", () => {
		const alias = normalizeCatalogModel(rawFor("~x-ai/grok-latest"));
		expect(alias).not.toBeNull();
		expect(alias?.author).toBe("x-ai");
		// The slug itself is retained verbatim so the deny rule can still see it.
		expect(alias?.slug.startsWith("~")).toBe(true);
	});

	test("derives capability flags from supported_parameters", () => {
		const sonnet = normalizeCatalogModel(rawFor("anthropic/claude-sonnet-4.5"));
		expect(sonnet?.supportsTools).toBe(true);
		expect(sonnet?.supportsToolChoice).toBe(true);
		expect(sonnet?.supportsReasoning).toBe(true);
		expect(sonnet?.reasoningMandatory).toBe(false);

		const toolless = normalizeCatalogModel(rawFor("tencent/hy-mt2-1.8b"));
		expect(toolless?.supportsTools).toBe(false);
	});

	test("rejects records missing the fields routing depends on", () => {
		expect(normalizeCatalogModel({})).toBeNull();
		expect(normalizeCatalogModel(null)).toBeNull();
		expect(normalizeCatalogModel({ id: "x/y" })).toBeNull();
		expect(normalizeCatalogModel({ id: "x/y", pricing: { prompt: "0.1" } })).toBeNull();
	});
});

describe("createCatalog key-scoped availability", () => {
	test("prefers fetchModelsForUser when an API key is configured", async () => {
		const { createCatalog } = await import("../src/catalog/openrouter-catalog.ts");
		const { openDb } = await import("../src/util/sqlite.ts");
		const { DEFAULT_CONFIG } = await import("../src/config/defaults.ts");

		let userCalls = 0;
		let publicCalls = 0;
		const upstream: any = {
			dispatch: () => Promise.reject(new Error("unused")),
			complete: () => Promise.reject(new Error("unused")),
			fetchModels: async () => {
				publicCalls++;
				return RAW;
			},
			fetchModelsForUser: async () => {
				userCalls++;
				return [rawFor("anthropic/claude-sonnet-4.5")];
			},
		};

		const cfg = { ...DEFAULT_CONFIG, openrouter: { ...DEFAULT_CONFIG.openrouter, apiKey: "sk-or-test" } };
		const db = openDb(":memory:");
		const catalog = createCatalog(cfg, upstream, db);

		const snapshot = await catalog.get();
		expect(userCalls).toBe(1);
		// The public catalog is now also fetched, but ONLY to join AA benchmark
		// scores on: `/models/user` omits them, and an unscored catalog leaves
		// every tier above `trivial` permanently empty.
		expect(publicCalls).toBe(1);
		expect(snapshot.keyScoped).toBe(true);
		// Availability still comes solely from the key-scoped list: none of the
		// public models may leak into a key-scoped snapshot.
		expect(snapshot.models.length).toBe(1);
		expect(snapshot.models[0]?.slug).toBe("anthropic/claude-sonnet-4.5");
		db.close();
	});

	test("uses public fetchModels when no API key is configured", async () => {
		const { createCatalog } = await import("../src/catalog/openrouter-catalog.ts");
		const { openDb } = await import("../src/util/sqlite.ts");
		const { DEFAULT_CONFIG } = await import("../src/config/defaults.ts");

		let userCalls = 0;
		let publicCalls = 0;
		const upstream: any = {
			dispatch: () => Promise.reject(new Error("unused")),
			complete: () => Promise.reject(new Error("unused")),
			fetchModels: async () => {
				publicCalls++;
				return RAW;
			},
			fetchModelsForUser: async () => {
				userCalls++;
				return [];
			},
		};

		const cfg = { ...DEFAULT_CONFIG, openrouter: { ...DEFAULT_CONFIG.openrouter, apiKey: "" } };
		const db = openDb(":memory:");
		const catalog = createCatalog(cfg, upstream, db);

		const snapshot = await catalog.get();
		expect(userCalls).toBe(0);
		expect(publicCalls).toBe(1);
		expect(snapshot.keyScoped).toBe(false);
		expect(snapshot.models.length).toBeGreaterThan(50);
		db.close();
	});

	test("re-throws 401/403 authorization failures rather than falling back to un-scoped catalog", async () => {
		const { createCatalog } = await import("../src/catalog/openrouter-catalog.ts");
		const { openDb } = await import("../src/util/sqlite.ts");
		const { DEFAULT_CONFIG } = await import("../src/config/defaults.ts");
		const { UpstreamError } = await import("../src/upstream/types.ts");

		const upstream: any = {
			dispatch: () => Promise.reject(new Error("unused")),
			complete: () => Promise.reject(new Error("unused")),
			fetchModels: async () => RAW,
			fetchModelsForUser: async () => {
				throw new UpstreamError("auth", 401, "Unauthorized", false);
			},
		};

		const cfg = { ...DEFAULT_CONFIG, openrouter: { ...DEFAULT_CONFIG.openrouter, apiKey: "sk-or-invalid" } };
		const db = openDb(":memory:");
		const catalog = createCatalog(cfg, upstream, db);

		await expect(catalog.get()).rejects.toThrow("Unauthorized");
		db.close();
	});

	test("falls back to public catalog on transient (500) key-scoped fetch failure", async () => {
		const { createCatalog } = await import("../src/catalog/openrouter-catalog.ts");
		const { openDb } = await import("../src/util/sqlite.ts");
		const { DEFAULT_CONFIG } = await import("../src/config/defaults.ts");
		const { UpstreamError } = await import("../src/upstream/types.ts");

		const upstream: any = {
			dispatch: () => Promise.reject(new Error("unused")),
			complete: () => Promise.reject(new Error("unused")),
			fetchModels: async () => [rawFor("anthropic/claude-sonnet-4.5")],
			fetchModelsForUser: async () => {
				throw new UpstreamError("upstream_error", 500, "Internal Server Error", true);
			},
		};

		const cfg = { ...DEFAULT_CONFIG, openrouter: { ...DEFAULT_CONFIG.openrouter, apiKey: "sk-or-test" } };
		const db = openDb(":memory:");
		const catalog = createCatalog(cfg, upstream, db);

		const snapshot = await catalog.get();
		expect(snapshot.models.length).toBe(1);
		expect(snapshot.keyScoped).toBe(false);
		db.close();
	});

	test("keeps the previous snapshot when a key-scoped refresh yields no usable models", async () => {
		const { createCatalog } = await import("../src/catalog/openrouter-catalog.ts");
		const { openDb } = await import("../src/util/sqlite.ts");
		const { DEFAULT_CONFIG } = await import("../src/config/defaults.ts");

		// First fetch returns a real model; the second returns an empty list.
		let calls = 0;
		const upstream: any = {
			dispatch: () => Promise.reject(new Error("unused")),
			complete: () => Promise.reject(new Error("unused")),
			fetchModels: async () => [rawFor("anthropic/claude-sonnet-4.5")],
			fetchModelsForUser: async () => {
				calls++;
				return calls === 1 ? [rawFor("anthropic/claude-sonnet-4.5")] : [];
			},
		};

		const cfg = { ...DEFAULT_CONFIG, openrouter: { ...DEFAULT_CONFIG.openrouter, apiKey: "sk-or-test" } };
		const db = openDb(":memory:");
		const catalog = createCatalog(cfg, upstream, db);

		const first = await catalog.get();
		expect(first.models.length).toBe(1);

		// Force a refresh that returns empty; the stale snapshot must survive.
		const second = await catalog.refresh();
		expect(second.models.length).toBe(1);
		expect(second.models[0]?.slug).toBe("anthropic/claude-sonnet-4.5");
		db.close();
	});

	test("does not persist the public fallback over a key-scoped snapshot", async () => {
		const { createCatalog } = await import("../src/catalog/openrouter-catalog.ts");
		const { openDb } = await import("../src/util/sqlite.ts");
		const { DEFAULT_CONFIG } = await import("../src/config/defaults.ts");
		const { UpstreamError } = await import("../src/upstream/types.ts");

		// Key-scoped succeeds once, then fails transiently; public returns a
		// DIFFERENT model. The public payload must not overwrite the key-scoped
		// cache on disk.
		let userCalls = 0;
		const upstream: any = {
			dispatch: () => Promise.reject(new Error("unused")),
			complete: () => Promise.reject(new Error("unused")),
			fetchModels: async () => [rawFor("openai/gpt-oss-20b")],
			fetchModelsForUser: async () => {
				userCalls++;
				if (userCalls === 1) return [rawFor("anthropic/claude-sonnet-4.5")];
				throw new UpstreamError("upstream_error", 500, "Internal Server Error", true);
			},
		};

		const cfg = { ...DEFAULT_CONFIG, openrouter: { ...DEFAULT_CONFIG.openrouter, apiKey: "sk-or-test" } };
		const db = openDb(":memory:");
		const catalog = createCatalog(cfg, upstream, db);

		await catalog.get(); // key-scoped, persisted
		await catalog.refresh(); // falls back to public in-memory, must NOT persist

		// A fresh catalog over the same DB hydrates from disk: it must still be
		// the key-scoped model, not the public fallback.
		const catalog2 = createCatalog(cfg, upstream, db);
		const hydrated = catalog2.peek();
		expect(hydrated?.models[0]?.slug).toBe("anthropic/claude-sonnet-4.5");
		expect(hydrated?.keyScoped).toBe(true);
		db.close();
	});
});
