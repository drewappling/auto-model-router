import { describe, expect, test } from "bun:test";
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
		openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "", title: "test", timeoutMs: 30_000, catalogTtlMs: 3_600_000 },
		tiers: {
			trivial: { minQuality: 0, maxInputPerMtok: 0.3, qualityExponent: 0, pin: [] },
			simple: { minQuality: 40, maxInputPerMtok: 1.5, qualityExponent: 0, pin: [] },
			moderate: { minQuality: 60, maxInputPerMtok: 4, qualityExponent: 1, pin: [] },
			hard: { minQuality: 72, qualityExponent: 3, pin: [] },
		},
		filters: { allow: [], deny: [], includeFree: false, requireToolSupport: true, minTrust: 0.6, minTrustSamples: 5, contextHeadroom: 1.2 },
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
		cache: { injectBreakpoints: true, maxBreakpoints: 4, minPromptTokens: 1024 },
		budget: { onExceeded: "downgrade" },
		profiles: [],
		ledger: { path: ":memory:", blendWindowDays: 7, blendMinSamples: 20, fallbackBlend: { inputPerMtok: 1, outputPerMtok: 4 }, conversationTtlMs: 86_400_000 },
		logLevel: "silent",
	};
}

function mkReq(): NormRequest {
	return {
		protocol: "openai-chat",
		conversationKey: "conv-test",
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
	hasImages: false,
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
		classification: { tier, confidence: 0.9, source: "heuristic", reasons: ["test"], score: 0.5 },
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
		reasoning: undefined,
		maxTokens: undefined,
		stripAssistantReasoning: false,
		probe: { enabled: true, maxTokens: 24, maxHoldMs: 5000, escalateTo: null, ...probe },
		considered: [],
		rejected: [],
		reasons: ["test decision"],
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
				updatedAtMs: 0,
			};
			map.set(k, fresh);
			return fresh;
		},
		save: (s) => {
			map.set(s.key, s);
		},
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

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog }, new AbortController().signal);

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

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog }, new AbortController().signal);

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

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog }, new AbortController().signal);

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

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog }, new AbortController().signal);

		expect(calls).toHaveLength(1); // no retry, no escalation on auth
		expect(finishes).toHaveLength(0);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toEqual({ status: 401, code: "auth", message: "invalid key" });
		expect(entries).toHaveLength(1);
		expect(entries[0]!.wasted).toBe(false);
		expect(entries[0]!.error).toContain("auth");
	});

	test("a 429 before commit retries the same tier once before escalating", async () => {
		const { router, calls } = mkRouter([
			mkDecision("trivial", "cheap/model", { escalateTo: "simple" }),
			mkDecision("trivial", "cheap/model", { escalateTo: "simple" }),
			mkDecision("simple", "better/model", { escalateTo: "moderate" }),
		]);
		const { upstream } = mkUpstream([
			{ kind: "fail", error: new UpstreamError("rate_limit", 429, "slow down", true) },
			{ kind: "fail", error: new UpstreamError("rate_limit", 429, "slow down", true) },
			{ kind: "chunks", chunks: [startChunk("better/model"), textChunk("done"), finishChunk("stop"), usageChunk({}, 0.001)] },
		]);
		const { ledger, entries } = mkLedger();
		const { store } = mkConversations();
		const { sink, errors, finishes } = mkSink();

		await runTurn(mkReq(), sink, { config: mkConfig(), router, upstream, ledger, conversations: store, catalog }, new AbortController().signal);

		expect(errors).toHaveLength(0);
		expect(finishes).toHaveLength(1);
		expect(entries).toHaveLength(3);
		expect(entries[0]!.wasted).toBe(true);
		expect(entries[0]!.error).toContain("rate_limit");
		expect(entries[0]!.escalationSignal).toBeNull(); // same-tier retry, not an escalation
		expect(entries[1]!.wasted).toBe(true);
		expect(entries[1]!.escalationSignal).toBe("upstream_error");
		expect(entries[2]!.wasted).toBe(false);

		// Attempt 1 re-routes without escalateFrom (same tier); attempt 2 escalates.
		expect(calls).toHaveLength(3);
		expect(calls[0]).toEqual({ attempt: 0 });
		expect(calls[1]).toEqual({ attempt: 1 });
		expect(calls[2]).toEqual({ attempt: 2, escalateFrom: "trivial" });
	});
});
