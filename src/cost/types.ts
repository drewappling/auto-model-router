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
	/** Concrete slug we dispatched to. */
	slug: string;
	/** Slug that actually served it, per the response `model` field. */
	servedSlug: string | null;
	tier: string;
	classificationSource: string;
	/** Human-readable decision trail. */
	reasons: string[];
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
	/** Tokens billed but discarded because the attempt was aborted and retried. */
	wasted: boolean;
	upstreamGenerationId: string | null;
	error: string | null;
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
	/** Observed chars-per-token ratio for a tokenizer family; null until calibrated. */
	tokenRatio(tokenizer: string): number | null;
	recentEntries(limit: number): LedgerEntry[];
}
