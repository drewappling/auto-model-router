import { describe, expect, test } from "bun:test";

import { parse as parseYaml } from "yaml";

import {
	DEFAULT_ROUTER_URL,
	newestId,
	resolveRouterUrl,
	selectToasts,
	toToastText,
	type ToastDecision,
} from "../omp-extension/toast-logic.ts";

describe("resolveRouterUrl", () => {
	const resolve = (env: string | undefined, text: string | null): string =>
		resolveRouterUrl(env, text, parseYaml);

	test("an explicit override wins over the config", () => {
		expect(resolve("http://host:9999", "server:\n  port: 8788\n")).toBe("http://host:9999");
	});

	test("reads host and port from the router's own config", () => {
		// The bug this prevents: defaulting to 8787 polls whatever else owns that
		// port once the router has been moved, and toasts silently never appear.
		expect(resolve(undefined, "server:\n  host: 127.0.0.1\n  port: 8788\n")).toBe("http://127.0.0.1:8788");
	});

	test("a port-only config keeps the loopback default host", () => {
		expect(resolve(undefined, "server:\n  port: 8790\n")).toBe("http://127.0.0.1:8790");
	});

	test("a wildcard listen address becomes loopback", () => {
		expect(resolve(undefined, "server:\n  host: 0.0.0.0\n  port: 8788\n")).toBe("http://127.0.0.1:8788");
		expect(resolve(undefined, "server:\n  host: '::'\n  port: 8788\n")).toBe("http://127.0.0.1:8788");
	});

	test("falls back when there is no config, no server block, or junk", () => {
		expect(resolve(undefined, null)).toBe(DEFAULT_ROUTER_URL);
		expect(resolve(undefined, "")).toBe(DEFAULT_ROUTER_URL);
		expect(resolve(undefined, "logLevel: debug\n")).toBe(DEFAULT_ROUTER_URL);
		expect(resolve(undefined, "server: 5\n")).toBe(DEFAULT_ROUTER_URL);
	});

	test("ignores a non-integer or non-positive port", () => {
		expect(resolve(undefined, "server:\n  port: 0\n")).toBe(DEFAULT_ROUTER_URL);
		expect(resolve(undefined, "server:\n  port: notaport\n")).toBe(DEFAULT_ROUTER_URL);
	});

	test("an empty env override does not shadow the config", () => {
		expect(resolve("", "server:\n  port: 8788\n")).toBe("http://127.0.0.1:8788");
	});
});

function dec(partial: Partial<ToastDecision>): ToastDecision {
	return {
		id: "d1",
		slug: "meta/muse-glimmer-30b",
		servedSlug: null,
		tier: "trivial",
		reportedUsd: 0.0000123,
		wasted: false,
		harnessId: "",
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

	test("filters to the requesting harness when one is set", () => {
		const entries = [
			dec({ id: "d3", slug: "mine", harnessId: "harness-a" }),
			dec({ id: "d2", slug: "other", harnessId: "harness-b" }),
			dec({ id: "d1", slug: "prior", harnessId: "harness-a" }),
		];
		// Only harness-a entries newer than d1 toast; harness-b is excluded.
		const toasts = selectToasts(entries, "d1", "harness-a");
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.model).toBe("mine");
	});

	test("empty harness id toasts every harness", () => {
		const entries = [
			dec({ id: "d2", slug: "a", harnessId: "harness-a" }),
			dec({ id: "d1", slug: "b", harnessId: "harness-b" }),
		];
		expect(selectToasts(entries, "", "")).toHaveLength(2);
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
