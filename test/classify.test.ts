import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config/load.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { classify, classifyTask, pickQualityAxis, scoreHeuristic } from "../src/router/classify.ts";
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

/** A tool-result continuation at a given autonomous-loop depth, no other signals. */
function contFeatures(toolLoopDepth: number, over: Partial<Features> = {}): Features {
	return {
		promptTokens: 30000,
		newContentTokens: 200,
		turnDepth: toolLoopDepth,
		toolCount: 12,
		toolSchemaBytes: 9783,
		isToolResultContinuation: true,
		toolLoopDepth,
		distinctToolsUsed: 3,
		lastToolFailed: false,
		repeatedToolCall: false,
		circularToolCall: false,
		hasImages: false,
		hasNewImage: false,
		codeBlocks: 0,
		codeBytes: 0,
		looksLikeDiff: false,
		complexityKeywords: [],
		trivialityKeywords: [],
		requestedReasoning: undefined,
		questionCount: 0,
		isTerseInstruction: false,
		...over,
	};
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

	test("a shallow tool-result continuation stays trivial", () => {
		const shallow = scoreHeuristic(contFeatures(2), BASE);
		expect(shallow.tier).toBe("trivial");
	});

	test("a sustained autonomous loop climbs out of trivial", () => {
		// The failure mode this fixes: a long coding loop pinned to the cheapest
		// tier for dozens of turns because agentic complexity never accumulated.
		const shallow = scoreHeuristic(contFeatures(2), BASE);
		const deep = scoreHeuristic(contFeatures(20), BASE);
		expect(tierIdx(deep.tier)).toBeGreaterThan(tierIdx(shallow.tier));
		expect(deep.tier).not.toBe("trivial");
	});

	test("score increases monotonically with loop depth past the agentic threshold", () => {
		const depths = [4, 6, 8, 10, 15, 20, 30];
		let prev = -1;
		for (const d of depths) {
			const s = scoreHeuristic(contFeatures(d), BASE).score;
			expect(s).toBeGreaterThanOrEqual(prev);
			prev = s;
		}
	});

	test("pure loop depth never reaches hard on its own, however runaway", () => {
		// A sustained-but-not-runaway loop tops out in moderate: the calibrated
		// ramp ceiling for ordinary deep work.
		const midRange = scoreHeuristic(contFeatures(30), BASE);
		expect(midRange.tier).toBe("moderate");
		// And so does a runaway one. This reverses an earlier cap of 0.70 that let
		// raw depth buy `hard`: on live data 152 of 155 hard dispatches were
		// depth-driven and carried 63.5% of ALL spend, while those same rows also
		// scored the mechanical tool-result-continuation penalty. `hard` has no
		// price ceiling, so depth alone was buying a ~8x model for work the
		// classifier already knew was mechanical. Depth is a weak signal of
		// DIFFICULTY; hard must be bought by a corroborating stuck signal (see the
		// circular-tool-call test below), which is the case that actually needs a
		// stronger model.
		const runaway = scoreHeuristic(contFeatures(90), BASE);
		expect(runaway.tier).toBe("moderate");
		// The ceiling must still be a real ceiling, not an accident of the ramp.
		expect(scoreHeuristic(contFeatures(400), BASE).tier).toBe("moderate");
	});

	test("a circular tool call on a deep loop escalates to hard", () => {
		// The stuck signal raw depth misses: a prior call re-issued verbatim.
		const deepCircular = scoreHeuristic(contFeatures(90, { circularToolCall: true }), BASE);
		expect(deepCircular.tier).toBe("hard");
	});

	test("a failing tool result on a deep loop is at least moderate", () => {
		const deepAndFailing = scoreHeuristic(contFeatures(20, { lastToolFailed: true }), BASE);
		expect(tierIdx(deepAndFailing.tier)).toBeGreaterThanOrEqual(tierIdx("moderate"));
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

describe("classifyTask", () => {
	test("image input is a vision task", () => {
		const f = featuresFor([SYSTEM, { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,xxx" } }] }], []);
		expect(classifyTask(f)).toBe("vision");
	});

	test("a stale image on a tool continuation is coding, not vision", () => {
		const f = featuresFor(
			[
				SYSTEM,
				{
					role: "user",
					content: [
						{ type: "text", text: "build this UI" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,xxx" } },
					],
				},
				{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
				{ role: "tool", tool_call_id: "c1", name: "read", content: "ok" },
			],
			TOOLS,
		);
		expect(f.hasImages).toBe(true);
		expect(f.hasNewImage).toBe(false);
		expect(classifyTask(f)).toBe("coding");
	});

	test("a freshly supplied image mid-loop is vision", () => {
		const f = featuresFor(
			[
				SYSTEM,
				{ role: "user", content: "start" },
				{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
				{ role: "tool", tool_call_id: "c1", name: "read", content: "ok" },
				{
					role: "user",
					content: [
						{ type: "text", text: "here is the error" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,xxx" } },
					],
				},
			],
			TOOLS,
		);
		expect(f.hasNewImage).toBe(true);
		expect(classifyTask(f)).toBe("vision");
	});

	test("code blocks and diffs are coding tasks", () => {
		expect(classifyTask(featuresFor([SYSTEM, { role: "user", content: "```ts\nconst x = 1;\n```" }], []))).toBe("coding");
		expect(classifyTask(featuresFor([SYSTEM, { role: "user", content: "diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new" }], []))).toBe("coding");
	});

	test("tools offered is a coding task", () => {
		expect(classifyTask(featuresFor([SYSTEM, { role: "user", content: "read the file" }], TOOLS))).toBe("coding");
	});

	test("bare chat with no tools or code is a chat task", () => {
		expect(classifyTask(featuresFor([SYSTEM, { role: "user", content: "hello, how are you?" }], []))).toBe("chat");
	});

	test("design/architecture prose is a documentation task", () => {
		expect(classifyTask(featuresFor([SYSTEM, { role: "user", content: "explain the architecture of the system" }], []))).toBe("documentation");
	});
});
