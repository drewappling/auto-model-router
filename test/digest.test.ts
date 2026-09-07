import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot, CatalogSource } from "../src/catalog/types.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { createLedger } from "../src/cost/ledger.ts";
import type { LedgerEntry } from "../src/cost/types.ts";
import { createDigester, digestApplies, digestMarker } from "../src/server/digest.ts";
import type { UpstreamClient } from "../src/upstream/types.ts";
import { createLogger } from "../src/util/log.ts";
import { openDb } from "../src/util/sqlite.ts";
import { digestToast, parsePolicy, shouldSend, textOf } from "../omp-extension/digest-logic.ts";

/**
 * The tool-result digest: gates (tool, size, error, session tier, cost),
 * model choice from the cheap tier, the marker that keeps the full output
 * reachable, the ledger row every digest leaves, and the extension's
 * client-side checks.
 */

const FIXTURE = (await Bun.file("test/fixtures/openrouter-models.json").json()) as { data: unknown[] };
const MODELS: CatalogModel[] = FIXTURE.data.map(normalizeCatalogModel).filter((m): m is CatalogModel => m !== null);
const SNAPSHOT: CatalogSnapshot = { models: MODELS, fetchedAtMs: Date.now() };
const catalog: CatalogSource = {
	get: async () => SNAPSHOT,
	refresh: async () => SNAPSHOT,
	peek: () => SNAPSHOT,
	find: (slug) => MODELS.find((m) => m.slug === slug),
};
const log = createLogger("silent");

function cfgWith(over: Partial<RouterConfig["digest"]> = {}): RouterConfig {
	const cfg = structuredClone(DEFAULT_CONFIG);
	cfg.ledger.path = ":memory:";
	cfg.digest = { ...cfg.digest, enabled: true, minBytes: 100, ...over };
	return cfg;
}

function seedSession(ledger: ReturnType<typeof createLedger>, tier: string): void {
	const e: LedgerEntry = {
		id: crypto.randomUUID(),
		createdAtMs: Date.now(),
		conversationKey: "k",
		sessionId: "s",
		turn: 3,
		requestedModel: "auto",
		harnessId: "",
		ompSessionId: "omp-1",
		slug: "x/y",
		servedSlug: "x/y",
		tier,
		classificationSource: "heuristic",
		reasons: [],
		features: null,
		score: null,
		confidence: null,
		task: null,
		classifierReasons: null,
		exploredFrom: null,
		holdArm: null,
		predictedUsd: 0.01,
		reportedUsd: 0.01,
		usage: { promptTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, completionTokens: 10, reasoningTokens: 0, images: 0 },
		attempt: 0,
		escalationSignal: null,
		latencyMs: 100,
		ttftMs: 50,
		finishReason: "stop",
		wasted: false,
		upstreamGenerationId: null,
		error: null,
		promptTokensSaved: 0,
	};
	ledger.record(e);
}

function fakeUpstream(reply: (body: Record<string, unknown>) => string, costUsd: number | null = 0.0004): { upstream: UpstreamClient; calls: Record<string, unknown>[] } {
	const calls: Record<string, unknown>[] = [];
	return {
		calls,
		upstream: {
			dispatch: () => Promise.reject(new Error("not used")),
			complete: async (body) => {
				calls.push(body);
				return { text: reply(body), costUsd };
			},
			fetchModels: () => Promise.resolve([]),
			fetchModelsForUser: () => Promise.resolve([]),
		},
	};
}

const BIG = Array.from({ length: 400 }, (_, i) => `${i + 1}: export const value${i} = ${i};`).join("\n");

describe("digestApplies", () => {
	const d = { ...DEFAULT_CONFIG.digest, enabled: true, minBytes: 100, maxBytes: 1000 };
	test("gates on switch, error, tool, size and session tier", () => {
		expect(digestApplies({ ...d, enabled: false }, "read", 500, false, "hard").ok).toBe(false);
		expect(digestApplies(d, "read", 500, true, "hard").ok).toBe(false);
		expect(digestApplies(d, "edit", 500, false, "hard").ok).toBe(false);
		expect(digestApplies(d, "read", 50, false, "hard").ok).toBe(false);
		expect(digestApplies(d, "read", 5000, false, "hard").ok).toBe(false);
		expect(digestApplies(d, "read", 500, false, null).ok).toBe(false);
		expect(digestApplies(d, "read", 500, false, "simple").ok).toBe(false); // below fromTier moderate
		expect(digestApplies(d, "read", 500, false, "moderate").ok).toBe(true);
		expect(digestApplies(d, "READ", 500, false, "hard").ok).toBe(true);
	});
});

describe("createDigester", () => {
	test("condenses a large read for a hard-tier session on a cheap model and records a ledger row", async () => {
		const cfg = cfgWith();
		const db = openDb(":memory:");
		const ledger = createLedger(db, cfg);
		seedSession(ledger, "hard");
		const { upstream, calls } = fakeUpstream(() => "Omitted 380 trivial constants.\n1: export const value0 = 0;\n...");
		const d = createDigester({ cfg, catalog, ledger, upstream, log });
		const r = await d.digest({ ompSessionId: "omp-1", harnessId: "", toolName: "read", input: { path: "src/values.ts" }, content: BIG, query: "find value0" });
		expect(r.digested).toBe(true);
		if (!r.digested) return;
		expect(r.text.startsWith("[digest: read output")).toBe(true);
		expect(r.text).toContain("re-run read {\"path\":\"src/values.ts\"} (offset/limit for a range)");
		expect(r.text).toContain("Omitted 380 trivial constants.");
		expect(r.usd).toBeCloseTo(0.0004, 6);
		// The cheap tier picked the model; the call carried the task and the raw output.
		const call = calls[0]!;
		expect(typeof call.model).toBe("string");
		expect(catalog.find(call.model as string)?.price.prompt).toBeLessThanOrEqual(cfg.tiers.simple.maxInputPerMtok! / 1e6);
		expect(JSON.stringify(call.messages)).toContain("Task: find value0");
		// A ledger row under requestedModel "digest" with the served model and its cost.
		const rows = ledger.recentEntries(10).filter((e) => e.requestedModel === "digest");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.slug).toBe(call.model as string);
		expect(rows[0]!.reportedUsd).toBeCloseTo(0.0004, 6);
		expect(rows[0]!.ompSessionId).toBe("omp-1");
		db.close();
	});

	test("declines below the session tier, over the cost guard, when the model fails, or when nothing shrinks", async () => {
		const db = openDb(":memory:");
		const cfg = cfgWith();
		const ledger = createLedger(db, cfg);
		seedSession(ledger, "simple");
		const cheap = createDigester({ cfg, catalog, ledger, upstream: fakeUpstream(() => "short").upstream, log });
		expect(await cheap.digest({ ompSessionId: "omp-1", harnessId: "", toolName: "read", input: {}, content: BIG, query: "" })).toMatchObject({ digested: false, reason: expect.stringContaining("below digest.fromTier") });

		const db2 = openDb(":memory:");
		const strict = cfgWith({ maxCostUsd: 0 });
		const ledger2 = createLedger(db2, strict);
		seedSession(ledger2, "hard");
		expect(await createDigester({ cfg: strict, catalog, ledger: ledger2, upstream: fakeUpstream(() => "x").upstream, log }).digest({ ompSessionId: "omp-1", harnessId: "", toolName: "read", input: {}, content: BIG, query: "" })).toMatchObject({ digested: false, reason: expect.stringContaining("exceeds digest.maxCostUsd") });

		const failing: UpstreamClient = { ...fakeUpstream(() => "x").upstream, complete: () => Promise.reject(new Error("boom")) };
		expect(await createDigester({ cfg, catalog, ledger: ledger2, upstream: failing, log }).digest({ ompSessionId: "omp-1", harnessId: "", toolName: "read", input: {}, content: BIG, query: "" })).toMatchObject({ digested: false, reason: "digest model failed: boom" });
		// The failed attempt is still a ledger row, with the error.
		expect(ledger2.recentEntries(5).find((e) => e.requestedModel === "digest")?.error).toBe("boom");

		const same = createDigester({ cfg, catalog, ledger: ledger2, upstream: fakeUpstream(() => BIG).upstream, log });
		expect(await same.digest({ ompSessionId: "omp-1", harnessId: "", toolName: "read", input: {}, content: BIG, query: "" })).toMatchObject({ digested: false, reason: "digest did not shrink the output" });
		db.close();
		db2.close();
	});

	test("a pinned digest model is used as-is", async () => {
		const pinned = MODELS.find((m) => m.price.prompt > 0)!.slug;
		const cfg = cfgWith({ model: pinned });
		const db = openDb(":memory:");
		const ledger = createLedger(db, cfg);
		seedSession(ledger, "hard");
		const { upstream, calls } = fakeUpstream(() => "digest");
		await createDigester({ cfg, catalog, ledger, upstream, log }).digest({ ompSessionId: "omp-1", harnessId: "", toolName: "grep", input: { pattern: "x" }, content: BIG, query: "" });
		expect(calls[0]?.model as string).toBe(pinned);
		db.close();
	});
});

describe("digest marker and extension logic", () => {
	test("the marker names the tool, sizes, model and how to get the full output", () => {
		expect(digestMarker("grep", { pattern: "retry" }, "z-ai/glm-5.3-flash", 48_000, 3_000)).toBe(
			'[digest: grep output 48,000 bytes → 3,000 chars by z-ai/glm-5.3-flash. Full output: re-run grep {"pattern":"retry"}]',
		);
	});

	test("textOf joins text parts and flags images", () => {
		expect(textOf([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toEqual({ text: "a\nb", hasImage: false });
		expect(textOf([{ type: "image" }, { type: "text", text: "a" }])).toEqual({ text: "a", hasImage: true });
	});

	test("shouldSend applies the client-side gate; parsePolicy is defensive", () => {
		const p = parsePolicy({ enabled: true, minBytes: 10, maxBytes: 100, tools: ["Read", "grep"], fromTier: "hard" });
		expect(p.tools).toEqual(["read", "grep"]);
		expect(shouldSend(p, "read", false, "x".repeat(50), false)).toBe(true);
		expect(shouldSend(p, "read", true, "x".repeat(50), false)).toBe(false);
		expect(shouldSend(p, "read", false, "x".repeat(50), true)).toBe(false);
		expect(shouldSend(p, "edit", false, "x".repeat(50), false)).toBe(false);
		expect(shouldSend(p, "read", false, "x".repeat(5), false)).toBe(false);
		expect(shouldSend(p, "read", false, "x".repeat(500), false)).toBe(false);
		expect(parsePolicy({ enabled: false }).enabled).toBe(false);
		expect(parsePolicy("nope").enabled).toBe(false);
		expect(parsePolicy({ enabled: true }).minBytes).toBe(12_000);
	});

	test("digestToast is one readable line", () => {
		expect(digestToast("read", 48 * 1024, 3 * 1024, "ollama/glm-5.3-flash", 0.00042)).toBe("digested read 48KB → 3KB via glm-5.3-flash ($0.0004)");
	});
});
