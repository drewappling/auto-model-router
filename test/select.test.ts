import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot } from "../src/catalog/types.ts";
import { loadConfig } from "../src/config/load.ts";
import type { ProfileConfig, RouterConfig } from "../src/config/types.ts";
import type { Ledger } from "../src/cost/types.ts";
import { extractFeatures } from "../src/router/features.ts";
import { scoreHeuristic } from "../src/router/classify.ts";
import { BudgetExceededError, select } from "../src/router/select.ts";
import type { ConversationState, Tier } from "../src/router/types.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";
import type { NormRequest } from "../src/wire/types.ts";

const FIXTURE = (await Bun.file("test/fixtures/openrouter-models.json").json()) as { data: unknown[] };
const MODELS: CatalogModel[] = FIXTURE.data.map(normalizeCatalogModel).filter((m): m is CatalogModel => m !== null);
const SNAPSHOT: CatalogSnapshot = { models: MODELS, fetchedAtMs: Date.now() };

const BASE = loadConfig({});
const PROFILE: ProfileConfig = {
	id: "auto",
	name: "Auto",
	minTier: "trivial",
	maxTier: "hard",
	contextWindow: 400_000,
	maxTokens: 32_000,
};

const TOOLS = [
	{
		type: "function",
		function: {
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
	},
];

function request(userText: string): NormRequest {
	return parseChatRequest(
		{
			model: "auto",
			tools: TOOLS,
			messages: [
				{ role: "system", content: "You are a coding agent." },
				{ role: "user", content: userText },
			],
		},
		new Headers(),
	);
}

function state(over: Partial<ConversationState> = {}): ConversationState {
	return {
		key: "abc123",
		sessionId: "omp-abc123",
		turn: 1,
		currentSlug: null,
		currentTier: null,
		stickyUntilTurn: 0,
		escalations: 0,
		spentUsd: 0,
		lastPromptTokens: 0,
		cacheWarmSlug: null,
		cacheWarmAtMs: 0,
		contextVersion: null,
		contextFetchedAtMs: 0,
		compactionPlan: null,
		updatedAtMs: Date.now(),
		...over,
	};
}

function run(opts: {
	userText?: string;
	promptTokens?: number;
	cfg?: RouterConfig;
	st?: ConversationState;
	tier?: Tier;
	ledger?: Ledger | null;
	harnessId?: string;
}) {
	const cfg = opts.cfg ?? BASE;
	const req = request(opts.userText ?? "tidy the retry helper");
	const features = extractFeatures(req, opts.promptTokens ?? 4000);
	const heuristic = scoreHeuristic(features, cfg);
	const classification = opts.tier === undefined ? heuristic : { ...heuristic, tier: opts.tier };
	return select({
		req: opts.harnessId === undefined ? req : { ...req, harnessId: opts.harnessId },
		features,
		classification,
		profile: PROFILE,
		state: opts.st ?? state(),
		snapshot: SNAPSHOT,
		ledger: opts.ledger === undefined ? null : opts.ledger,
		cfg,
		nowMs: Date.now(),
	});
}

describe("hard exclusions", () => {
	test("never selects a meta-router, floating alias, batch endpoint, or cloaked model", () => {
		for (const tier of ["trivial", "simple", "moderate", "hard"] as Tier[]) {
			const d = run({ tier });
			expect(d.slug.startsWith("openrouter/")).toBe(false);
			expect(d.slug.startsWith("~")).toBe(false);
			expect(d.slug.endsWith(":batch")).toBe(false);
			expect(d.slug.startsWith("stealth/")).toBe(false);
			for (const f of d.fallbacks) {
				expect(f.startsWith("openrouter/")).toBe(false);
				expect(f.endsWith(":batch")).toBe(false);
				expect(f.startsWith("~")).toBe(false);
			}
		}
	});

	test("only offers tool-capable models when the request offers tools", () => {
		for (const tier of ["trivial", "simple", "moderate", "hard"] as Tier[]) {
			const d = run({ tier });
			for (const c of d.considered) expect(c.model.supportsTools).toBe(true);
		}
	});

	test("excludes free models by default", () => {
		const d = run({ tier: "trivial" });
		for (const c of d.considered) expect(c.model.isFree).toBe(false);
	});
});

describe("quality floor", () => {
	test("an unscored model never satisfies a tier with a floor above zero", () => {
		for (const tier of ["simple", "moderate", "hard"] as Tier[]) {
			const d = run({ tier });
			for (const c of d.considered) {
				const q = c.model.quality;
				const unscored = q.coding === undefined && q.agentic === undefined && q.intelligence === undefined;
				expect(unscored).toBe(false);
			}
		}
	});

	test("unscored models are eligible in the trivial tier, whose floor is zero", () => {
		const d = run({ tier: "trivial" });
		expect(BASE.tiers.trivial.minQuality).toBe(0);
		expect(d.considered.length).toBeGreaterThan(0);
	});

	test("a higher tier selects a higher-quality model than a lower tier", () => {
		const cheap = run({ tier: "trivial" });
		const dear = run({ tier: "hard" });
		const cheapModel = MODELS.find((m) => m.slug === cheap.slug);
		const dearModel = MODELS.find((m) => m.slug === dear.slug);
		expect(cheapModel).toBeDefined();
		expect(dearModel).toBeDefined();
		expect(dear.forecast.expectedUsd).toBeGreaterThan(cheap.forecast.expectedUsd);
	});
});

describe("context window", () => {
	test("rejects models whose context cannot hold the prompt", () => {
		// Far larger than the small-context models in the catalog can take.
		const d = run({ tier: "trivial", promptTokens: 300_000 });
		expect(d.rejected.some((r) => r.reason === "context_too_small")).toBe(true);
		const chosen = MODELS.find((m) => m.slug === d.slug);
		expect(chosen).toBeDefined();
		expect(chosen?.contextLength ?? 0).toBeGreaterThan(300_000);
	});

	test("applies headroom so a token-estimate error cannot overflow the window", () => {
		const d = run({ tier: "trivial", promptTokens: 100_000 });
		const chosen = MODELS.find((m) => m.slug === d.slug);
		expect(chosen?.contextLength ?? 0).toBeGreaterThanOrEqual(100_000 * BASE.filters.contextHeadroom);
	});
});

describe("cache-aware switching", () => {
	// Deliberately NOT the top-ranked hard candidate: staying must be a real
	// choice against a better option, or the switch logic is never exercised.
	const warmSlug = "x-ai/grok-4.6";

	test("keeps the warm model when switching does not clear the margin", () => {
		const cfg: RouterConfig = { ...BASE, hysteresis: { ...BASE.hysteresis, switchMargin: 1e6 } };
		const d = run({
			tier: "hard",
			promptTokens: 80_000,
			cfg,
			st: state({
				currentSlug: warmSlug,
				currentTier: "hard",
				cacheWarmSlug: warmSlug,
				cacheWarmAtMs: Date.now(),
				lastPromptTokens: 80_000,
			}),
		});
		expect(d.slug).toBe(warmSlug);
		expect(d.sticky).toBe(true);
	});

	test("abandons a warm cache whose TTL has expired", () => {
		const d = run({
			tier: "hard",
			promptTokens: 80_000,
			st: state({
				currentSlug: warmSlug,
				currentTier: "hard",
				cacheWarmSlug: warmSlug,
				// Long past the sticky-session window, so there is no cache left to keep.
				cacheWarmAtMs: Date.now() - BASE.hysteresis.cacheWarmTtlMs * 10,
				lastPromptTokens: 80_000,
			}),
		});
		expect(d.sticky).toBe(false);
	});
});

describe("budget guard", () => {
	test("downgrades when the cold forecast breaches the per-turn cap", () => {
		// A hard-tier turn at this size forecasts ~$0.02 cold, while cheaper
		// tiers land well under a cent, so a $0.005 cap is breachable AND
		// satisfiable further down.
		const cfg: RouterConfig = {
			...BASE,
			budget: { ...BASE.budget, perTurnUsd: 0.005, onExceeded: "downgrade" },
		};
		const d = run({ tier: "hard", promptTokens: 50_000, cfg });
		expect(d.budgetDowngraded).toBe(true);
		expect(d.forecast.coldUsd).toBeLessThanOrEqual(0.005);
	});

	test("throws in downgrade mode when no candidate at any tier fits", () => {
		// Failing loudly beats silently spending past an impossible cap.
		const cfg: RouterConfig = {
			...BASE,
			budget: { ...BASE.budget, perTurnUsd: 1e-9, onExceeded: "downgrade" },
		};
		expect(() => run({ tier: "hard", promptTokens: 50_000, cfg })).toThrow(BudgetExceededError);
	});

	test("rejects outright when configured to", () => {
		const cfg: RouterConfig = {
			...BASE,
			budget: { ...BASE.budget, perTurnUsd: 1e-9, onExceeded: "reject" },
		};
		expect(() => run({ tier: "hard", promptTokens: 50_000, cfg })).toThrow(BudgetExceededError);
	});

	test("a satisfiable budget does not downgrade", () => {
		const cfg: RouterConfig = { ...BASE, budget: { ...BASE.budget, perTurnUsd: 100, onExceeded: "reject" } };
		const d = run({ tier: "moderate", promptTokens: 5000, cfg });
		expect(d.budgetDowngraded).toBe(false);
	});

	test("scopes the daily budget to the requesting harness", () => {
		// Harness A has already spent the whole daily cap; harness B has spent
		// nothing. A request from B must NOT be budget-blocked by A's spend.
		const spendByHarness: Record<string, number> = { "harness-a": 1.0 };
		const ledger: Ledger = {
			record: () => {},
			conversationSpend: () => 0,
			spendSince: (_sinceMs, harnessId) => (harnessId === undefined ? 1.0 : spendByHarness[harnessId] ?? 0),
			blendedRate: () => null,
		latency: () => null,
			trust: () => null,
			allTrust: () => [],
			tokenRatio: () => null,
			recentEntries: () => [],
		};
		const cfg: RouterConfig = { ...BASE, budget: { ...BASE.budget, perDayUsd: 0.5, onExceeded: "reject" } };

		// Harness A is over its daily cap → rejected.
		expect(() => run({ tier: "hard", promptTokens: 50_000, cfg, ledger, harnessId: "harness-a" })).toThrow(
			BudgetExceededError,
		);
		// Harness B has spent nothing → not blocked by A's spend.
		const d = run({ tier: "hard", promptTokens: 50_000, cfg, ledger, harnessId: "harness-b" });
		expect(d.budgetDowngraded).toBe(false);
	});
});

describe("per-harness trust scoping", () => {
	// When filters.trustScopedByHarness is on, trust is read from the requesting
	// harness's own ledger rows, so one harness's flaky-model demotion does not
	// leak into another's routing. Off (default), trust is shared.
	const untrustedLedger = (): Ledger => ({
		record: () => {},
		conversationSpend: () => 0,
		spendSince: () => 0,
		blendedRate: () => null,
		latency: () => null,
		trust: (_slug, harnessId) => {
			// Harness A has burned the model; harness B has never tried it.
			if (harnessId === "harness-a") {
				return { slug: "x", attempts: 40, escalations: 30, errors: 30, successRate: 0.1, meanCostError: 0.2 };
			}
			return null; // harness B / shared → unmeasured
		},
		allTrust: () => [],
		tokenRatio: () => null,
		recentEntries: () => [],
	});

	test("scoped trust passes the harness id into the ledger trust query", () => {
		// The feature's contract is that the router's trust lookup is scoped to
		// the requesting harness when enabled. Assert the wiring directly rather
		// than via a post-rescue `rejected` reason, which tier-rescue relaxes.
		let queriedWith: string | undefined;
		const ledger: Ledger = {
			...untrustedLedger(),
			trust: (_slug, harnessId) => {
				queriedWith = harnessId;
				return null;
			},
		};
		const cfg: RouterConfig = {
			...BASE,
			filters: { ...BASE.filters, trustScopedByHarness: true },
		};
		run({ tier: "simple", cfg, ledger, harnessId: "harness-a" });
		expect(queriedWith).toBe("harness-a");
	});

	test("shared trust (default) reads the whole ledger, not per-harness", () => {
		// With scoping off, the trust lookup must NOT carry the harness id, so
		// harness A's flaky history is visible globally (shared reliability).
		let queriedWith: string | undefined;
		const ledger: Ledger = {
			...untrustedLedger(),
			trust: (_slug, harnessId) => {
				queriedWith = harnessId;
				return null;
			},
		};
		const cfg: RouterConfig = {
			...BASE,
			filters: { ...BASE.filters, trustScopedByHarness: false },
		};
		run({ tier: "simple", cfg, ledger, harnessId: "harness-a" });
		// The trust lookup must NOT carry the harness id when scoping is off.
		expect(queriedWith).toBeUndefined();
	});
});

describe("decision shape", () => {
	test("clamps max tokens to the chosen model's published ceiling", () => {
		const d = run({ tier: "moderate" });
		const chosen = MODELS.find((m) => m.slug === d.slug);
		const ceiling = chosen?.maxCompletionTokens;
		if (ceiling !== undefined && d.maxTokens !== undefined) {
			expect(d.maxTokens).toBeLessThanOrEqual(ceiling);
		}
	});

	test("plans a probe for cheap tiers and leaves the top tier unprobed", () => {
		expect(run({ tier: "trivial" }).probe.enabled).toBe(true);
		// Nothing above `hard` to escalate into, so probing it would only add latency.
		expect(run({ tier: "hard" }).probe.enabled).toBe(false);
	});

	test("carries the session id, features, and a reasoning trail", () => {
		const d = run({ tier: "simple" });
		expect(d.sessionId.startsWith("omp-")).toBe(true);
		expect(d.reasons.length).toBeGreaterThan(0);
		expect(d.features.toolCount).toBe(1);
		expect(d.considered.length).toBeGreaterThan(0);
	});

	test("respects a profile that caps the tier", () => {
		const req = request("redesign the whole architecture and explain the race condition root cause");
		const features = extractFeatures(req, 4000);
		const d = select({
			req,
			features,
			classification: scoreHeuristic(features, BASE),
			profile: { ...PROFILE, id: "auto-cheap", maxTier: "simple" },
			state: state(),
			snapshot: SNAPSHOT,
			ledger: null,
			cfg: BASE,
			nowMs: Date.now(),
		});
		expect(["trivial", "simple"]).toContain(d.tier);
	});
});

describe("tier rescue under a guardrail-constrained catalog", () => {
	// A tiny catalog containing only models that all fail the strict `trivial`
	// tier config: they exceed its price ceiling or fail its trust/quality bar.
	// Under the full catalog the cheap alternatives masked this; a guardrail
	// can remove them entirely.
	const pick = (slug: string): CatalogModel => {
		const m = MODELS.find((x) => x.slug === slug);
		if (m === undefined) throw new Error(`fixture missing ${slug}`);
		return m;
	};
	const constrained: CatalogSnapshot = {
		models: [pick("z-ai/glm-5.3"), pick("qwen/qwen3.8-2.4t-a95b"), pick("x-ai/grok-4.6")],
		fetchedAtMs: Date.now(),
		keyScoped: true,
	};

	function runConstrained(ledger: Ledger | null = null) {
		const req = request("refactor the service layer and explain the cache coherence contract");
		const features = extractFeatures(req, 4000);
		const heuristic = scoreHeuristic(features, BASE);
		return select({
			req,
			features,
			classification: { ...heuristic, tier: "trivial" as Tier },
			profile: PROFILE,
			state: state(),
			snapshot: constrained,
			ledger,
			cfg: BASE,
			nowMs: Date.now(),
		});
	}

	/** Every model is probed-and-failed: below the trust floor at every tier. */
	function untrustedLedger(): Ledger {
		return {
			record: () => {},
			conversationSpend: () => 0,
			spendSince: () => 0,
			blendedRate: () => null,
		latency: () => null,
			trust: (slug) => ({
				slug,
				attempts: 40,
				escalations: 30,
				errors: 30,
				successRate: 0.1,
				meanCostError: 0.2,
			}),
			allTrust: () => [],
			tokenRatio: () => null,
			recentEntries: () => [],
		};
	}

	test("rescues a model instead of throwing when no strict tier admits the catalog", () => {
		const d = runConstrained(untrustedLedger());
		// It must pick one of the available models, not throw `catalog exhausted`.
		expect(constrained.models.some((m) => m.slug === d.slug)).toBe(true);
	});

	test("records the rescue in the reasoning trail", () => {
		const d = runConstrained(untrustedLedger());
		expect(d.reasons.some((r) => r.startsWith("tier rescue:"))).toBe(true);
	});

	test("the rescue chooses the cheapest available model when quality is secondary", () => {
		const d = runConstrained(untrustedLedger());
		const chosen = MODELS.find((m) => m.slug === d.slug);
		expect(chosen).toBeDefined();
		// Price ceilings are relaxed first; the cheapest surviving model wins.
		const cheapest = constrained.models.reduce((a, b) => (a.price.prompt <= b.price.prompt ? a : b));
		expect(d.slug).toBe(cheapest.slug);
	});

	test("a guardrail that leaves every model below the trust bar is rescued by relaxing it", () => {
		// Reproduces the real failure: a tiny guardrail catalog whose models are
		// all marked untrusted (probed and failed). The trust floor (minTrust 0.7
		// over minTrustSamples 12) excludes them at EVERY tier, so strict widening
		// finds nothing; the rescue relaxes trust and picks a model.
		const d = runConstrained(untrustedLedger());
		expect(constrained.models.some((m) => m.slug === d.slug)).toBe(true);
		expect(d.reasons.some((r) => r.startsWith("tier rescue:"))).toBe(true);
	});

	test("still throws when the catalog is empty after relaxing all economic constraints", () => {
		const empty: CatalogSnapshot = { models: [], fetchedAtMs: Date.now(), keyScoped: true };
		const req = request("anything");
		const features = extractFeatures(req, 4000);
		const heuristic = scoreHeuristic(features, BASE);
		expect(() =>
			select({
				req,
				features,
				classification: { ...heuristic, tier: "trivial" as Tier },
				profile: PROFILE,
				state: state(),
				snapshot: empty,
				ledger: null,
				cfg: BASE,
				nowMs: Date.now(),
			}),
		).toThrow(/catalog exhausted/);
	});
});

describe("task-type routing", () => {
	test("a vision task only considers image-capable models", () => {
		// Force the vision task and a tier; every considered candidate must
		// support image input.
		const req = request("describe this image");
		const features = extractFeatures(req, 4000);
		const heuristic = scoreHeuristic(features, BASE);
		const d = select({
			req: { ...req, hasImages: true },
			features: { ...features, hasImages: true },
			classification: { ...heuristic, task: "vision" },
			profile: PROFILE,
			state: state(),
			snapshot: SNAPSHOT,
			ledger: null,
			cfg: BASE,
			nowMs: Date.now(),
		});
		expect(d.considered.length).toBeGreaterThan(0);
		for (const c of d.considered) expect(c.model.inputModalities.includes("image")).toBe(true);
	});

	test("the task config's quality floor overrides the tier floor when higher", () => {
		// A coding task with a high minQuality must not admit models below it,
		// even in a tier whose own floor is lower.
		const cfg: RouterConfig = {
			...BASE,
			tasks: { ...BASE.tasks, coding: { axis: "coding", minQuality: 60 } },
		};
		const req = request("refactor the service layer");
		const features = extractFeatures(req, 4000);
		const heuristic = scoreHeuristic(features, cfg);
		const d = select({
			req,
			features,
			classification: { ...heuristic, task: "coding" },
			profile: PROFILE,
			state: state(),
			snapshot: SNAPSHOT,
			ledger: null,
			cfg,
			nowMs: Date.now(),
		});
		// The task floor (60) is higher than the trivial tier floor (0); every
		// considered candidate must clear it. (A floor so high nothing qualifies
		// would trip tier rescue, so 60 is the meaningful override test.)
		expect(d.considered.length).toBeGreaterThan(0);
		for (const c of d.considered) {
			const q = c.model.quality.coding ?? c.model.quality.intelligence ?? 0;
			expect(q).toBeGreaterThanOrEqual(60);
		}
	});
});

describe("latency scoring", () => {
	function ledgerWithLatency(bySlug: Record<string, { ttftMs: number; samples: number; tokensPerSec?: number }>): Ledger {
		return {
			record: () => {},
			conversationSpend: () => 0,
			spendSince: () => 0,
			blendedRate: () => null,
			trust: () => null,
			allTrust: () => [],
			latency: (slug) => {
				const v = bySlug[slug];
				// Default throughput is fast, so these cases isolate the TTFT axis
				// unless a test sets tokensPerSec explicitly.
				return v === undefined ? null : { slug, samples: v.samples, ttftMs: v.ttftMs, tokensPerSec: v.tokensPerSec ?? 1000 };
			},
			tokenRatio: () => null,
			recentEntries: () => [],
		};
	}

	const withWeight = (latencyWeight: number): RouterConfig => ({
		...BASE,
		filters: { ...BASE.filters, latencyWeight, latencyReferenceMs: 5000, latencyMinSamples: 20 },
	});

	test("penalises a chronically slow model out of the top slot", () => {
		const slow = run({ tier: "simple" }).slug;
		const ledger = ledgerWithLatency({ [slow]: { ttftMs: 60_000, samples: 50 } });
		const d = run({ tier: "simple", cfg: withWeight(2), ledger });
		expect(d.slug).not.toBe(slow);
	});

	test("latencyWeight 0 disables the penalty", () => {
		const slow = run({ tier: "simple" }).slug;
		const ledger = ledgerWithLatency({ [slow]: { ttftMs: 60_000, samples: 50 } });
		expect(run({ tier: "simple", cfg: withWeight(0), ledger }).slug).toBe(slow);
	});

	test("a model with too few samples is not penalised", () => {
		const slow = run({ tier: "simple" }).slug;
		const ledger = ledgerWithLatency({ [slow]: { ttftMs: 60_000, samples: 5 } });
		expect(run({ tier: "simple", cfg: withWeight(2), ledger }).slug).toBe(slow);
	});

	test("penalises a model that starts fast but streams slowly", () => {
		// The case TTFT-only scoring misses: quick first token, slow body.
		const slow = run({ tier: "simple" }).slug;
		const ledger = ledgerWithLatency({ [slow]: { ttftMs: 1500, samples: 50, tokensPerSec: 12 } });
		const d = run({ tier: "simple", cfg: withWeight(2), ledger });
		expect(d.slug).not.toBe(slow);
	});
});

describe("context compaction", () => {
	const COMPACT_CFG: RouterConfig = {
		...BASE,
		compaction: {
			enabled: true,
			budgetTokens: 1_000,
			floorRatio: 1,
			fitToWindow: false,
			protectRecentTurns: 1,
			maxToolResultBytes: 100,
			keepHeadBytes: 20,
			keepTailBytes: 20,
			elideSupersededReads: true,
			collapseDuplicateResults: true,
		},
	};

	function loopReq(): NormRequest {
		return parseChatRequest(
			{
				model: "auto",
				tools: TOOLS,
				messages: [
					{ role: "system", content: "You are a coding agent." },
					{ role: "user", content: "read the file" },
					{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"big.ts"}' } }] },
					{ role: "tool", tool_call_id: "c1", content: "x".repeat(4000) },
					{ role: "user", content: "continue" },
				],
			},
			new Headers(),
		);
	}

	test("an over-budget turn produces a compaction plan and records savings", () => {
		const req = loopReq();
		const features = extractFeatures(req, 5_000); // over budgetTokens=1000
		const d = select({
			req,
			features,
			classification: scoreHeuristic(features, COMPACT_CFG),
			profile: PROFILE,
			state: state(),
			snapshot: SNAPSHOT,
			ledger: null,
			cfg: COMPACT_CFG,
			nowMs: Date.now(),
		});
		expect(d.compactionPlan.length).toBeGreaterThan(0);
		expect(d.promptTokensSaved).toBeGreaterThan(0);
		expect(d.reasons.some((r) => r.startsWith("compaction:"))).toBe(true);
	});

	test("a small turn is left untouched", () => {
		const req = loopReq();
		const features = extractFeatures(req, 500); // under budgetTokens=1000
		const d = select({
			req,
			features,
			classification: scoreHeuristic(features, COMPACT_CFG),
			profile: PROFILE,
			state: state(),
			snapshot: SNAPSHOT,
			ledger: null,
			cfg: COMPACT_CFG,
			nowMs: Date.now(),
		});
		expect(d.compactionPlan).toEqual([]);
		expect(d.promptTokensSaved).toBe(0);
	});

	test("a carried plan is re-applied even when the turn is now under budget", () => {
		// The prompt cache is a byte-prefix cache: dropping an edit that was
		// already dispatched rewrites history the upstream had cached, and
		// re-sends the tokens the edit saved. So a carried plan survives a turn
		// that would not have triggered compaction on its own.
		const req = loopReq();
		const over = extractFeatures(req, 5_000);
		const first = select({
			req,
			features: over,
			classification: scoreHeuristic(over, COMPACT_CFG),
			profile: PROFILE,
			state: state(),
			snapshot: SNAPSHOT,
			ledger: null,
			cfg: COMPACT_CFG,
			nowMs: Date.now(),
		});
		expect(first.compactionPlan.length).toBeGreaterThan(0);

		const under = extractFeatures(req, 500); // under budgetTokens=1000
		const second = select({
			req,
			features: under,
			classification: scoreHeuristic(under, COMPACT_CFG),
			profile: PROFILE,
			state: state({ compactionPlan: first.compactionPlan }),
			snapshot: SNAPSHOT,
			ledger: null,
			cfg: COMPACT_CFG,
			nowMs: Date.now(),
		});
		expect(second.compactionPlan).toEqual(first.compactionPlan);
		expect(second.promptTokensSaved).toBeGreaterThan(0);
	});

	test("floorRatio below 1 compacts strictly past the budget so the plan holds longer", () => {
		// Each plan change rewrites cached prompt bytes, so compaction overshoots
		// deliberately: eliding more now buys byte-stable turns later.
		const req = parseChatRequest(
			{
				model: "auto",
				tools: TOOLS,
				messages: [
					{ role: "system", content: "You are a coding agent." },
					{ role: "user", content: "read the files" },
					...[1, 2, 3, 4, 5, 6].flatMap((n) => [
						{ role: "assistant", content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read", arguments: `{"path":"f${n}.ts"}` } }] },
						{ role: "tool", tool_call_id: `c${n}`, content: `F${n}${"x".repeat(2000)}` },
					]),
					{ role: "user", content: "continue" },
				],
			},
			new Headers(),
		);
		// Prompt is ~12k bytes; claim 4000 tokens against a 1000-token budget, so
		// floorRatio 1 targets 1000 and floorRatio 0.5 targets 500.
		const features = extractFeatures(req, 4_000);
		const run = (floorRatio: number) =>
			select({
				req,
				features,
				classification: scoreHeuristic(features, COMPACT_CFG),
				profile: PROFILE,
				state: state(),
				snapshot: SNAPSHOT,
				ledger: null,
				cfg: { ...COMPACT_CFG, compaction: { ...COMPACT_CFG.compaction, floorRatio } },
				nowMs: Date.now(),
			});
		const tight = run(0.5);
		const loose = run(1);
		expect(tight.compactionPlan.length).toBeGreaterThan(loose.compactionPlan.length);
		expect(tight.promptTokensSaved).toBeGreaterThan(loose.promptTokensSaved);
	});
});
