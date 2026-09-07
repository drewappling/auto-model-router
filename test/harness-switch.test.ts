import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { TIER_ORDER } from "../src/router/types.ts";
import { advise } from "../src/server/advise.ts";
import { decideSwitch, nativeModelFor, parseSwitchPolicy, type SwitchPolicy } from "../omp-extension/switch-logic.ts";

/**
 * Harness-side model switch: the router's prompt-only advice, and the
 * extension's decision about moving omp's active model.
 */

describe("advise", () => {
	test("classifies a prompt without a ledger or dispatch and reports the shape the extension reads", () => {
		const a = advise(DEFAULT_CONFIG, null, { ompSessionId: "s", harnessId: "", text: "Redesign the routing pipeline so escalation and failover share one retry loop; consider cache costs and write the migration plan." });
		expect(TIER_ORDER).toContain(a.tier);
		expect(a.confidence).toBeGreaterThanOrEqual(0);
		expect(a.confidence).toBeLessThanOrEqual(1);
		expect(a.reasons.length).toBeGreaterThan(0);
		expect(a.lastTier).toBeNull();
		const terse = advise(DEFAULT_CONFIG, null, { ompSessionId: "", harnessId: "", text: "ok" });
		expect(TIER_ORDER.indexOf(terse.tier)).toBeLessThanOrEqual(TIER_ORDER.indexOf(a.tier));
	});
});

describe("switch policy", () => {
	test("parses defensively and maps a tier to the nearest configured tier at or below it", () => {
		expect(parseSwitchPolicy(null).enabled).toBe(false);
		const p = parseSwitchPolicy({ enabled: true, models: { moderate: "anthropic/claude-sonnet-5", hard: "anthropic/claude-opus-4-8", simple: "no-slash" }, minConfidence: 0.5 });
		expect(p.models).toEqual({ moderate: "anthropic/claude-sonnet-5", hard: "anthropic/claude-opus-4-8" });
		expect(nativeModelFor(p, "hard")).toBe("anthropic/claude-opus-4-8");
		expect(nativeModelFor(p, "moderate")).toBe("anthropic/claude-sonnet-5");
		expect(nativeModelFor(p, "simple")).toBeUndefined();
		expect(nativeModelFor(p, "trivial")).toBeUndefined();
	});
});

describe("decideSwitch", () => {
	const policy: SwitchPolicy = { enabled: true, models: { hard: "anthropic/claude-opus-4-8" }, minConfidence: 0.6 };
	const router = "auto-model-router/auto";

	test("moves up from the router for confident hard work, back for lighter work, and never past a manual choice", () => {
		const up = decideSwitch({ policy, advised: { tier: "hard", confidence: 0.8 }, active: router, activeIsRouter: true, switchedTo: null, returnTo: null });
		expect(up).toMatchObject({ action: "up", model: "anthropic/claude-opus-4-8" });
		// Low confidence: stay.
		expect(decideSwitch({ policy, advised: { tier: "hard", confidence: 0.3 }, active: router, activeIsRouter: true, switchedTo: null, returnTo: null }).action).toBe("none");
		// Unmapped tier while on the router: stay.
		expect(decideSwitch({ policy, advised: { tier: "moderate", confidence: 0.9 }, active: router, activeIsRouter: true, switchedTo: null, returnTo: null }).action).toBe("none");
		// On our own switch, hard again: already there.
		expect(decideSwitch({ policy, advised: { tier: "hard", confidence: 0.9 }, active: "anthropic/claude-opus-4-8", activeIsRouter: false, switchedTo: "anthropic/claude-opus-4-8", returnTo: router }).action).toBe("none");
		// On our own switch, lighter work: back to the router model we left.
		expect(decideSwitch({ policy, advised: { tier: "simple", confidence: 0.9 }, active: "anthropic/claude-opus-4-8", activeIsRouter: false, switchedTo: "anthropic/claude-opus-4-8", returnTo: router })).toMatchObject({ action: "back", model: router });
		// The user chose a model by hand: leave it alone whatever the advice.
		expect(decideSwitch({ policy, advised: { tier: "hard", confidence: 0.9 }, active: "openai/gpt-5", activeIsRouter: false, switchedTo: null, returnTo: null }).action).toBe("none");
		expect(decideSwitch({ policy, advised: { tier: "trivial", confidence: 0.9 }, active: "openai/gpt-5", activeIsRouter: false, switchedTo: "anthropic/claude-opus-4-8", returnTo: router }).action).toBe("none");
		// Disabled: nothing moves.
		expect(decideSwitch({ policy: { ...policy, enabled: false }, advised: { tier: "hard", confidence: 0.9 }, active: router, activeIsRouter: true, switchedTo: null, returnTo: null }).action).toBe("none");
	});
});
