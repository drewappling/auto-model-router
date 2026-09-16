import { describe, expect, test } from "bun:test";
import { createOpenRouterUsageSource, NO_OPENROUTER_USAGE, openRouterServing, type OpenRouterCredits } from "../src/upstream/openrouter-usage.ts";
import { createLogger } from "../src/util/log.ts";

const log = createLogger("error");

function credits(remaining: number | null): OpenRouterCredits | null {
	return remaining === null ? null : { remainingUsd: remaining, totalCreditsUsd: 100, totalUsageUsd: 100 - remaining, fetchedAtMs: 1 };
}

describe("openRouterServing", () => {
	test("serves above the floor and stops at/below it", () => {
		expect(openRouterServing(credits(5.01), 5)).toBe(true);
		expect(openRouterServing(credits(5), 5)).toBe(false);
		expect(openRouterServing(credits(0), 5)).toBe(false);
	});

	test("fails open on unknown balance and when the gate is off", () => {
		expect(openRouterServing(null, 5)).toBe(true);
		expect(openRouterServing(credits(0), 0)).toBe(true);
	});
});

describe("createOpenRouterUsageSource", () => {
	test("returns null without a key and parses the credits payload", async () => {
		const unkeyed = createOpenRouterUsageSource({ apiKey: () => "", pollMs: 1000, timeoutMs: 100, log, root: "https://x/v1" });
		expect(await unkeyed.get()).toBe(null);
		expect(NO_OPENROUTER_USAGE.peek()).toBe(null);

		let calls = 0;
		const src = createOpenRouterUsageSource({
			apiKey: () => "k",
			pollMs: 1000,
			timeoutMs: 100,
			log,
			root: "https://x/v1",
			fetchImpl: async () => {
				calls++;
				return new Response(JSON.stringify({ data: { total_credits: 20, total_usage: 13.5 } }), { status: 200 });
			},
		});
		const v = await src.get();
		expect(calls).toBe(1);
		expect(v?.remainingUsd).toBe(6.5);
		expect(src.peek()?.totalUsageUsd).toBe(13.5);

		// A failed poll keeps the last good reading instead of hiding the provider.
		const failing = createOpenRouterUsageSource({
			apiKey: () => "k",
			pollMs: 0,
			timeoutMs: 100,
			log,
			root: "https://x/v1",
			fetchImpl: async () => new Response("nope", { status: 500 }),
		});
		await failing.get();
		expect(failing.peek()).toBe(null); // never had a reading; gate stays open on unknown
	});
});