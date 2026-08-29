import { describe, expect, test } from "bun:test";
import { createDisabledBridge } from "../src/context/bridge.ts";
import type { ContextBridge, TurnRecord } from "../src/context/types.ts";
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

// ---------- fakes ----------

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
		context: { enabled: false, baseUrl: "", token: "", defaultScope: "", timeoutMs: 3_000, maxStalenessMs: 900_000, maxBlockChars: 24_000, memoryLimit: 8, docsLimit: 2, sessionLimit: 6, recordTurns: false, maxQueue: 64 },
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

function mkRouter(decisions: Decision[]): { router: Router; calls: { attempt: number; escalateFrom?: Tier }[] } {
	const calls: { attempt: number; escalateFrom?: Tier }[] = [];
	let i = 0;
	const router: Router = {
		route: (_req, opts) => {
			calls.push(opts.escalateFrom !== undefined ? { attempt: opts.attempt, escalateFrom: opts.escalateFrom } : { attempt: opts.attempt });
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

function mkConversations(): {
	store: ConversationStore;
	map: Map<string, ConversationState>;
	accrued: Map<string, { spentUsd: number; escalations: number }>;
} {
	const map = new Map<string, ConversationState>();
	// Mirrors the real store: money accumulates here, NOT through `save`.
	const accrued = new Map<string, { spentUsd: number; escalations: number }>();
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
		accrue: (k, d) => {
			const cur = accrued.get(k) ?? { spentUsd: 0, escalations: 0 };
			cur.spentUsd += d.spentUsd ?? 0;
			cur.escalations += d.escalations ?? 0;
			accrued.set(k, cur);
		},
		prune: () => 0,
	};
	return { store, map, accrued };
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

// ---------- tests ----------

describe("runTurn", () => {
	test("a clean cheap-tier generation writes exactly one ledger entry, wasted: false", async () => {
		const { router } = mkRouter([mkDecision("trivial", "cheap/model", { escalateTo: "simple" })]);
		const { upstream } = mkUpstream([
			{
				kind: "chunks",
				chunks: [
					startChunk("cheap/model"),
					textChunk("hi"),
					finishChunk("stop"),
					usageChunk({ promptTokens: 120, cachedTokens: 100, completionTokens: 4 }, 0.0004),
				],
			},
		]);
		const { ledger, entries } = mkLedger();
		const { store, map } = mkConversations();
		const { sink, chunks, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(finishes).toHaveLength(1);
		expect(entries).toHaveLength(1);
		const entry = entries[0]!;
		expect(entry.wasted).toBe(false);
		expect(entry.escalationSignal).toBeNull();
		expect(entry.attempt).toBe(0);
		expect(entry.slug).toBe("cheap/model");
		expect(entry.servedSlug).toBe("cheap/model");
		expect(entry.reportedUsd).toBe(0.0004);
		expect(entry.usage.promptTokens).toBe(120);
		expect(entry.finishReason).toBe("stop");
		expect(entry.error).toBeNull();
		expect(chunks).toHaveLength(4);
		expect(finishes[0]!.escalated).toBe(false);
		expect(finishes[0]!.attempts).toBe(1);

		const state = map.get("conv-test")!;
		expect(state.turn).toBe(1);
		expect(state.currentSlug).toBe("cheap/model");
		expect(state.currentTier).toBe("trivial");
		expect(state.lastPromptTokens).toBe(120);
		expect(state.spentUsd).toBeCloseTo(0.0004);
		// cachedTokens > 0 is direct evidence of an upstream cache.
		expect(state.cacheWarmSlug).toBe("cheap/model");
		expect(state.cacheWarmAtMs).toBeGreaterThan(0);
	});

	test("an escalated turn writes two entries; the client sees only the second generation", async () => {
		const { router, calls } = mkRouter([
			mkDecision("trivial", "cheap/model", { escalateTo: "simple" }),
			mkDecision("simple", "better/model", { escalateTo: "moderate" }),
		]);
		const { upstream } = mkUpstream([
			{
				kind: "chunks",
				chunks: [startChunk("cheap/model"), textChunk("I'm sorry, but I can't help with that request."), finishChunk("stop")],
			},
			{
				kind: "chunks",
				chunks: [startChunk("better/model"), textChunk("Here is the answer."), finishChunk("stop"), usageChunk({ promptTokens: 130, completionTokens: 6 }, 0.0009)],
			},
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, chunks, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(entries).toHaveLength(2);
		expect(entries[0]!.wasted).toBe(true);
		expect(entries[0]!.escalationSignal).toBe("refusal");
		expect(entries[0]!.slug).toBe("cheap/model");
		expect(entries[0]!.attempt).toBe(0);
		expect(entries[1]!.wasted).toBe(false);
		expect(entries[1]!.attempt).toBe(1);
		expect(entries[1]!.slug).toBe("better/model");

		// The escalated attempt re-routed one tier up.
		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({ attempt: 0 });
		expect(calls[1]).toEqual({ attempt: 1, escalateFrom: "trivial" });

		// The held refusal text never reached the client.
		expect(textOut(chunks)).toBe("Here is the answer.");
		expect(finishes).toHaveLength(1);
		expect(finishes[0]!.escalated).toBe(true);
		expect(finishes[0]!.attempts).toBe(2);
		expect(finishes[0]!.servedSlug).toBe("better/model");
	});

	test("a committed stream is never retried, even when later chunks fail", async () => {
		const { router } = mkRouter([mkDecision("trivial", "cheap/model", { maxTokens: 1 })]);
		const { upstream, calls } = mkUpstream([
			{
				kind: "die",
				chunks: [startChunk("cheap/model"), textChunk("lots of text here, plenty to commit on")],
				error: new UpstreamError("rate_limit", 429, "slow down", true),
			},
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, chunks, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		// Bytes reached the client, so the 429 mid-stream is surfaced, not retried.
		expect(calls).toHaveLength(1);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.wasted).toBe(false);
		expect(entries[0]!.error).toContain("rate_limit");
		expect(textOut(chunks)).toBe("lots of text here, plenty to commit on");
		expect(errors).toHaveLength(1);
		expect(errors[0]!.code).toBe("rate_limit");
		expect(finishes).toHaveLength(0);
	});

	test("a non-retryable upstream error before commit reaches sink.error", async () => {
		const { router, calls } = mkRouter([mkDecision("trivial", "cheap/model", { escalateTo: "simple" })]);
		const { upstream } = mkUpstream([{ kind: "fail", error: new UpstreamError("auth", 401, "invalid key", false) }]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(calls).toHaveLength(1); // no retry, no escalation on auth
		expect(finishes).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toEqual({ status: 401, code: "auth", message: "invalid key" });
		expect(entries).toHaveLength(1);
		expect(entries[0]!.wasted).toBe(false);
		expect(entries[0]!.error).toContain("auth");
	});

	test("a 429 before commit fails over to a different model in the same tier", async () => {
		const { router, calls } = mkRouter([
			mkDecision("trivial", "cheap/model", { escalateTo: "simple" }),
			mkDecision("trivial", "spare/model", { escalateTo: "simple" }),
		]);
		const { upstream } = mkUpstream([
			{ kind: "fail", error: new UpstreamError("rate_limit", 429, "slow down", true) },
			{ kind: "chunks", chunks: [startChunk("spare/model"), textChunk("done"), finishChunk("stop"), usageChunk({}, 0.001)] },
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(finishes).toHaveLength(1);
		expect(entries).toHaveLength(2);
		expect(entries[0]!.wasted).toBe(true);
		expect(entries[0]!.error).toContain("rate_limit");
		expect(entries[0]!.escalationSignal).toBeNull(); // same-tier failover, not an escalation
		expect(entries[0]!.slug).toBe("cheap/model");
		expect(entries[1]!.wasted).toBe(false);
		expect(entries[1]!.slug).toBe("spare/model");
		expect(entries[1]!.tier).toBe("trivial");

		expect(calls).toHaveLength(2);
		expect(calls[0]).toEqual({ attempt: 0 });
		expect(calls[1]).toEqual({ attempt: 1 });
		expect(finishes[0]!.escalated).toBe(false);
		expect(finishes[0]!.attempts).toBe(2);
		expect(finishes[0]!.servedSlug).toBe("spare/model");
	});

	test("a stable tier does not re-arm the hysteresis window (no permanent hard lock)", async () => {
		// Regression: the sticky window was re-armed on EVERY committed turn, so
		// once a conversation reached `hard` it stayed there forever — the
		// classifier kept saying trivial but the window kept getting pushed out.
		// A stable tier must NOT extend the window; only a tier change or an
		// escalation re-arms it.
		const { router } = mkRouter([
			mkDecision("hard", "strong/model", { escalateTo: null }),
			mkDecision("hard", "strong/model", { escalateTo: null }),
		]);
		const { upstream } = mkUpstream([
			{ kind: "chunks", chunks: [startChunk("strong/model"), textChunk("a"), finishChunk("stop"), usageChunk({}, 0.001)] },
			{ kind: "chunks", chunks: [startChunk("strong/model"), textChunk("b"), finishChunk("stop"), usageChunk({}, 0.001)] },
		]);
		const { ledger } = mkLedger();
		const { store, map } = mkConversations();
		const { sink, errors } = mkSink();

		// Turn 1: first turn, no prior tier → re-arms (tierChanged true).
		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);
		const afterFirst = map.get("conv-test")!;
		expect(afterFirst.currentTier).toBe("hard");
		expect(afterFirst.stickyUntilTurn).toBe(1 + 2); // holdTurns=2

		// Turn 2: same tier served again → must NOT re-arm. The window should
		// stay at its previous expiry (turn 3), not extend to turn 4.
		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);
		const afterSecond = map.get("conv-test")!;
		expect(afterSecond.currentTier).toBe("hard");
		expect(afterSecond.stickyUntilTurn).toBe(3); // unchanged, not 4
		expect(errors).toHaveLength(0);
	});
});

describe("exploration reaches the ledger", () => {
	test("an explored turn records the tier it was dropped from", async () => {
		const explored = { ...mkDecision("simple", "cheap/model"), explored: { from: "moderate" as Tier, to: "simple" as Tier } };
		const { router } = mkRouter([explored]);
		const { upstream } = mkUpstream([
			{
				kind: "chunks",
				chunks: [startChunk("cheap/model"), textChunk("ok"), finishChunk("stop"), usageChunk({ promptTokens: 10, completionTokens: 2 }, 0.0001)],
			},
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(entries).toHaveLength(1);
		// The counterfactual pair: what the classifier wanted, and what actually ran.
		expect(entries[0]?.exploredFrom).toBe("moderate");
		expect(entries[0]?.tier).toBe("simple");
	});

	test("a normally routed turn leaves it null", async () => {
		const { router } = mkRouter([mkDecision("simple", "cheap/model")]);
		const { upstream } = mkUpstream([
			{
				kind: "chunks",
				chunks: [startChunk("cheap/model"), textChunk("ok"), finishChunk("stop"), usageChunk({ promptTokens: 10, completionTokens: 2 }, 0.0001)],
			},
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(entries).toHaveLength(1);
		expect(entries[0]?.exploredFrom).toBeNull();
	});
});

describe("agentdox write-back sees the shape of the turn", () => {
	/** An agent ships its tool schemas; a harness utility call does not. */
	const AGENT_TOOL = { name: "read", description: "read a file", schemaBytes: 128 };

	function mkRecordingBridge(): { bridge: ContextBridge; records: TurnRecord[] } {
		const records: TurnRecord[] = [];
		return {
			records,
			bridge: {
				enabled: true,
				resolve: () => Promise.resolve(null),
				recordTurn: (rec) => {
					records.push(rec);
				},
				flush: () => Promise.resolve(),
				close: () => {},
			},
		};
	}

	test("a tool_calls finish is a fragment; only a yielding finish ends the turn", async () => {
		// A user-visible turn is many dispatches. The orchestrator must tell the
		// bridge which one actually handed control back, or the transcript records
		// a near-empty answer per tool round-trip and re-appends the same user
		// text every time.
		const { router } = mkRouter([
			mkDecision("simple", "cheap/model", { escalateTo: null }),
			mkDecision("simple", "cheap/model", { escalateTo: null }),
		]);
		const { upstream } = mkUpstream([
			{ kind: "chunks", chunks: [startChunk("cheap/model"), textChunk("let me look"), finishChunk("tool_calls"), usageChunk({}, 0.0001)] },
			{ kind: "chunks", chunks: [startChunk("cheap/model"), textChunk("all done"), finishChunk("stop"), usageChunk({}, 0.0001)] },
		]);
		const { ledger } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors } = mkSink();
		const { bridge, records } = mkRecordingBridge();
		// doxActive needs a scope; the request header supplies it. The tool
		// schemas mark this as the agent's working conversation.
		const req: NormRequest = { ...mkReq(), agentdoxScope: "proj", tools: [AGENT_TOOL] };
		const deps = { config: mkConfig({ enabled: false }), router, upstream, ledger, conversations: store, catalog, context: bridge };

		await runTurn(req, sink, deps, new AbortController().signal);
		await runTurn(req, sink, deps, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(records).toHaveLength(2);
		expect(records[0]?.turnEnded).toBe(false);
		expect(records[0]?.assistantText).toBe("let me look");
		expect(records[1]?.turnEnded).toBe(true);
		expect(records[1]?.assistantText).toBe("all done");
	});

	test("a harness utility call is never transcribed", async () => {
		// omp drives title generation and complexity rating through this same
		// provider with `model: auto`. They answer ABOUT the conversation
		// ("high", "<title>…</title>") and carry NO tool schemas. Recording them
		// created junk agentdox sessions that then fed back into every later
		// context block.
		const { router } = mkRouter([mkDecision("trivial", "cheap/model", { escalateTo: null })]);
		const { upstream } = mkUpstream([
			{ kind: "chunks", chunks: [startChunk("cheap/model"), textChunk("high"), finishChunk("stop"), usageChunk({}, 0.0001)] },
		]);
		const { ledger } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors } = mkSink();
		const { bridge, records } = mkRecordingBridge();
		// Same scope, same provider — only the absent tool array differs.
		const req: NormRequest = { ...mkReq(), agentdoxScope: "proj", tools: [] };

		await runTurn(req, sink, { config: mkConfig({ enabled: false }), router, upstream, ledger, conversations: store, catalog, context: bridge }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(records).toHaveLength(0);
	});
});

describe("spend reaches the conversation total however the dispatch ends", () => {
	test("a dispatch that dies mid-stream still books what it was billed", async () => {
		// Live data: 152 aborted dispatches billed $0.9985 — 30% of all spend —
		// and none of it reached the conversation's running total, because an abort
		// returns before the commit path. The ledger row and the per-conversation
		// budget guard must never disagree about money. Probe maxTokens 1 commits
		// on the first token, so the retryable error below cannot re-enter the
		// attempt loop and confuse the accounting.
		const { router } = mkRouter([mkDecision("simple", "cheap/model", { maxTokens: 1, escalateTo: null })]);
		const { upstream } = mkUpstream([
			{
				kind: "die",
				chunks: [
					startChunk("cheap/model"),
					textChunk("plenty of text here, enough to commit on"),
					usageChunk({ promptTokens: 47_700, completionTokens: 154 }, 0.0071),
				],
				error: new UpstreamError("network", 0, "request aborted", true),
			},
		]);
		const { ledger, entries } = mkLedger();
		const { store, accrued } = mkConversations();
		const { sink } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		// The turn never committed: the ledger row carries the error.
		expect(entries).toHaveLength(1);
		expect(entries[0]?.error).not.toBeNull();
		// ...but the money was still booked.
		expect(accrued.get("conv-test")?.spentUsd).toBeCloseTo(0.0071, 10);
	});

	test("a committed turn books its cost exactly once", async () => {
		const { router } = mkRouter([mkDecision("simple", "cheap/model", { escalateTo: null })]);
		const { upstream } = mkUpstream([
			{ kind: "chunks", chunks: [startChunk("cheap/model"), textChunk("done"), finishChunk("stop"), usageChunk({}, 0.002)] },
		]);
		const { ledger, entries } = mkLedger();
		const { store, accrued } = mkConversations();
		const { sink, errors } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(entries).toHaveLength(1);
		// Booked in writeEntry only — the commit path must not add it again.
		expect(accrued.get("conv-test")?.spentUsd).toBeCloseTo(0.002, 10);
	});
});

describe("latency measurement covers the work the router actually does", () => {
	test("a tool-call-only dispatch still records TTFT", async () => {
		// 83% of dispatches in an agentic loop finish with `tool_calls`, and 64.5%
		// of those recorded ttft_ms NULL because only text/reasoning stamped it.
		// LATENCY_SELECT requires ttft_ms, so throughput scoring (weight 0.75) was
		// measuring the narrating minority and steering everything else with it.
		const { router } = mkRouter([mkDecision("simple", "cheap/model", { maxTokens: 1, escalateTo: null })]);
		const { upstream } = mkUpstream([
			{
				kind: "chunks",
				chunks: [
					startChunk("cheap/model"),
					chunk([{ type: "tool_call", index: 0, id: "c1", name: "read", argsDelta: '{"path":"a.ts"}' }]),
					finishChunk("tool_calls"),
					usageChunk({ promptTokens: 50_000, completionTokens: 160 }, 0.004),
				],
			},
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog, context: createDisabledBridge() }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.finishReason).toBe("tool_calls");
		// The qualifying condition for latency stats: a real, positive TTFT.
		expect(entries[0]?.ttftMs).not.toBeNull();
		expect(entries[0]?.ttftMs ?? -1).toBeGreaterThanOrEqual(0);
	});
});
