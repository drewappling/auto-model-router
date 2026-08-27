import { describe, expect, test } from "bun:test";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot } from "../src/catalog/types.ts";
import { loadConfig } from "../src/config/load.ts";
import type { ExplorationConfig, ProfileConfig, RouterConfig } from "../src/config/types.ts";
import { scoreHeuristic } from "../src/router/classify.ts";
import { extractFeatures } from "../src/router/features.ts";
import { select } from "../src/router/select.ts";
import type { ClassificationSource, ConversationState, Tier } from "../src/router/types.ts";
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
const NOW = Date.now();

function request(userText: string): NormRequest {
	return parseChatRequest(
		{
			model: "auto",
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
		updatedAtMs: NOW,
		...over,
	};
}

/** A hysteresis hold at the given tier, with the prompt cache warm or expired. */
function heldState(held: Tier, cache: "warm" | "cold"): ConversationState {
	return state({
		turn: 1,
		stickyUntilTurn: 5,
		currentTier: held,
		currentSlug: "vendor/model",
		cacheWarmSlug: cache === "warm" ? "vendor/model" : null,
		cacheWarmAtMs: cache === "warm" ? NOW : 0,
	});
}

function withExploration(over: Partial<ExplorationConfig>): RouterConfig {
	return { ...BASE, exploration: { ...BASE.exploration, ...over } };
}

function run(opts: {
	userText?: string;
	cfg?: RouterConfig;
	st?: ConversationState;
	tier?: Tier;
	source?: ClassificationSource;
	profile?: ProfileConfig;
	excludeSlugs?: readonly string[];
}) {
	const cfg = opts.cfg ?? BASE;
	const req = request(opts.userText ?? "tidy the retry helper");
	const features = extractFeatures(req, 4000);
	const heuristic = scoreHeuristic(features, cfg);
	const classification = {
		...heuristic,
		...(opts.tier === undefined ? {} : { tier: opts.tier }),
		...(opts.source === undefined ? {} : { source: opts.source }),
	};
	return select({
		req,
		features,
		classification,
		profile: opts.profile ?? PROFILE,
		state: opts.st ?? state(),
		snapshot: SNAPSHOT,
		ledger: null,
		cfg,
		nowMs: NOW,
		...(opts.excludeSlugs === undefined ? {} : { excludeSlugs: opts.excludeSlugs }),
	});
}

const ALWAYS = { simple: 1, moderate: 1, hard: 1 };

describe("exploration is opt-in", () => {
	test("never fires under the shipped defaults", () => {
		expect(BASE.exploration.enabled).toBe(false);
		for (const tier of ["simple", "moderate", "hard"] as Tier[]) {
			expect(run({ tier }).explored).toBeNull();
		}
	});

	test("enabled with no rates configured still never fires", () => {
		const cfg = withExploration({ enabled: true, rates: {} });
		for (const tier of ["simple", "moderate", "hard"] as Tier[]) {
			expect(run({ tier, cfg }).explored).toBeNull();
		}
	});
});

describe("per-tier rates", () => {
	test("each tier is governed by its own rate, not one global one", () => {
		const cfg = withExploration({ enabled: true, rates: { simple: 0, moderate: 0, hard: 1 } });
		expect(run({ tier: "simple", cfg }).explored).toBeNull();
		expect(run({ tier: "moderate", cfg }).explored).toBeNull();
		expect(run({ tier: "hard", cfg }).explored).toEqual({ from: "hard", to: "moderate" });
	});

	test("a tier absent from the rates map is never explored", () => {
		const cfg = withExploration({ enabled: true, rates: { hard: 1 } });
		expect(run({ tier: "moderate", cfg }).explored).toBeNull();
		expect(run({ tier: "hard", cfg }).explored).not.toBeNull();
	});

	test("the shipped defaults weight expensive tiers far above cheap ones", () => {
		const r = BASE.exploration.rates;
		expect(r.hard ?? 0).toBeGreaterThan(r.simple ?? 0);
		expect(r.moderate ?? 0).toBeGreaterThan(r.simple ?? 0);
	});
});

describe("exploration drops exactly one tier", () => {
	const cfg = withExploration({ enabled: true, rates: ALWAYS });

	test("moderate explores down to simple", () => {
		expect(run({ tier: "moderate", cfg }).explored).toEqual({ from: "moderate", to: "simple" });
	});

	test("hard explores down to moderate, never further", () => {
		expect(run({ tier: "hard", cfg }).explored).toEqual({ from: "hard", to: "moderate" });
	});

	test("trivial is the floor and cannot be explored below", () => {
		expect(run({ tier: "trivial", cfg }).explored).toBeNull();
	});

	test("the decision trail says so out loud", () => {
		expect(run({ tier: "moderate", cfg }).reasons.some((r) => r.startsWith("exploration:"))).toBe(true);
	});
});

describe("hysteresis holds are explored only once the cache is cold", () => {
	const cfg = withExploration({ enabled: true, rates: ALWAYS, stickyPolicy: "cold-cache" });

	test("a held tier with a WARM cache is left alone", () => {
		expect(run({ tier: "simple", cfg, st: heldState("hard", "warm") }).explored).toBeNull();
	});

	test("a held tier with a COLD cache is explorable", () => {
		// This is the population that carries most of the spend: turns that
		// reach hard by hold rather than by classification.
		expect(run({ tier: "simple", cfg, st: heldState("hard", "cold") }).explored).toEqual({
			from: "hard",
			to: "moderate",
		});
	});

	test("the reason names the hold and the cache state, for later analysis", () => {
		const d = run({ tier: "simple", cfg, st: heldState("hard", "cold") });
		expect(d.reasons.some((r) => r.includes("held tier (cold cache)"))).toBe(true);
	});

	test("stickyPolicy never leaves holds alone entirely", () => {
		const off = withExploration({ enabled: true, rates: ALWAYS, stickyPolicy: "never" });
		expect(run({ tier: "simple", cfg: off, st: heldState("hard", "cold") }).explored).toBeNull();
		expect(run({ tier: "simple", cfg: off, st: heldState("hard", "warm") }).explored).toBeNull();
	});

	test("stickyPolicy always reaches held turns even with a live cache", () => {
		// The only setting that samples the population carrying most of the
		// spend, at the price of a forfeited cache read.
		const always = withExploration({ enabled: true, rates: ALWAYS, stickyPolicy: "always" });
		expect(run({ tier: "simple", cfg: always, st: heldState("hard", "warm") }).explored).toEqual({
			from: "hard",
			to: "moderate",
		});
		expect(
			run({ tier: "simple", cfg: always, st: heldState("hard", "warm") }).reasons.some((r) =>
				r.includes("held tier (warm cache)"),
			),
		).toBe(true);
	});
});

describe("exploration respects the remaining guards", () => {
	const cfg = withExploration({ enabled: true, rates: ALWAYS });

	test("never routes below the profile floor", () => {
		const floored: ProfileConfig = { ...PROFILE, minTier: "moderate" };
		expect(run({ tier: "moderate", cfg, profile: floored }).explored).toBeNull();
	});

	test("skips forced escalations, which already proved the cheap tier failed", () => {
		expect(run({ tier: "moderate", cfg, source: "escalation" }).explored).toBeNull();
	});

	test("skips failover retries so a second confound is not introduced", () => {
		expect(run({ tier: "moderate", cfg, excludeSlugs: ["vendor/broken"] }).explored).toBeNull();
	});
});

describe("exploration is deterministic", () => {
	const cfg = withExploration({ enabled: true, rates: { simple: 0.5, moderate: 0.5, hard: 0.5 } });

	test("the same turn always draws the same way, so explain can replay it", () => {
		for (const text of ["alpha task", "beta task", "gamma task"]) {
			const first = run({ userText: text, tier: "moderate", cfg });
			for (let i = 0; i < 5; i++) {
				expect(run({ userText: text, tier: "moderate", cfg }).explored).toEqual(first.explored);
			}
		}
	});

	test("the draw honours the configured rate across many turns", () => {
		const cfg25 = withExploration({ enabled: true, rates: { moderate: 0.25 } });
		let explored = 0;
		const N = 400;
		for (let i = 0; i < N; i++) {
			if (run({ userText: "distinct task " + i, tier: "moderate", cfg: cfg25 }).explored !== null) explored++;
		}
		// Deterministic hash, so this cannot flake; the band is wide enough that
		// only a genuinely biased draw would fail it.
		expect(explored).toBeGreaterThan(N * 0.25 - 40);
		expect(explored).toBeLessThan(N * 0.25 + 40);
	});
});
