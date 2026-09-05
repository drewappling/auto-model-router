/**
 * Cost prediction, reconciliation, and the spend ledger.
 *
 * Two numbers exist for every request and they are never conflated:
 *  - **predicted**: our arithmetic over the catalog, computed *before* dispatch.
 *    Drives routing and budget enforcement.
 *  - **reported**: `usage.cost` returned by OpenRouter, authoritative after the
 *    fact. Drives the ledger, `stats`, and prediction-error calibration.
 */

/** Token counts for one upstream generation. */
export interface UsageCounts {
	/** Total prompt tokens, *including* `cachedTokens` (OpenAI/OpenRouter convention). */
	promptTokens: number;
	/** Prompt tokens served from cache (`prompt_tokens_details.cached_tokens`). */
	cachedTokens: number;
	/** Prompt tokens written to cache (`prompt_tokens_details.cache_write_tokens`). */
	cacheWriteTokens: number;
	completionTokens: number;
	/** `completion_tokens_details.reasoning_tokens`. Subset of completion tokens. */
	reasoningTokens: number;
	/** Images in the prompt, for per-image surcharges. */
	images: number;
}

export const EMPTY_USAGE: UsageCounts = {
	promptTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
	completionTokens: 0,
	reasoningTokens: 0,
	images: 0,
};

/** Per-component cost decomposition, USD. Components sum to `total`. */
export interface CostBreakdown {
	freshPrompt: number;
	cacheRead: number;
	cacheWrite: number;
	completion: number;
	reasoning: number;
	images: number;
	request: number;
	total: number;
	/** Which price tier was applied (`minPromptTokens` of the winning tier, 0 = base). */
	tierAtPromptTokens: number;
}

/** What a candidate model is expected to cost for a pending request. */
export interface CostForecast {
	slug: string;
	/** Expected total, USD. */
	expectedUsd: number;
	/** Forecast assuming zero cache hits — the worst case a budget guard must survive. */
	coldUsd: number;
	breakdown: CostBreakdown;
	/** Prompt tokens the forecast assumed. */
	assumedPromptTokens: number;
	/** Completion tokens the forecast assumed. */
	assumedCompletionTokens: number;
	/** Fraction of prompt tokens assumed to hit cache, 0-1. */
	assumedCacheHitRate: number;
}

/** One dispatched upstream generation, successful or not. */
export interface LedgerEntry {
	id: string;
	createdAtMs: number;
	conversationKey: string;
	sessionId: string;
	/** Turn index within the conversation, 1-based. */
	turn: number;
	/** Virtual model omp asked for, e.g. `auto`. */
	requestedModel: string;
	/** Harness id from the request header; empty for the default harness. */
	harnessId: string;
	/**
	 * omp UI session id from the `X-Omp-Session` request header; empty when the
	 * client sends no header. Scopes toasts to a single interactive session so
	 * concurrent sessions sharing one ledger don't surface each other's choices.
	 */
	ompSessionId: string;
	/** Concrete slug we dispatched to. */
	slug: string;
	/** Slug that actually served it, per the response `model` field. */
	servedSlug: string | null;
	tier: string;
	classificationSource: string;
	/** Human-readable decision trail. */
	reasons: string[];
	/**
	 * Classifier inputs, persisted verbatim as JSON so any score is
	 * recomputable offline. Opaque here on purpose: the ledger sits below the
	 * router in the layering and must not import its types. NULL before v6.
	 */
	features: object | null;
	/** Raw heuristic score, 0-1, before tier bucketing. NULL before v6. */
	score: number | null;
	/** Classifier confidence, 0-1. Drives adjudication. NULL before v6. */
	confidence: number | null;
	/** Task kind (coding, vision, ...), orthogonal to tier. NULL before v6. */
	task: string | null;
	/** Per-feature score breakdown, which the decision trail drops. NULL before v6. */
	classifierReasons: string[] | null;
	/**
	 * Tier the classifier chose on a turn that exploration deliberately routed
	 * one step cheaper. NULL when the turn was routed normally.
	 */
	exploredFrom: string | null;
	/**
	 * Hold-length arm this conversation was assigned by hold exploration,
	 * or NULL when it was not part of that experiment.
	 */
	holdArm: number | null;
	predictedUsd: number;
	reportedUsd: number | null;
	usage: UsageCounts;
	/** Attempt index within this turn; >0 means this was an escalation retry. */
	attempt: number;
	/** Why this attempt was superseded, if it was. */
	escalationSignal: string | null;
	/** Wall-clock ms from dispatch to final chunk. */
	latencyMs: number;
	/** Time to first content token, ms. */
	ttftMs: number | null;
	finishReason: string | null;
	/**
	 * Attempt superseded by a retry or escalation. NOT a cost figure: by design
	 * these rows never carry reported_usd, so "wasted spend" sums to $0.00.
	 * The meaningful waste measure is retry spend — rows with attempt > 0 that
	 * DID bill. Kept for compatibility; do not read it as money.
	 */
	wasted: boolean;
	upstreamGenerationId: string | null;
	error: string | null;
	/** Prompt tokens removed by compaction before dispatch. 0 when none. NULL before v12. */
	promptTokensSaved: number;
}

/** Rolling blended rate used to keep omp's cost display honest. */
export interface BlendedRate {
	/** USD per million prompt tokens, spend-weighted over the window. */
	inputPerMtok: number;
	/** USD per million completion tokens, spend-weighted over the window. */
	outputPerMtok: number;
	/** USD per million cached prompt tokens. */
	cacheReadPerMtok: number;
	/** USD per million cache-write tokens. */
	cacheWritePerMtok: number;
	/** Requests the blend is based on. Low counts ⇒ fall back to a config default. */
	sampleCount: number;
	windowDays: number;
}

/** Per-model reliability learned from our own traffic. Feeds candidate scoring. */
export interface ModelTrust {
	slug: string;
	attempts: number;
	/** Attempts superseded by an escalation. */
	escalations: number;
	/** Attempts that ended in an upstream error. */
	errors: number;
	/** Laplace-smoothed success rate, 0-1. */
	successRate: number;
	/** Mean absolute relative prediction error, for forecast calibration. */
	meanCostError: number;
}

/** Per-model responsiveness learned from our own traffic. Feeds candidate scoring. */
export interface ModelLatency {
	slug: string;
	samples: number;
	/** Mean time-to-first-token, ms, over streamed non-errored turns. */
	ttftMs: number;
	/**
	 * Completion throughput, tokens/second, over streamed non-errored turns that
	 * emitted tokens (aggregate: total completion tokens / total post-TTFT time).
	 * 0 when no such row exists. Complements ttftMs: TTFT is how long the answer
	 * takes to START, throughput is how long it takes to FINISH — a model can be
	 * quick to first token yet stream the body slowly (e.g. deepseek-v4-flash:
	 * ~2s TTFT but ~20 tok/s and ~38s total).
	 */
	tokensPerSec: number;
}

export interface LedgerSignals {
	trust: ModelTrust | null;
	latency: ModelLatency | null;
}

/** Measured price of a probe escalation: what the retry billed per prompt token of the failed turn. */
export interface EscalationCost {
	usdPerPromptToken: number;
	samples: number;
	windowDays: number;
}

export interface Ledger {
	record(entry: LedgerEntry): void;
	/** Total reported (or predicted, when reported is null) spend for a conversation. */
	conversationSpend(conversationKey: string): number;
	/**
	 * Total spend since a wall-clock instant. When `harnessId` is non-empty,
	 * scoped to that harness only; empty ⇒ all harnesses (global).
	 */
	spendSince(sinceMs: number, harnessId?: string): number;
	blendedRate(windowDays: number): BlendedRate | null;
	/** Per-model reliability over the ledger, optionally scoped to a harness. */
	trust(slug: string, harnessId?: string): ModelTrust | null;
	allTrust(): ModelTrust[];
	/**
	 * Per-model responsiveness (mean TTFT + completion throughput), optionally
	 * scoped to a harness. Null until `filters.latencyMinSamples` streamed samples
	 * exist. TTFT isolates start latency from answer length; throughput captures
	 * how fast the body streams once it starts.
	 */
	latency(slug: string, harnessId?: string): ModelLatency | null;
	/** Batch trust and latency for one candidate set; one query per signal kind. Optional — callers can fall back to per-slug calls. */
	signals?(slugs: readonly string[], harnessId?: string): Map<string, LedgerSignals>;
	/**
	 * What an escalated retry actually bills per prompt token, measured over
	 * the last `windowDays` of attempt > 0 rows. Null until enough escalated
	 * attempts exist to measure. Optional so fakes need not implement it; the
	 * escalation-cost term in candidate scoring is inert without it.
	 */
	escalationCost?(windowDays: number): EscalationCost | null;
	/** Observed chars-per-token ratio for a tokenizer family; null until calibrated. */
	tokenRatio(tokenizer: string): number | null;
	recentEntries(limit: number): LedgerEntry[];
}
