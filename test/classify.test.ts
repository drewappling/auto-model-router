import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config/load.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { classify, pickQualityAxis, scoreHeuristic } from "../src/router/classify.ts";
import { extractFeatures } from "../src/router/features.ts";
import { TIER_ORDER, type Features, type Tier } from "../src/router/types.ts";
import type { Dispatch, DispatchOptions, UpstreamClient } from "../src/upstream/types.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";
import type { NormRequest } from "../src/wire/types.ts";

const BASE = loadConfig({});

function cfgWith(over: Partial<RouterConfig>): RouterConfig {
	return { ...BASE, ...over };
}

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

function req(messages: unknown[], tools: unknown[] | undefined = TOOLS): NormRequest {
	const body: Record<string, unknown> = { model: "auto", messages };
	if (tools !== undefined) body.tools = tools;
	return parseChatRequest(body, new Headers());
}

function featuresFor(messages: unknown[], tools?: unknown[] | undefined): Features {
	const r = req(messages, tools === undefined ? TOOLS : tools);
	return extractFeatures(r, 5000);
}

const SYSTEM = { role: "system", content: "You are a coding agent." };

/** Upstream double that fails loudly if the adjudicator is consulted. */
function forbiddenUpstream(): UpstreamClient {
	return {
		dispatch(_opts: DispatchOptions): Promise<Dispatch> {
			throw new Error("dispatch must not be called during classification");
		},
		complete(): Promise<{ text: string; costUsd: number | null }> {
			throw new Error("adjudicator must not be called");
		},
		fetchModels(): Promise<unknown[]> {
			return Promise.resolve([]);
		},
		fetchModelsForUser(): Promise<unknown[]> {
			return Promise.resolve([]);
		},
	};
}

function scriptedUpstream(behaviour: () => Promise<{ text: string; costUsd: number | null }>): UpstreamClient {
	return {
		dispatch(_opts: DispatchOptions): Promise<Dispatch> {
			throw new Error("dispatch must not be called during classification");
		},
		complete: behaviour,
		fetchModels(): Promise<unknown[]> {
			return Promise.resolve([]);
		},
		fetchModelsForUser(): Promise<unknown[]> {
			return Promise.resolve([]);
		},
	};
}

const tierIdx = (t: Tier): number => TIER_ORDER.indexOf(t);
describe("scoreHeuristic", () => {
	test("a mechanical tool-result continuation scores cheaper than a fresh architecture question", () => {
		// The single most valuable signal in agent traffic: most turns are
		// post-tool-result continuations, and they do not need a frontier model.
		const continuation = scoreHeuristic(
			featuresFor([
				SYSTEM,
				{ role: "user", content: "check the version" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"p.json"}' } }],
				},
				{ role: "tool", tool_call_id: "c1", content: '{"version":"1.0.0"}' },
			]),
			BASE,
		);
		const architecture = scoreHeuristic(
			featuresFor([
				SYSTEM,
				{
					role: "user",
					content:
						"Find the root cause of this deadlock, explain the race between the queue drain and shutdown, and redesign the architecture to remove the invariant violation.",
				},
			]),
			BASE,
		);
		expect(continuation.score).toBeLessThan(architecture.score);
		expect(tierIdx(continuation.tier)).toBeLessThan(tierIdx(architecture.tier));
	});

	test("a failing tool result raises the tier above a clean one", () => {
		const clean = scoreHeuristic(
			featuresFor([
				SYSTEM,
				{ role: "user", content: "build" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "c1", content: "ok, build succeeded" },
			]),
			BASE,
		);
		const failed = scoreHeuristic(
			featuresFor([
				SYSTEM,
				{ role: "user", content: "build" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
				},
				{ role: "tool", tool_call_id: "c1", content: "make: *** [all] Error 2" },
			]),
			BASE,
		);
		expect(failed.score).toBeGreaterThan(clean.score);
	});

	test("a requested high reasoning effort raises the score", () => {
		const plain = scoreHeuristic(featuresFor([SYSTEM, { role: "user", content: "tidy this up" }]), BASE);
		const thinking = scoreHeuristic(
			extractFeatures(
				parseChatRequest(
					{ model: "auto", tools: TOOLS, reasoning_effort: "high", messages: [SYSTEM, { role: "user", content: "tidy this up" }] },
					new Headers(),
				),
				5000,
			),
			BASE,
		);
		expect(thinking.score).toBeGreaterThan(plain.score);
	});

	test("always produces a bounded score, a real tier, and its reasoning", () => {
		const c = scoreHeuristic(featuresFor([SYSTEM, { role: "user", content: "hello" }]), BASE);
		expect(c.score).toBeGreaterThanOrEqual(0);
		expect(c.score).toBeLessThanOrEqual(1);
		expect(TIER_ORDER).toContain(c.tier);
		expect(c.source).toBe("heuristic");
		expect(c.reasons.length).toBeGreaterThan(0);
		expect(c.confidence).toBeGreaterThanOrEqual(0);
		expect(c.confidence).toBeLessThanOrEqual(1);
	});
});

describe("pickQualityAxis", () => {
	test("tools imply the coding axis, plain chat the chat axis", () => {
		expect(pickQualityAxis(featuresFor([SYSTEM, { role: "user", content: "fix it" }]), BASE)).toBe(BASE.classifier.toolAxis);
		expect(pickQualityAxis(featuresFor([SYSTEM, { role: "user", content: "hello" }], []), BASE)).toBe(
			BASE.classifier.chatAxis,
		);
	});

	test("a deep tool loop switches to the agentic axis", () => {
		const deep = featuresFor([
			SYSTEM,
			{ role: "user", content: "go" },
			{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] },
			{ role: "tool", tool_call_id: "c1", content: "a" },
			{ role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "read", arguments: '{"path":"b"}' } }] },
			{ role: "tool", tool_call_id: "c2", content: "b" },
			{ role: "assistant", content: null, tool_calls: [{ id: "c3", type: "function", function: { name: "read", arguments: '{"path":"c"}' } }] },
			{ role: "tool", tool_call_id: "c3", content: "c" },
			{ role: "assistant", content: null, tool_calls: [{ id: "c4", type: "function", function: { name: "read", arguments: '{"path":"d"}' } }] },
			{ role: "tool", tool_call_id: "c4", content: "d" },
		]);
		expect(deep.toolLoopDepth).toBeGreaterThanOrEqual(BASE.classifier.agenticLoopDepth);
		expect(pickQualityAxis(deep, BASE)).toBe("agentic");
	});
});

describe("classify", () => {
	const messages = [SYSTEM, { role: "user", content: "tidy the retry helper a bit" }];

	test("never consults the adjudicator when the ambiguity threshold is zero", async () => {
		const cfg = cfgWith({ classifier: { ...BASE.classifier, ambiguityThreshold: 0 } });
		const r = req(messages);
		const result = await classify(r, extractFeatures(r, 5000), cfg, {
			upstream: forbiddenUpstream(),
			ledger: null,
			catalog: null,
		});
		expect(result.source).toBe("heuristic");
	});

	test("falls back to the heuristic when the adjudicator returns garbage", async () => {
		// Always-ambiguous, so the adjudicator is definitely consulted.
		const cfg = cfgWith({ classifier: { ...BASE.classifier, ambiguityThreshold: 1.1 } });
		const r = req(messages);
		const f = extractFeatures(r, 5000);
		const expected = scoreHeuristic(f, cfg);
		const result = await classify(r, f, cfg, {
			upstream: scriptedUpstream(() => Promise.resolve({ text: "definitely not a tier", costUsd: 0 })),
			ledger: null,
			catalog: null,
		});
		expect(result.tier).toBe(expected.tier);
	});

	test("falls back to the heuristic when the adjudicator throws", async () => {
		const cfg = cfgWith({ classifier: { ...BASE.classifier, ambiguityThreshold: 1.1 } });
		const r = req(messages);
		const f = extractFeatures(r, 5000);
		const expected = scoreHeuristic(f, cfg);
		const result = await classify(r, f, cfg, {
			upstream: scriptedUpstream(() => Promise.reject(new Error("upstream exploded"))),
			ledger: null,
			catalog: null,
		});
		expect(result.tier).toBe(expected.tier);
		expect(result.reasons.some((x) => x.toLowerCase().includes("adjudicat"))).toBe(true);
	});

	test("adopts a valid adjudicator verdict", async () => {
		const cfg = cfgWith({ classifier: { ...BASE.classifier, ambiguityThreshold: 1.1 } });
		const r = req(messages);
		const f = extractFeatures(r, 5000);
		const result = await classify(r, f, cfg, {
			upstream: scriptedUpstream(() => Promise.resolve({ text: "hard", costUsd: 0.00001 })),
			ledger: null,
			catalog: null,
		});
		expect(result.tier).toBe("hard");
		expect(result.source).toBe("llm");
	});
});
