import { describe, expect, test } from "bun:test";

import {
	newestId,
	selectToasts,
	toToastText,
	type ToastDecision,
} from "../omp-extension/toast-logic.ts";

function dec(partial: Partial<ToastDecision>): ToastDecision {
	return {
		id: "d1",
		slug: "meta/muse-glimmer-30b",
		servedSlug: null,
		tier: "trivial",
		reportedUsd: 0.0000123,
		wasted: false,
		...partial,
	};
}

describe("selectToasts", () => {
	test("toasts nothing on the first tick (lastSeenId null)", () => {
		const entries = [dec({ id: "a" }), dec({ id: "b" })];
		expect(selectToasts(entries, null)).toEqual([]);
	});

	test("toasts only entries newer than the last-seen id, oldest first", () => {
		// newest-first order: d3 is newest, d1 oldest
		const entries = [dec({ id: "d3", slug: "x/c" }), dec({ id: "d2", slug: "x/b" }), dec({ id: "d1", slug: "x/a" })];
		const toasts = selectToasts(entries, "d1");
		expect(toasts).toHaveLength(2);
		// oldest→newest emission order
		expect(toasts[0]?.model).toBe("x/b");
		expect(toasts[1]?.model).toBe("x/c");
	});

	test("skips wasted (abandoned escalation) entries", () => {
		const entries = [dec({ id: "d2", slug: "served", wasted: false }), dec({ id: "d1", wasted: true })];
		// both newer than lastSeenId ""; only the non-wasted one toasts
		expect(selectToasts(entries, "")).toHaveLength(1);
		const withPrior = [dec({ id: "d3", slug: "real", wasted: false }), dec({ id: "d2", wasted: true }), dec({ id: "d1", slug: "prior" })];
		const out = selectToasts(withPrior, "d1");
		expect(out).toHaveLength(1);
		expect(out[0]?.model).toBe("real");
	});

	test("empty input yields no toasts and null newest id", () => {
		expect(selectToasts([], "x")).toEqual([]);
		expect(newestId([])).toBeNull();
	});
});

describe("toToastText", () => {
	test("prefers servedSlug when present, else slug", () => {
		expect(toToastText(dec({ slug: "s/one", servedSlug: "s/real" }))).toContain("s/real");
		expect(toToastText(dec({ slug: "s/one", servedSlug: null }))).toContain("s/one");
	});

	test("includes cost when reported, omits otherwise", () => {
		expect(toToastText(dec({ reportedUsd: 0.5 }))).toContain("$0.50000");
		expect(toToastText(dec({ reportedUsd: null }))).not.toContain("$");
	});

	test("renders model [tier]", () => {
		expect(toToastText(dec({ slug: "q/w", tier: "hard", reportedUsd: null }))).toBe("q/w [hard]");
	});
});
