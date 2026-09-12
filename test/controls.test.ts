import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateStore } from "../src/util/schema.ts";
import { openSqlDb } from "../src/util/sql.ts";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { createFeedbackStore } from "../src/cost/feedback.ts";
import { createSqlLedger } from "../src/cost/ledger-sql.ts";
import { EMPTY_USAGE, type LedgerEntry } from "../src/cost/types.ts";
import { startServer, type StartedServer } from "../src/server/http.ts";
import { pinForRequestedModel, resolveProfile } from "../src/router/index.ts";
import { ollamaRunway } from "../src/server/http.ts";
import { createSessionOverrides, OVERRIDE_TTL_MS } from "../src/server/overrides.ts";
import { describeOverride, parseOverrideArgs, renderWhy, type WhyEntry } from "../omp-extension/report-logic.ts";

/**
 * Session controls from omp: pin/tier overrides (process-local, per omp
 * session, counted down per committed dispatch), user feedback tied to the
 * ledger row judged, and the /router why rendering.
 */

describe("session overrides", () => {
	test("set, read, count down, clear, and expire", async () => {
		const o = createSessionOverrides();
		const now = Date.now();
		expect(o.get("s1")).toBeNull();
		o.set("s1", { tier: "hard", turns: 2 }, now);
		expect(o.get("s1")).toEqual({ slug: null, tier: "hard", turnsLeft: 2, setAtMs: now });
		// A pin added later keeps the tier and its countdown.
		o.set("s1", { slug: "ollama/glm-5.3-flash" }, now + 1);
		expect(o.get("s1")?.slug).toBe("ollama/glm-5.3-flash");
		expect(o.get("s1")?.tier).toBe("hard");
		o.consume("s1");
		expect(o.get("s1")?.turnsLeft).toBe(1);
		o.consume("s1");
		expect(o.get("s1")).toBeNull(); // used up
		o.set("s2", { slug: "x/y", turns: 0 });
		o.consume("s2");
		o.consume("s2");
		expect(o.get("s2")?.turnsLeft).toBe(0); // unlimited never counts down
		o.clear("s2");
		expect(o.get("s2")).toBeNull();
		o.set("s3", { tier: "simple" }, Date.now() - OVERRIDE_TTL_MS - 1);
		expect(o.get("s3")).toBeNull(); // expired
		expect(o.get("")).toBeNull();
	});

	test("clearing both fields reads as no override", async () => {
		const o = createSessionOverrides();
		o.set("s", { tier: "hard" });
		o.set("s", { tier: null });
		expect(o.get("s")).toBeNull();
		expect(o.list()).toHaveLength(1); // the entry exists but carries nothing
	});
});

describe("feedback store", () => {
	function entry(over: Partial<LedgerEntry>): LedgerEntry {
		return {
			id: crypto.randomUUID(),
			createdAtMs: Date.now(),
			conversationKey: "k",
			sessionId: "s",
			turn: 1,
			requestedModel: "auto",
			harnessId: "",
			ompSessionId: "omp-1",
			slug: "v/m",
			servedSlug: "v/m",
			tier: "simple",
			classificationSource: "heuristic",
			reasons: [],
			features: null,
			score: null,
			confidence: null,
			task: null,
			classifierReasons: null,
			exploredFrom: null,
			holdArm: null,
			predictedUsd: 0.001,
			reportedUsd: 0.001,
			usage: { ...EMPTY_USAGE, promptTokens: 10, completionTokens: 5 },
			attempt: 0,
			escalationSignal: null,
			latencyMs: 100,
			ttftMs: 50,
			finishReason: "stop",
			wasted: false,
			upstreamGenerationId: null,
			error: null,
			promptTokensSaved: null,
			...over,
		} as LedgerEntry;
	}

	test("records verdicts against the session's newest kept turn and counts them by model", async () => {
		const db = openSqlDb(join(tmpdir(), `t-controls.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		const cfg = structuredClone(DEFAULT_CONFIG);
		cfg.ledger.path = ":memory:";
		const ledger = createSqlLedger(db, cfg, { findModel: () => null });
		const fb = createFeedbackStore(db);
		await ledger.record(entry({ createdAtMs: 1_000, slug: "a/m", servedSlug: "a/m" }));
		await ledger.record(entry({ createdAtMs: 2_000, slug: "b/m", servedSlug: "b/m", wasted: true })); // a wasted probe is never "the turn"
		await ledger.record(entry({ createdAtMs: 3_000, slug: "c/m", servedSlug: "c/m" }));
		await ledger.record(entry({ createdAtMs: 4_000, ompSessionId: "omp-2", slug: "d/m", servedSlug: "d/m" }));
		const latest = await ledger.latestForSession("omp-1");
		expect(latest?.servedSlug).toBe("c/m");
		expect((await ledger.entriesForSession("omp-1", 10)).map((e) => e.servedSlug)).toEqual(["c/m", "a/m"]);
		expect(await ledger.latestForSession("")).toBeNull();

		const ledgerId = latest?.id ?? "";
		await fb.record({ ledgerId, ompSessionId: "omp-1", slug: "c/m", tier: "simple", verdict: "bad", note: "wrong file" }, 5_000);
		await fb.record({ ledgerId, ompSessionId: "omp-1", slug: "c/m", tier: "simple", verdict: "good", note: "" }, 6_000);
		expect((await fb.forLedgerId(ledgerId)).map((f) => f.verdict)).toEqual(["good", "bad"]);
		expect([...(await fb.countsBySlug(0)).entries()]).toEqual([["c/m", { good: 1, bad: 1 }]]);
		expect((await fb.countsBySlug(5_500)).get("c/m")).toEqual({ good: 1, bad: 0 });
		await db.close();
	});
});

describe("override and feedback endpoints", () => {
	let handle: StartedServer;
	let baseUrl = "";
	beforeAll(() => {
		const cfg: RouterConfig = {
			...structuredClone(DEFAULT_CONFIG),
			server: { host: "127.0.0.1", port: 0, maxConcurrentTurns: 24, subagentProfile: "auto-sub" },
			ledger: { ...DEFAULT_CONFIG.ledger, path: ":memory:" },
			logLevel: "silent",
		};
		handle = startServer(cfg);
		baseUrl = `http://127.0.0.1:${handle.server.port}`;
	});
	afterAll(async () => {
		await handle.stop();
	});
	const post = (path: string, body: unknown) =>
		fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

	test("override: validates, sets a tier with a countdown, shows it, clears it", async () => {
		expect((await post("/v1/router/override", { tier: "hard" })).status).toBe(400); // no session
		expect((await post("/v1/router/override", { ompSessionId: "s", tier: "epic" })).status).toBe(400);
		expect((await post("/v1/router/override", { ompSessionId: "s", slug: "nope/model" })).status).toBe(404);
		const set = (await (await post("/v1/router/override", { ompSessionId: "s", tier: "hard", turns: 3 })).json()) as { override: { tier: string; turnsLeft: number } };
		expect(set.override.tier).toBe("hard");
		expect(set.override.turnsLeft).toBe(3);
		const shown = (await (await fetch(`${baseUrl}/v1/router/override?session=s`)).json()) as { override: { tier: string } | null };
		expect(shown.override?.tier).toBe("hard");
		const all = (await (await fetch(`${baseUrl}/v1/router/override`)).json()) as { overrides: unknown[] };
		expect(all.overrides).toHaveLength(1);
		const cleared = (await (await post("/v1/router/override", { ompSessionId: "s", clear: true })).json()) as { override: null };
		expect(cleared.override).toBeNull();
	});

	test("feedback: rejects a bad verdict and a session with no turns", async () => {
		expect((await post("/v1/router/feedback", { ompSessionId: "s", verdict: "meh" })).status).toBe(400);
		expect((await post("/v1/router/feedback", { ompSessionId: "never", verdict: "good" })).status).toBe(404);
	});

	test("decisions can be narrowed to a session", async () => {
		const body = (await (await fetch(`${baseUrl}/v1/router/decisions?session=none`)).json()) as { entries: unknown[] };
		expect(body.entries).toEqual([]);
	});
});

describe("/router why and override parsing", () => {
	const entry: WhyEntry = {
		id: "abc",
		createdAtMs: 1_000_000,
		turn: 12,
		slug: "z-ai/glm-5.3-flash",
		servedSlug: "ollama/glm-5.3-flash",
		tier: "moderate",
		classificationSource: "heuristic",
		confidence: 0.42,
		task: "coding",
		reasons: ["classified moderate", "cache: keeping warm ollama/glm-5.3-flash (stay $0.0010 ≤ switch $0.0300 × 1.3)"],
		classifierReasons: ["+0.10 complexity keyword: refactor"],
		reportedUsd: 0.0123,
		predictedUsd: 0.02,
		usage: { promptTokens: 120_000, cachedTokens: 100_000, completionTokens: 300, cachedEstimated: true },
		latencyMs: 4_200,
		ttftMs: 900,
		attempt: 0,
		escalationSignal: null,
		feedback: [{ verdict: "bad", note: "edited the wrong file", createdAtMs: 1_000_500 }],
	};

	test("renderWhy names the model, tier, confidence, cost, cache, trail and feedback", async () => {
		const text = renderWhy(entry, 1_060_000);
		expect(text).toContain("turn 12 · 1m ago · ollama · ollama/glm-5.3-flash (asked z-ai/glm-5.3-flash) [moderate]");
		expect(text).toContain("classified moderate by heuristic at 42% confidence · task coding");
		expect(text).toContain("cost $0.0123 · prompt 120,000 tok (cache 83% est.) · completion 300 tok · ttft 0.9s · total 4.2s");
		expect(text).toContain("  - cache: keeping warm");
		expect(text).toContain("  - +0.10 complexity keyword: refactor");
		expect(text).toContain("  - bad: edited the wrong file");
	});

	test("parseOverrideArgs handles pin, tier with turns, off, and errors", async () => {
		expect(parseOverrideArgs("pin", "ollama/glm-5.3-flash")).toEqual({ kind: "pin", slug: "ollama/glm-5.3-flash" });
		expect(parseOverrideArgs("pin", "off")).toEqual({ kind: "pin", slug: null });
		expect(parseOverrideArgs("pin", "")).toEqual({ kind: "show" });
		expect(parseOverrideArgs("tier", "hard")).toEqual({ kind: "tier", tier: "hard", turns: 10 });
		expect(parseOverrideArgs("tier", "Simple 3")).toEqual({ kind: "tier", tier: "simple", turns: 3 });
		expect(parseOverrideArgs("tier", "off")).toEqual({ kind: "tier", tier: null, turns: 0 });
		expect(parseOverrideArgs("tier", "epic").kind).toBe("error");
		expect(parseOverrideArgs("tier", "hard x").kind).toBe("error");
	});

	test("describeOverride summarises what is in force", async () => {
		expect(describeOverride(null)).toBe("no override on this session");
		expect(describeOverride({ slug: "a/b", tier: "hard", turnsLeft: 1 })).toBe("pinned to a/b, tier forced to hard · 1 turn left");
		expect(describeOverride({ slug: null, tier: "simple", turnsLeft: 0 })).toBe("tier forced to simple · until cleared");
	});
});

describe("ollamaRunway", () => {
	test("days of credits left at the calibrated weekly burn", async () => {
		const r = ollamaRunway({ usedUsd: 6.3, creditsUsd: 60 }, 7, 1.25)!;
		expect(r.dailyBurnUsd).toBeCloseTo(1.25, 6);
		expect(r.creditsLeftUsd).toBeCloseTo(53.7, 6);
		expect(r.days).toBeCloseTo(53.7 / 1.25, 6);
		expect(ollamaRunway({ usedUsd: 6.3, creditsUsd: 60 }, 0, 1)!.days).toBeNull();
		expect(ollamaRunway(null, 7, 1)).toBeNull();
	});
});

describe("subagent profile", () => {
	test("a subagent asking for the default profile is routed under server.subagentProfile; explicit profiles are honoured", async () => {
		const cfg = structuredClone(DEFAULT_CONFIG);
		expect(resolveProfile(cfg, "auto", true).id).toBe("auto-sub");
		expect(resolveProfile(cfg, "auto", false).id).toBe("auto");
		expect(resolveProfile(cfg, "auto-max", true).id).toBe("auto-max");
		expect(resolveProfile(cfg, "unknown", true).id).toBe("auto-sub"); // unknown ids fall back to the default, which a subagent remaps
		cfg.server.subagentProfile = "";
		expect(resolveProfile(cfg, "auto", true).id).toBe("auto");
		cfg.server.subagentProfile = "nope";
		expect(resolveProfile(cfg, "auto", true).id).toBe("auto");
	});
});

describe("requested model", () => {
	test("a catalog slug pins, a profile does not, and an unknown name is refused rather than substituted", async () => {
		const cfg = structuredClone(DEFAULT_CONFIG);
		const slugs = ["deepseek/deepseek-v4.1-flash", "ollama/deepseek-v4.1-flash"];
		// A profile id routes normally: nothing is pinned.
		expect(pinForRequestedModel(cfg, slugs, "auto", "auto")).toBeUndefined();
		expect(pinForRequestedModel(cfg, slugs, "auto-cheap", "auto-model-router/auto-cheap")).toBeUndefined();
		// A real slug is honoured as a pin, and the vendor prefix decides which
		// one: the stripped name alone is ambiguous between these two.
		expect(pinForRequestedModel(cfg, slugs, "deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash")).toBe(
			"deepseek/deepseek-v4.1-flash",
		);
		expect(pinForRequestedModel(cfg, slugs, "deepseek-v4.1-flash", "ollama/deepseek-v4.1-flash")).toBe(
			"ollama/deepseek-v4.1-flash",
		);
		// Neither a profile nor a slug: refused. Silently routing `auto` here is
		// what billed a caller for glm-5.3-flash after it asked for v4.1-flash.
		expect(() => pinForRequestedModel(cfg, slugs, "deepseek-v4.1-flash", "deepseek-v4.1-flash")).toThrow();
		expect(() => pinForRequestedModel(cfg, slugs, "nope", "vendor/nope")).toThrow();
	});
});

describe("digest endpoints", () => {
	let handle: StartedServer;
	let baseUrl = "";
	beforeAll(() => {
		const cfg: RouterConfig = {
			...structuredClone(DEFAULT_CONFIG),
			server: { host: "127.0.0.1", port: 0, maxConcurrentTurns: 24, subagentProfile: "auto-sub" },
			ledger: { ...DEFAULT_CONFIG.ledger, path: ":memory:" },
			logLevel: "silent",
		};
		cfg.digest = { ...cfg.digest, enabled: true, minBytes: 10 };
		handle = startServer(cfg);
		baseUrl = `http://127.0.0.1:${handle.server.port}`;
	});
	afterAll(async () => {
		await handle.stop();
	});

	test("policy reflects the config; a digest for a session with no turns is declined, a bad body rejected", async () => {
		const policy = (await (await fetch(`${baseUrl}/v1/router/digest/policy`)).json()) as { enabled: boolean; minBytes: number; tools: string[] };
		expect(policy.enabled).toBe(true);
		expect(policy.minBytes).toBe(10);
		expect(policy.tools).toContain("read");
		const bad = await fetch(`${baseUrl}/v1/router/digest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ toolName: "read" }) });
		expect(bad.status).toBe(400);
		const res = await fetch(`${baseUrl}/v1/router/digest`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ompSessionId: "never", toolName: "read", input: {}, content: "x".repeat(100), query: "q" }),
		});
		expect((await res.json()) as unknown).toMatchObject({ digested: false, reason: "no routed turn in this session yet" });
	});
});
