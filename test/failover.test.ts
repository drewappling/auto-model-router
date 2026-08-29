import { describe, expect, test } from "bun:test";
import { createDisabledBridge } from "../src/context/bridge.ts";
import type { CatalogSource } from "../src/catalog/types.ts";
import type { EscalationConfig, RouterConfig } from "../src/config/types.ts";
import { EMPTY_USAGE, type Ledger, type LedgerEntry, type UsageCounts } from "../src/cost/types.ts";
import type {
	ConversationState,
	ConversationStore,
	Decision,
	Features,
	ProbePlan,
	Router,
	Tier,
} from "../src/router/types.ts";
import { runTurn } from "../src/server/turn.ts";
import { UpstreamError, type DispatchOptions, type UpstreamClient } from "../src/upstream/types.ts";
import type {
	FinishReason,
	NormRequest,
	ResponseSink,
	StreamEvent,
	TurnSummary,
	UpstreamChunk,
	WireError,
} from "../src/wire/types.ts";

// ---------- fakes (mirrors turn.test.ts; the router also records excludeSlugs) ----------

function mkConfig(escalation: Partial<EscalationConfig> = {}): RouterConfig {
	return {
		server: { host: "127.0.0.1", port: 8787 },
		openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "", title: "test", timeoutMs: 30_000, catalogTtlMs: 3_600_000, catalogRefreshMs: 0 },
		benchmarks: { enabled: false, artificialAnalysisApiKey: "", benchlm: true, refreshMs: 86_400_000, timeoutMs: 30_000, useLocalScores: false },
		tiers: {
			trivial: { minQuality: 0, maxInputPerMtok: 0.3, qualityExponent: 0, pin: [] },
			simple: { minQuality: 40, maxInputPerMtok: 1.5, qualityExponent: 0, pin: [] },
			moderate: { minQuality: 60, maxInputPerMtok: 4, qualityExponent: 1, pin: [] },
			hard: { minQuality: 72, qualityExponent: 3, pin: [] },
		},
		tasks: {
			coding: { axis: "coding", minQuality: 40 },
			vision: { axis: "intelligence", requireImage: true },
			documentation: { axis: "intelligence", minQuality: 0 },
			data: { axis: "intelligence", minQuality: 0 },
			chat: { axis: "intelligence", minQuality: 0 },
		},
		filters: { allow: [], deny: [], includeFree: false, requireToolSupport: true, minTrust: 0.6, minTrustSamples: 5, trustScopedByHarness: false, contextHeadroom: 1.2, latencyWeight: 0, latencyReferenceMs: 5000, latencyReferenceTokensPerSec: 30, latencyMinSamples: 20 },
		classifier: {
			ambiguityThreshold: 0,
			model: "test/adjudicator",
			maxCostFraction: 0.1,
			maxCostUsd: 0.01,
			timeoutMs: 5000,
			cacheSize: 128,
			toolAxis: "coding",
			chatAxis: "intelligence",
			agenticLoopDepth: 3,
		},
		escalation: {
			enabled: true,
			probeTokens: 24,
			maxHoldMs: 5000,
			maxAttempts: 3,
			probeTiers: ["trivial", "simple", "moderate"],
			triggers: ["malformed_tool_args", "refusal", "empty_completion", "repeat_tool_call", "missing_expected_tool_call"],
			escalateOnLengthStop: false,
			...escalation,
		},
		hysteresis: { holdTurns: 2, holdTurnsAfterEscalation: 4, switchMargin: 1.5, cacheWarmTtlMs: 600_000, maxDowngradePerTurn: 1 },
		exploration: { enabled: false, rates: {}, stickyPolicy: "never", holdTurns: { enabled: false, values: [2, 3, 4] } },
		cache: { injectBreakpoints: true, maxBreakpoints: 4, minPromptTokens: 1024, milestoneTokens: 20_000 },
		context: { enabled: false, baseUrl: "", token: "", defaultScope: "", timeoutMs: 3_000, maxStalenessMs: 900_000, maxBlockChars: 24_000, memoryLimit: 8, sessionLimit: 6, recordTurns: false, maxQueue: 64 },
		compaction: { enabled: false, budgetTokens: 40_000, fitToWindow: true, protectRecentTurns: 4, maxToolResultBytes: 4_096, keepHeadBytes: 512, keepTailBytes: 512, elideSupersededReads: true, collapseDuplicateResults: true },
		budget: { onExceeded: "downgrade" },
		profiles: [],
		ledger: { path: ":memory:", blendWindowDays: 7, blendMinSamples: 20, fallbackBlend: { inputPerMtok: 1, outputPerMtok: 4 }, conversationTtlMs: 86_400_000 },
		adaptiveTierFloors: true,
		adaptivePriceCeilings: false,
		logLevel: "silent",
	};
}

function mkReq(): NormRequest {
	return {
		protocol: "openai-chat",
		conversationKey: "conv-test",
		harnessId: "",
		ompSessionId: "",
		agentdoxScope: "",
		requestedModel: "auto",
		messages: [{ role: "user", text: "hi", images: 0, textBytes: 2, toolCalls: [] }],
		tools: [],
		forcedToolChoice: false,
		stream: true,
		hasImages: false,
		promptBytes: 2,
		renderUpstreamBody: (m) => ({ model: m.slug, session_id: m.sessionId }),
	};
}

// Neutral feature vector for fake decisions; runTurn never reads it, but the
// amended contract requires it on every Decision.
const FEATURES: Features = {
	promptTokens: 0,
	newContentTokens: 0,
	turnDepth: 0,
	toolCount: 0,
	toolSchemaBytes: 0,
	isToolResultContinuation: false,
	toolLoopDepth: 0,
	distinctToolsUsed: 0,
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
};

function mkDecision(tier: Tier, slug: string, probe: Partial<ProbePlan> = {}): Decision {
	return {
		slug,
		fallbacks: [],
		tier,
		features: FEATURES,
		classification: { tier, task: "chat", confidence: 0.9, source: "heuristic", reasons: ["test"], score: 0.5 },
		forecast: {
			slug,
			expectedUsd: 0.001,
			coldUsd: 0.002,
			breakdown: { freshPrompt: 0.001, cacheRead: 0, cacheWrite: 0, completion: 0.001, reasoning: 0, images: 0, request: 0, total: 0.002, tierAtPromptTokens: 0 },
			assumedPromptTokens: 100,
			assumedCompletionTokens: 50,
			assumedCacheHitRate: 0,
		},
		sessionId: "omp-conv-test",
		sticky: false,
		cacheBreakpointMessageIndices: [],
		compactionPlan: [],
		promptTokensSaved: 0,
		reasoning: undefined,
		maxTokens: undefined,
		stripAssistantReasoning: false,
		probe: { enabled: true, maxTokens: 24, maxHoldMs: 5000, escalateTo: null, ...probe },
		considered: [],
		rejected: [],
		reasons: ["test decision"],
		explored: null,
		budgetDowngraded: false,
	};
}

function chunk(events: StreamEvent[]): UpstreamChunk {
	return { raw: {}, events };
}

function startChunk(slug: string): UpstreamChunk {
	return chunk([{ type: "start", servedSlug: slug, generationId: "gen-1" }]);
}

function textChunk(delta: string): UpstreamChunk {
	return chunk([{ type: "text", delta }]);
}

function finishChunk(reason: FinishReason): UpstreamChunk {
	return chunk([{ type: "finish", reason }]);
}

function usageChunk(usage: Partial<UsageCounts>, cost: number | null): UpstreamChunk {
	return chunk([{ type: "usage", usage: { ...EMPTY_USAGE, ...usage }, reportedCostUsd: cost }]);
}

type FakePlan =
	| { kind: "chunks"; chunks: UpstreamChunk[] }
	| { kind: "fail"; error: UpstreamError }
	| { kind: "die"; chunks: UpstreamChunk[]; error: UpstreamError };

function mkUpstream(plans: FakePlan[]): { upstream: UpstreamClient; calls: DispatchOptions[] } {
	const calls: DispatchOptions[] = [];
	let i = 0;
	const upstream: UpstreamClient = {
		dispatch: (opts) => {
			calls.push(opts);
			const plan = plans[Math.min(i, plans.length - 1)]!;
			i++;
			if (plan.kind === "fail") return Promise.reject(plan.error);
			const error = plan.kind === "die" ? plan.error : null;
			return Promise.resolve({
				generationId: () => Promise.resolve<string | null>("gen-fake"),
				chunks: (async function* (): AsyncGenerator<UpstreamChunk> {
					for (const c of plan.chunks) yield c;
					if (error) throw error;
				})(),
			});
		},
		complete: () => Promise.reject(new Error("not used by runTurn")),
		fetchModels: () => Promise.resolve([]),
		fetchModelsForUser: () => Promise.resolve([]),
	};
	return { upstream, calls };
}

type RouteCall = { attempt: number; escalateFrom?: Tier; excludeSlugs?: readonly string[] };

function mkRouter(decisions: Decision[]): { router: Router; calls: RouteCall[] } {
	const calls: RouteCall[] = [];
	let i = 0;
	const router: Router = {
		route: (_req, opts) => {
			const call: RouteCall = { attempt: opts.attempt };
			if (opts.escalateFrom !== undefined) call.escalateFrom = opts.escalateFrom;
			// Copy: runTurn passes its live failedSlugs array, which keeps growing.
			if (opts.excludeSlugs !== undefined) call.excludeSlugs = [...opts.excludeSlugs];
			calls.push(call);
			const d = decisions[Math.min(i, decisions.length - 1)];
			i++;
			if (!d) return Promise.reject(new Error("no decision queued"));
			return Promise.resolve(d);
		},
	};
	return { router, calls };
}

function mkLedger(): { ledger: Ledger; entries: LedgerEntry[] } {
	const entries: LedgerEntry[] = [];
	const ledger: Ledger = {
		record: (e) => {
			entries.push(e);
		},
		conversationSpend: () => 0,
		spendSince: () => 0,
		blendedRate: () => null,
		latency: () => null,
		trust: () => null,
		allTrust: () => [],
		tokenRatio: () => null,
		recentEntries: () => [],
	};
	return { ledger, entries };
}

function mkConversations(): { store: ConversationStore; map: Map<string, ConversationState> } {
	const map = new Map<string, ConversationState>();
	const store: ConversationStore = {
		get: (k) => map.get(k) ?? null,
		load: (k) => {
			const existing = map.get(k);
			if (existing) return existing;
			const fresh: ConversationState = {
				key: k,
				sessionId: `omp-${k}`,
				turn: 0,
				currentSlug: null,
				currentTier: null,
				stickyUntilTurn: 0,
				escalations: 0,
				spentUsd: 0,
				lastPromptTokens: 0,
				cacheWarmSlug: null,
				cacheWarmAtMs: 0,
				contextVersion: null,
				contextFetchedAtMs: 0,
				updatedAtMs: 0,
			};
			map.set(k, fresh);
			return fresh;
		},
		save: (s) => {
			map.set(s.key, s);
		},
		accrue: () => {},
		prune: () => 0,
	};
	return { store, map };
}

function mkSink(): { sink: ResponseSink; chunks: UpstreamChunk[]; errors: WireError[]; finishes: TurnSummary[] } {
	const chunks: UpstreamChunk[] = [];
	const errors: WireError[] = [];
	const finishes: TurnSummary[] = [];
	const sink: ResponseSink = {
		chunk: (c) => {
			chunks.push(c);
		},
		error: (e) => {
			errors.push(e);
		},
		finish: (s) => {
			finishes.push(s);
		},
	};
	return { sink, chunks, errors, finishes };
}

const catalog: CatalogSource = {
	get: () => Promise.resolve({ models: [], fetchedAtMs: 0 }),
	refresh: () => Promise.resolve({ models: [], fetchedAtMs: 0 }),
	peek: () => null,
	find: () => undefined,
};

function textOut(chunks: UpstreamChunk[]): string {
	return chunks
		.flatMap((c) => c.events)
		.filter((e): e is Extract<StreamEvent, { type: "text" }> => e.type === "text")
		.map((e) => e.delta)
		.join("");
}

function okChunks(slug: string): UpstreamChunk[] {
	return [startChunk(slug), textChunk("done"), finishChunk("stop"), usageChunk({ promptTokens: 100, completionTokens: 5 }, 0.001)];
}

// ---------- tests ----------

describe("same-tier failover", () => {
	test("a retryable 404 on model A dispatches a DIFFERENT model B at the same tier", async () => {
		const { router, calls } = mkRouter([mkDecision("moderate", "a/model"), mkDecision("moderate", "b/model")]);
		const { upstream, calls: dispatches } = mkUpstream([
			{ kind: "fail", error: new UpstreamError("model_unavailable", 404, "no endpoints found", true) },
			{ kind: "chunks", chunks: okChunks("b/model") },
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(finishes).toHaveLength(1);

		// The retry re-routed with the failed slug excluded and dispatched B at
		// the SAME tier — not A again, not a higher tier.
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({ attempt: 0 });
		expect(calls[1]).toEqual({ attempt: 1, excludeSlugs: ["a/model"] });
		expect(dispatches.map((d) => d.body.model)).toEqual(["a/model", "b/model"]);

		expect(entries).toHaveLength(2);
		expect(entries[0]!.slug).toBe("a/model");
		expect(entries[0]!.wasted).toBe(true);
		expect(entries[0]!.escalationSignal).toBeNull(); // failover, not escalation
		expect(entries[0]!.error).toContain("model_unavailable");
		expect(entries[1]!.slug).toBe("b/model");
		expect(entries[1]!.tier).toBe("moderate");
		expect(entries[1]!.wasted).toBe(false);

		// The failover is visible on the surviving decision's reasons.
		expect(entries[1]!.reasons).toContain("failover: a/model returned model_unavailable; retrying b/model in moderate");

		expect(finishes[0]!.servedSlug).toBe("b/model");
		expect(finishes[0]!.tier).toBe("moderate");
		expect(finishes[0]!.escalated).toBe(false);
		expect(finishes[0]!.attempts).toBe(2);
	});

	test("a 403 moderation block fails over to a different model in the same tier", async () => {
		const { router, calls } = mkRouter([mkDecision("trivial", "a/model"), mkDecision("trivial", "b/model")]);
		const { upstream, calls: dispatches } = mkUpstream([
			{ kind: "fail", error: new UpstreamError("moderation", 403, "Request blocked: prompt injection", true) },
			{ kind: "chunks", chunks: okChunks("b/model") },
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(finishes).toHaveLength(1);

		// A per-model policy block indicts the slug, not the tier: the retry
		// re-routes with the blocked slug excluded and serves a sibling.
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({ attempt: 1, excludeSlugs: ["a/model"] });
		expect(dispatches.map((d) => d.body.model)).toEqual(["a/model", "b/model"]);

		expect(entries).toHaveLength(2);
		expect(entries[0]!.slug).toBe("a/model");
		expect(entries[0]!.wasted).toBe(true);
		expect(entries[0]!.escalationSignal).toBeNull(); // failover, not escalation
		expect(entries[0]!.error).toContain("moderation");
		expect(entries[1]!.slug).toBe("b/model");
		expect(entries[1]!.tier).toBe("trivial");
		expect(entries[1]!.wasted).toBe(false);
		expect(entries[1]!.reasons).toContain("failover: a/model returned moderation; retrying b/model in trivial");

		expect(finishes[0]!.servedSlug).toBe("b/model");
		expect(finishes[0]!.escalated).toBe(false);
	});

	test("a tier with no other eligible model falls back to tier escalation", async () => {
		// The router widens to "simple" when "trivial" excludes a/model: the
		// failover probe's decision is discarded and the normal escalation path
		// (escalateFrom + upstream_error signal) runs instead.
		const { router, calls } = mkRouter([
			mkDecision("trivial", "a/model"),
			mkDecision("simple", "b/model"),
			mkDecision("simple", "b/model"),
		]);
		const { upstream, calls: dispatches } = mkUpstream([
			{ kind: "fail", error: new UpstreamError("model_unavailable", 404, "no endpoints found", true) },
			{ kind: "chunks", chunks: okChunks("b/model") },
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(finishes).toHaveLength(1);

		expect(calls).toHaveLength(3);
		expect(calls[0]).toEqual({ attempt: 0 });
		expect(calls[1]).toEqual({ attempt: 1, excludeSlugs: ["a/model"] }); // failover probe, rejected (wrong tier)
		expect(calls[2]).toEqual({ attempt: 1, escalateFrom: "trivial", excludeSlugs: ["a/model"] }); // real escalation

		// a/model is never re-dispatched; the turn escalated to simple.
		expect(dispatches.map((d) => d.body.model)).toEqual(["a/model", "b/model"]);

		expect(entries).toHaveLength(2);
		expect(entries[0]!.wasted).toBe(true);
		expect(entries[0]!.escalationSignal).toBe("upstream_error");
		expect(entries[1]!.slug).toBe("b/model");
		expect(entries[1]!.tier).toBe("simple");
		expect(entries[1]!.wasted).toBe(false);
		expect(entries[1]!.reasons.some((r) => r.startsWith("failover:"))).toBe(false);

		expect(finishes[0]!.escalated).toBe(true);
		expect(finishes[0]!.servedSlug).toBe("b/model");
	});

	test("a non-retryable error fails fast with no failover and no re-route", async () => {
		const { router, calls } = mkRouter([mkDecision("trivial", "a/model")]);
		const { upstream, calls: dispatches } = mkUpstream([
			{ kind: "fail", error: new UpstreamError("auth", 401, "invalid key", false) },
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toEqual({ attempt: 0 }); // never re-routed, never given excludeSlugs
		expect(dispatches).toHaveLength(1);
		expect(finishes).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toEqual({ status: 401, code: "auth", message: "invalid key" });
		expect(entries).toHaveLength(1);
		expect(entries[0]!.wasted).toBe(false);
		expect(entries[0]!.error).toContain("auth");
	});

	test("same-tier failover is bounded; the next retryable failure escalates", async () => {
		const { router, calls } = mkRouter([
			mkDecision("trivial", "a/model"),
			mkDecision("trivial", "b/model"),
			mkDecision("trivial", "c/model"),
			mkDecision("simple", "d/model"),
		]);
		const { upstream, calls: dispatches } = mkUpstream([
			{ kind: "fail", error: new UpstreamError("rate_limit", 429, "slow down", true) },
			{ kind: "fail", error: new UpstreamError("rate_limit", 429, "slow down", true) },
			{ kind: "fail", error: new UpstreamError("rate_limit", 429, "slow down", true) },
			{ kind: "chunks", chunks: okChunks("d/model") },
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors, finishes } = mkSink();

		await runTurn(
			mkReq(),
			sink,
			{ config: mkConfig({ maxAttempts: 5 }), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() },
			new AbortController().signal,
		);

		expect(errors).toHaveLength(0);
		expect(finishes).toHaveLength(1);

		// Two same-tier failovers (A→B, B→C), then the bound bites and the
		// third failure escalates to simple instead of spinning further.
		expect(calls).toHaveLength(4);
		expect(calls[0]).toEqual({ attempt: 0 });
		expect(calls[1]).toEqual({ attempt: 1, excludeSlugs: ["a/model"] });
		expect(calls[2]).toEqual({ attempt: 2, excludeSlugs: ["a/model", "b/model"] });
		expect(calls[3]).toEqual({ attempt: 3, escalateFrom: "trivial", excludeSlugs: ["a/model", "b/model", "c/model"] });

		expect(dispatches.map((d) => d.body.model)).toEqual(["a/model", "b/model", "c/model", "d/model"]);

		expect(entries).toHaveLength(4);
		expect(entries[0]!.escalationSignal).toBeNull();
		expect(entries[1]!.escalationSignal).toBeNull();
		expect(entries[1]!.reasons).toContain("failover: a/model returned rate_limit; retrying b/model in trivial");
		expect(entries[2]!.escalationSignal).toBe("upstream_error"); // bound hit: escalate
		expect(entries[2]!.reasons).toContain("failover: b/model returned rate_limit; retrying c/model in trivial");
		expect(entries[3]!.slug).toBe("d/model");
		expect(entries[3]!.tier).toBe("simple");
		expect(entries[3]!.wasted).toBe(false);

		expect(finishes[0]!.escalated).toBe(true);
		expect(finishes[0]!.attempts).toBe(4);
		expect(finishes[0]!.servedSlug).toBe("d/model");
	});

	test("a mid-stream retryable error before commit fails over the same way", async () => {
		const { router, calls } = mkRouter([mkDecision("simple", "a/model"), mkDecision("simple", "b/model")]);
		const { upstream, calls: dispatches } = mkUpstream([
			{
				kind: "die",
				chunks: [startChunk("a/model")],
				error: new UpstreamError("upstream_error", 500, "provider crashed", true),
			},
			{ kind: "chunks", chunks: okChunks("b/model") },
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, chunks, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(calls).toHaveLength(2);
		expect(calls[1]).toEqual({ attempt: 1, excludeSlugs: ["a/model"] });
		expect(dispatches.map((d) => d.body.model)).toEqual(["a/model", "b/model"]);

		expect(entries).toHaveLength(2);
		expect(entries[0]!.wasted).toBe(true);
		expect(entries[0]!.escalationSignal).toBeNull();
		expect(entries[0]!.error).toContain("upstream_error");

		// Nothing from the failed generation reached the client.
		expect(textOut(chunks)).toBe("done");
		expect(finishes).toHaveLength(1);
		expect(finishes[0]!.servedSlug).toBe("b/model");
	});
});
