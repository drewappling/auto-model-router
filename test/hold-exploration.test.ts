import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { explorationDraw, resolveHoldTurns } from "../src/router/explore.ts";

// Shipped defaults, not loadConfig({}) — the latter merges the live home
// config.yml and makes this suite depend on the developer's local settings.
const BASE = DEFAULT_CONFIG;

function withHold(over: { enabled?: boolean; values?: number[] }, enabled = true): RouterConfig {
	return {
		...BASE,
		exploration: {
			...BASE.exploration,
			enabled,
			holdTurns: { enabled: over.enabled ?? true, values: over.values ?? [2, 3, 4] },
		},
	};
}

describe("hold exploration is opt-in", () => {
	test("shipped defaults leave the hold alone", () => {
		expect(BASE.exploration.holdTurns.enabled).toBe(false);
		const got = resolveHoldTurns(BASE, "conv-1", true);
		expect(got.turns).toBe(BASE.hysteresis.holdTurnsAfterEscalation);
		expect(got.arm).toBeNull();
	});

	test("hold exploration stays off while exploration as a whole is off", () => {
		const cfg = withHold({ values: [1] }, false);
		const got = resolveHoldTurns(cfg, "conv-1", true);
		expect(got.turns).toBe(BASE.hysteresis.holdTurnsAfterEscalation);
		expect(got.arm).toBeNull();
	});

	test("an explicitly disabled hold experiment is inert", () => {
		const cfg = withHold({ enabled: false, values: [1] });
		expect(resolveHoldTurns(cfg, "conv-1", true).arm).toBeNull();
	});
});

describe("only the post-escalation hold is randomised", () => {
	const cfg = withHold({ values: [1] });

	test("an escalated turn uses the drawn arm", () => {
		expect(resolveHoldTurns(cfg, "conv-1", true).turns).toBe(1);
	});

	test("an ordinary turn keeps the configured hold", () => {
		// The experiment targets the hold that governs expensive spend; leaving
		// the ordinary hold fixed keeps the comparison narrow enough to read.
		expect(resolveHoldTurns(cfg, "conv-1", false).turns).toBe(BASE.hysteresis.holdTurns);
	});

	test("but the arm is still recorded on non-escalated turns", () => {
		// Intention-to-treat: arms are compared on whole-conversation cost, so
		// every turn of an assigned conversation has to carry its arm.
		expect(resolveHoldTurns(cfg, "conv-1", false).arm).toBe(1);
	});
});

describe("assignment is per conversation", () => {
	const cfg = withHold({ values: [2, 3, 4] });

	test("the same conversation always draws the same arm", () => {
		const first = resolveHoldTurns(cfg, "conv-stable", true).arm;
		for (let i = 0; i < 20; i++) {
			expect(resolveHoldTurns(cfg, "conv-stable", true).arm).toBe(first);
		}
	});

	test("the arm never changes mid-hold, whatever the escalation state", () => {
		const a: number | null = resolveHoldTurns(cfg, "conv-x", true).arm;
		const b = resolveHoldTurns(cfg, "conv-x", false).arm;
		expect(a).toEqual(b);
	});

	test("every drawn arm comes from the configured set", () => {
		for (let i = 0; i < 200; i++) {
			const arm = resolveHoldTurns(cfg, `conv-${i}`, true).arm;
			expect(arm).not.toBeNull();
			expect([2, 3, 4]).toContain(arm ?? -1);
		}
	});

	test("arms are spread across conversations rather than collapsing to one", () => {
		const counts = new Map<number, number>();
		const N = 600;
		for (let i = 0; i < N; i++) {
			const arm = resolveHoldTurns(cfg, `spread-${i}`, true).arm ?? -1;
			counts.set(arm, (counts.get(arm) ?? 0) + 1);
		}
		expect(counts.size).toBe(3);
		// Deterministic hash, so this cannot flake. Each of 3 arms should land
		// near N/3; the band is wide enough that only real bias would fail.
		for (const [, n] of counts) {
			expect(n).toBeGreaterThan(N / 3 - 60);
			expect(n).toBeLessThan(N / 3 + 60);
		}
	});

	test("a single-value set assigns everyone the same arm", () => {
		const one = withHold({ values: [3] });
		for (let i = 0; i < 20; i++) {
			expect(resolveHoldTurns(one, `conv-${i}`, true).turns).toBe(3);
		}
	});
});

describe("the draw itself", () => {
	test("is uniform in [0,1) and stable for a seed", () => {
		expect(explorationDraw("seed-a")).toBe(explorationDraw("seed-a"));
		expect(explorationDraw("seed-a")).not.toBe(explorationDraw("seed-b"));
		for (const seed of ["a", "b", "c", "d", "e"]) {
			const d = explorationDraw(seed);
			expect(d).toBeGreaterThanOrEqual(0);
			expect(d).toBeLessThan(1);
		}
	});

	test("the tier draw and the hold draw are independent seeds", () => {
		// Sharing a seed would correlate the two experiments and confound both.
		expect(explorationDraw("hold:conv-1")).not.toBe(explorationDraw("explore:conv-1:1"));
	});
});
