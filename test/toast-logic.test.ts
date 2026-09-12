import { describe, expect, test } from "bun:test";

import { parse as parseYaml } from "yaml";

import {
	DEFAULT_ROUTER_URL,
	newestId,
	providerOf,
	resolveRouterUrl,
	factsOf,
	selectToasts,
	toToastText,
	whyReasons,
	type ToastDecision,
} from "../omp-extension/toast-logic.ts";

describe("resolveRouterUrl", () => {
	const resolve = (env: string | undefined, text: string | null): string =>
		resolveRouterUrl(env, text, parseYaml);

	test("the embed port file wins over AUTO_MODEL_ROUTER_PORT and the config", async () => {
		// The embedded router binds a free OS-assigned port and writes it to the
		// port file; the toast must poll that actual address, not a stale config.
		expect(resolveRouterUrl(undefined, "server:\n  port: 8788\n", parseYaml, "8812", 45678)).toBe(
			"http://127.0.0.1:45678",
		);
	});

	test("AUTO_MODEL_ROUTER_URL still beats the embed port file", async () => {
		expect(resolveRouterUrl("http://host:9999", "server:\n  port: 8788\n", parseYaml, "8812", 45678)).toBe(
			"http://host:9999",
		);
	});

	test("an embed port file of null falls back to AUTO_MODEL_ROUTER_PORT", async () => {
		expect(resolveRouterUrl(undefined, "server:\n  port: 8788\n", parseYaml, "8812", null)).toBe("http://127.0.0.1:8812");
	});

	test("AUTO_MODEL_ROUTER_URL still beats AUTO_MODEL_ROUTER_PORT", async () => {
		expect(resolveRouterUrl("http://host:9999", "server:\n  port: 8788\n", parseYaml, "8812")).toBe("http://host:9999");
	});

	test("an invalid AUTO_MODEL_ROUTER_PORT falls back to the config port", async () => {
		expect(resolveRouterUrl(undefined, "server:\n  port: 8788\n", parseYaml, "notaport")).toBe("http://127.0.0.1:8788");
		expect(resolveRouterUrl(undefined, "server:\n  port: 8788\n", parseYaml, "70000")).toBe("http://127.0.0.1:8788");
	});

	test("AUTO_MODEL_ROUTER_PORT with no config uses loopback", async () => {
		expect(resolveRouterUrl(undefined, null, parseYaml, "8812")).toBe("http://127.0.0.1:8812");
	});

	test("reads host and port from the router's own config", async () => {
		// The bug this prevents: defaulting to 8788 polls whatever else owns that
		// port once the router has been moved, and toasts silently never appear.
		expect(resolve(undefined, "server:\n  host: 127.0.0.1\n  port: 8788\n")).toBe("http://127.0.0.1:8788");
	});

	test("a port-only config keeps the loopback default host", async () => {
		expect(resolve(undefined, "server:\n  port: 8790\n")).toBe("http://127.0.0.1:8790");
	});

	test("a wildcard listen address becomes loopback", async () => {
		expect(resolve(undefined, "server:\n  host: 0.0.0.0\n  port: 8788\n")).toBe("http://127.0.0.1:8788");
		expect(resolve(undefined, "server:\n  host: '::'\n  port: 8788\n")).toBe("http://127.0.0.1:8788");
	});

	test("falls back when there is no config, no server block, or junk", async () => {
		expect(resolve(undefined, null)).toBe(DEFAULT_ROUTER_URL);
		expect(resolve(undefined, "")).toBe(DEFAULT_ROUTER_URL);
		expect(resolve(undefined, "logLevel: debug\n")).toBe(DEFAULT_ROUTER_URL);
		expect(resolve(undefined, "server: 5\n")).toBe(DEFAULT_ROUTER_URL);
	});

	test("ignores a non-integer or non-positive port", async () => {
		expect(resolve(undefined, "server:\n  port: 0\n")).toBe(DEFAULT_ROUTER_URL);
		expect(resolve(undefined, "server:\n  port: notaport\n")).toBe(DEFAULT_ROUTER_URL);
	});

	test("an empty env override does not shadow the config", async () => {
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
	test("toasts nothing on the first tick (lastSeenId null)", async () => {
		const entries = [dec({ id: "a" }), dec({ id: "b" })];
		expect(selectToasts(entries, null)).toEqual([]);
	});

	test("toasts only entries newer than the last-seen id, oldest first", async () => {
		// newest-first order: d3 is newest, d1 oldest
		const entries = [dec({ id: "d3", slug: "x/c" }), dec({ id: "d2", slug: "x/b" }), dec({ id: "d1", slug: "x/a" })];
		const toasts = selectToasts(entries, "d1");
		expect(toasts).toHaveLength(2);
		// oldest→newest emission order
		expect(toasts[0]?.model).toBe("x/b");
		expect(toasts[1]?.model).toBe("x/c");
	});

	test("skips wasted (abandoned escalation) entries", async () => {
		const entries = [dec({ id: "d2", slug: "served", wasted: false }), dec({ id: "d1", wasted: true })];
		// both newer than lastSeenId ""; only the non-wasted one toasts
		expect(selectToasts(entries, "")).toHaveLength(1);
		const withPrior = [dec({ id: "d3", slug: "real", wasted: false }), dec({ id: "d2", wasted: true }), dec({ id: "d1", slug: "prior" })];
		const out = selectToasts(withPrior, "d1");
		expect(out).toHaveLength(1);
		expect(out[0]?.model).toBe("real");
	});

	test("empty input yields no toasts and null newest id", async () => {
		expect(selectToasts([], "x")).toEqual([]);
		expect(newestId([])).toBeNull();
	});

	test("filters to the requesting harness when one is set", async () => {
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

	test("empty harness id toasts every harness", async () => {
		const entries = [
			dec({ id: "d2", slug: "a", harnessId: "harness-a" }),
			dec({ id: "d1", slug: "b", harnessId: "harness-b" }),
		];
		expect(selectToasts(entries, "", "")).toHaveLength(2);
	});

	test("filters to the requesting omp session when one is set", async () => {
		// Two interactive omp sessions sharing one router's ledger: session-a's
		// toast must not surface session-b's decisions.
		const entries = [
			dec({ id: "d3", slug: "mine", ompSessionId: "sess-a" }),
			dec({ id: "d2", slug: "other", ompSessionId: "sess-b" }),
			dec({ id: "d1", slug: "prior", ompSessionId: "sess-a" }),
		];
		const toasts = selectToasts(entries, "d1", "", "sess-a");
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.model).toBe("mine");
	});

	test("empty omp session id toasts every session", async () => {
		const entries = [
			dec({ id: "d2", slug: "a", ompSessionId: "sess-a" }),
			dec({ id: "d1", slug: "b", ompSessionId: "sess-b" }),
		];
		expect(selectToasts(entries, "", "", "")).toHaveLength(2);
	});

	test("harness and session filters compose", async () => {
		const entries = [
			dec({ id: "d3", slug: "keep", harnessId: "h", ompSessionId: "sess-a" }),
			dec({ id: "d2", slug: "wrong-session", harnessId: "h", ompSessionId: "sess-b" }),
			dec({ id: "d1", slug: "wrong-harness", harnessId: "other", ompSessionId: "sess-a" }),
		];
		const toasts = selectToasts(entries, "", "h", "sess-a");
		expect(toasts).toHaveLength(1);
		expect(toasts[0]?.model).toBe("keep");
	});
});

describe("toToastText", () => {
	test("prefers servedSlug when present, else slug", async () => {
		expect(toToastText(dec({ slug: "s/one", servedSlug: "s/real" }))).toContain("s/real");
		expect(toToastText(dec({ slug: "s/one", servedSlug: null }))).toContain("s/one");
	});

	test("includes cost when reported, omits otherwise", async () => {
		expect(toToastText(dec({ reportedUsd: 0.5 }))).toContain("$0.50000");
		expect(toToastText(dec({ reportedUsd: null }))).not.toContain("$");
	});

	test("renders provider · model [tier]", async () => {
		expect(toToastText(dec({ slug: "q/w", tier: "hard", reportedUsd: null }))).toBe("openrouter · q/w [hard]");
	});

	test("an Ollama slug is labelled with its provider and shown without the prefix", async () => {
		expect(toToastText(dec({ slug: "ollama/glm-5.3-flash", servedSlug: "ollama/glm-5.3-flash", tier: "moderate", reportedUsd: 0.0007 }))).toBe(
			"ollama · glm-5.3-flash [moderate] · $0.00070",
		);
		expect(providerOf("ollama/gpt-oss:120b")).toEqual({ provider: "ollama", model: "gpt-oss:120b" });
		expect(providerOf("z-ai/glm-5.3-flash")).toEqual({ provider: "openrouter", model: "z-ai/glm-5.3-flash" });
	});
});

describe("verbose toast", () => {
	const FULL = dec({
		slug: "ollama/gpt-oss:20b",
		servedSlug: "ollama/gpt-oss:20b",
		tier: "trivial",
		reportedUsd: 0.000308,
		reasons: [
			"policy: pinned to ollama/gpt-oss:20b",
			"completion budget raised 12 to 512: ollama/gpt-oss:20b reasons before it answers",
			"cheapest above the quality floor",
		],
		features: { promptTokens: 22899, toolCount: 11, isToolResultContinuation: true },
		attempt: 1,
		promptTokensSaved: 12800,
		ttftMs: 2100,
	});

	test("the headline keeps its shape and the body explains the choice", async () => {
		const lines = toToastText(FULL).split(String.fromCharCode(10));
		expect(lines[0]).toBe("ollama · gpt-oss:20b [trivial] · $0.00031");
		expect(lines[1]).toBe("why: policy: pinned to ollama/gpt-oss:20b");
		expect(lines[2]).toContain("completion budget raised");
		expect(lines[3]).toBe("22.9k prompt · 12.8k compacted · 11 tools · tool continuation · attempt 2 · 2.1s to first token");
	});

	test("compact is the old single line", async () => {
		expect(toToastText(FULL, false)).toBe("ollama · gpt-oss:20b [trivial] · $0.00031");
		expect(toToastText(FULL, false).includes(String.fromCharCode(10))).toBe(false);
	});

	test("a surprise outranks ordinary ranking, and ranking shows when nothing surprised", async () => {
		// "cheapest above the quality floor" is ordinary: a failover and a hold win.
		expect(whyReasons(["cheapest above the quality floor", "failover: x/y empty_completion; retrying a/b"])[0]).toContain("failover");
		expect(whyReasons(["cheapest above the quality floor", "held from the previous turn: switch margin not cleared"])[0]).toContain("held");
		// Nothing notable: the ranking rationale itself is the answer.
		expect(whyReasons(["cheapest above the quality floor"])).toEqual(["cheapest above the quality floor"]);
		expect(whyReasons([])).toEqual([]);
		expect(whyReasons(undefined)).toEqual([]);
		// At most two lines, however many reasons the router recorded.
		expect(whyReasons(["failover: a", "policy: b", "held: c", "cache warm"]).length).toBe(2);
		// The same fact recorded twice from different angles takes one line, not both.
		expect(whyReasons(["policy: pinned to ollama/gpt-oss:20b", "pinned to ollama/gpt-oss:20b by session override"])).toEqual(["policy: pinned to ollama/gpt-oss:20b"]);
	});

	test("an unreported cost falls back to the prediction, and thin decisions stay short", async () => {
		expect(toToastText(dec({ reportedUsd: null, predictedUsd: 0.00042, reasons: [], features: null }))).toBe("openrouter · meta/muse-glimmer-30b [trivial] · ~$0.00042");
		expect(toToastText(dec({ reportedUsd: null, features: null }))).toBe("openrouter · meta/muse-glimmer-30b [trivial]");
	});

	test("facts skip what a reader does not need", async () => {
		expect(factsOf(dec({ features: { promptTokens: 0, toolCount: 0 }, attempt: 0, task: "coding" }))).toEqual([]);
		expect(factsOf(dec({ features: { promptTokens: 900 }, task: "vision" }))).toEqual(["900 prompt", "vision"]);
	});

	test("selectToasts renders compact when asked", async () => {
		const entries = [dec({ id: "d2", slug: "x/b", reasons: ["failover: nope"] }), dec({ id: "d1" })];
		expect(selectToasts(entries, "d1", "", "", false)[0]?.text.includes(String.fromCharCode(10))).toBe(false);
		expect(selectToasts(entries, "d1")[0]?.text.includes(String.fromCharCode(10))).toBe(true);
	});
});
