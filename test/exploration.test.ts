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
		updatedAtMs: Date.now(),
		...over,
	};
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
		nowMs: Date.now(),
		...(opts.excludeSlugs === undefined ? {} : { excludeSlugs: opts.excludeSlugs }),
	});
}

describe("exploration is opt-in", () => {
	test("never fires under the shipped defaults", () => {
		expect(BASE.exploration.enabled).toBe(false);
		for (const tier of ["simple", "moderate", "hard"] as Tier[]) {
			expect(run({ tier }).explored).toBeNull();
		}
	});

	test("a zero rate never fires even when enabled", () => {
		const cfg = withExploration({ enabled: true, rate: 0 });
		for (const tier of ["simple", "moderate", "hard"] as Tier[]) {
			expect(run({ tier, cfg }).explored).toBeNull();
		}
	});
});

describe("exploration drops exactly one tier", () => {
	const cfg = withExploration({ enabled: true, rate: 1 });

	test("moderate explores down to simple", () => {
		const d = run({ tier: "moderate", cfg });
		expect(d.explored).toEqual({ from: "moderate", to: "simple" });
	});

	test("hard explores down to moderate, never further", () => {
		const d = run({ tier: "hard", cfg });
		expect(d.explored).toEqual({ from: "hard", to: "moderate" });
	});

	test("trivial is the floor and cannot be explored below", () => {
		expect(run({ tier: "trivial", cfg }).explored).toBeNull();
	});

	test("the decision trail says so out loud", () => {
		const d = run({ tier: "moderate", cfg });
		expect(d.reasons.some((r) => r.startsWith("exploration:"))).toBe(true);
	});
});

describe("exploration respects the guards", () => {
	const cfg = withExploration({ enabled: true, rate: 1 });

	test("never routes below the profile floor", () => {
		const floored: ProfileConfig = { ...PROFILE, minTier: "moderate" };
		const d = run({ tier: "moderate", cfg, profile: floored });
		expect(d.explored).toBeNull();
	});

	test("skips a tier the config excludes", () => {
		const only = withExploration({ enabled: true, rate: 1, tiers: ["hard"] });
		expect(run({ tier: "moderate", cfg: only }).explored).toBeNull();
		expect(run({ tier: "hard", cfg: only }).explored).not.toBeNull();
	});

	test("skips forced escalations, which already proved the cheap tier failed", () => {
		const d = run({ tier: "moderate", cfg, source: "escalation" });
		expect(d.explored).toBeNull();
	});

	test("skips failover retries so a second confound is not introduced", () => {
		const d = run({ tier: "moderate", cfg, excludeSlugs: ["vendor/broken"] });
		expect(d.explored).toBeNull();
	});

	test("skips while hysteresis holds, protecting the warm cache", () => {
		const held = state({ turn: 1, stickyUntilTurn: 5, currentTier: "hard" });
		const d = run({ tier: "moderate", cfg, st: held });
		expect(d.explored).toBeNull();
	});
});

describe("exploration is deterministic", () => {
	const cfg = withExploration({ enabled: true, rate: 0.5 });

	test("the same turn always draws the same way, so explain can replay it", () => {
		for (const text of ["alpha task", "beta task", "gamma task"]) {
			const first = run({ userText: text, tier: "moderate", cfg });
			for (let i = 0; i < 5; i++) {
				expect(run({ userText: text, tier: "moderate", cfg }).explored).toEqual(first.explored);
			}
		}
	});

	test("the draw honours the configured rate across many turns", () => {
		const cfg25 = withExploration({ enabled: true, rate: 0.25 });
		let explored = 0;
		const N = 400;
		for (let i = 0; i < N; i++) {
			if (run({ userText: `distinct task ${i}`, tier: "moderate", cfg: cfg25 }).explored !== null) explored++;
		}
		// Deterministic hash, so this cannot flake; the band is wide enough that
		// only a genuinely biased draw would fail it.
		expect(explored).toBeGreaterThan(N * 0.25 - 40);
		expect(explored).toBeLessThan(N * 0.25 + 40);
	});
});
