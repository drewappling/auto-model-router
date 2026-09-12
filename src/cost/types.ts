/**
 * Cost prediction, reconciliation, and the spend ledger.
 *
 * Two numbers exist for every request and they are never conflated:
 *  - **predicted**: our arithmetic over the catalog, computed *before* dispatch.
 *    Drives routing and budget enforcement.
 *  - **reported**: `usage.cost` returned by OpenRouter, authoritative after the
 *    fact. Drives the ledger, `stats`, and prediction-error calibration. A
 *    provider that returns usage but no cost (Ollama) has its ACTUAL tokens
 *    priced at the catalog rate and recorded here — still after the fact, and
 *    still not the forecast.
 */

import type { CatalogModel } from "../catalog/types.ts";

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
	/**
	 * `cachedTokens` was estimated by the router (see `cache-estimate.ts`)
	 * because the upstream caches without reporting it (Ollama Cloud). Absent
	 * or false ⇒ the count came from the provider.
	 */
	cachedEstimated?: boolean;
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
	/**
	 * The agentdox context scope this turn carried — what the bridge resolved
	 * for it (the request's `X-Agentdox-Scope`, or `context.defaultScope`).
	 * Absent, or empty, when the turn carried none, and stored as NULL; a front
	 * door charges the row's spend back to that project with it. NULL before v18.
	 */
	scope?: string;
	/**
	 * How many strings redaction removed from this turn's outgoing request
	 * (`redaction` in the config). A COUNT and nothing else — the matched text
	 * is precisely what must not exist outside the client, so the evidence that
	 * the guard ran must not reintroduce it. Absent when redaction is off, and
	 * on every row written before v19; 0 means the rules ran and matched nothing.
	 */
	redactions?: number;
	/**
	 * The catalog model that served, for the cost split. The ledger can price
	 * OpenRouter slugs from its own cached catalog payload; a model from another
	 * provider (Ollama) exists only in memory, so the orchestrator hands it over.
	 */
	priceModel?: CatalogModel;
	/**
	 * The cost component split the router computed when it recorded this row,
	 * from its own catalog prices. Absent when the row predates pricing, or
	 * when the model could not be priced (NULL in the ledger) — a front door
	 * shows input/output/cache costs from this rather than re-deriving them.
	 */
	costBreakdown?: CostBreakdown;
}

/**
 * What one retention prune did. `oldestKeptMs` is the timestamp of the oldest
 * row still in the ledger afterwards (null when it is empty) — the honest
 * answer to "how far back does this ledger go now", which is what an operator
 * asked the question for, and what a front door shows instead of computing a
 * cutoff of its own.
 */
export interface PruneResult {
	deleted: number;
	oldestKeptMs: number | null;
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
	/** Laplace-smoothed success rate, 0-1; user verdicts weigh in at filters.feedbackWeight. */
	successRate: number;
	/** User verdicts in the window (/router good|bad). */
	feedbackGood?: number;
	feedbackBad?: number;
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

/**
 * How often a model's prompt cache actually hit when the router expected it
 * warm: the previous kept turn of the conversation was on the same model
 * within `hysteresis.cacheWarmTtlMs`. Provider-side misses (a model whose
 * cache is flaky, or absent) show up here as a low rate. Router-estimated
 * cache counts (Ollama) are excluded: they are constructed, not observed.
 */
export interface ModelCacheReliability {
	slug: string;
	samples: number;
	/** Mean cached / expected-cached over those samples, 0-1. */
	hitRate: number;
}

export interface LedgerSignals {
	trust: ModelTrust | null;
	latency: ModelLatency | null;
	cache?: ModelCacheReliability | null;
}

/** Measured price of a probe escalation: what the retry billed per prompt token of the failed turn. */
export interface EscalationCost {
	usdPerPromptToken: number;
	samples: number;
	windowDays: number;
}

/**
 * A model whose recent failure rate (probe rejections OpenRouter counts as
 * success, plus attributable transport errors) is well above its own
 * baseline. Visibility only: the ledger data showed soft failures do not
 * cluster tightly enough for a breaker to save money, so the router reports
 * spikes (/health, /router status, the daily summary) rather than acting.
 */
export interface SoftFailureSpike {
	slug: string;
	/** Dispatches and failures in the recent window. */
	recentDispatches: number;
	recentFailures: number;
	recentRate: number;
	/** The same, over the baseline window (recent window excluded). */
	baselineDispatches: number;
	baselineFailures: number;
	baselineRate: number;
}

/**
 * The turn's ledger reads, asynchronously. A local SQLite ledger satisfies this
 * trivially (its reads are already synchronous); a Postgres-backed one cannot
 * be read from inside `select`, so this is the seam the router prefetches
 * through. One implementation per storage engine, and the routing core never
 * learns which it is talking to.
 */
export interface LedgerReader {
	signals(slugs: readonly string[], harnessId?: string, task?: string): Promise<Map<string, LedgerSignals>>;
	/** Warm-cache hit rates for the slugs a turn may choose between. */
	cacheReliability(slugs: readonly string[]): Promise<Map<string, ModelCacheReliability>>;
	escalationCost(windowDays: number): Promise<EscalationCost | null>;
	spendSince(sinceMs: number, harnessId?: string): Promise<number>;
}


/**
 * The ledger. One interface, one implementation (`ledger-sql.ts`), either
 * engine underneath.
 *
 * Every method is a promise because the store may be a shared database rather
 * than a local file, and a Postgres read cannot be made synchronous. Nothing
 * is optional: a caller made to guess which half of an interface it holds is
 * how a signal silently goes missing, and test doubles get their omissions
 * filled by `test/fakes.ts` instead. `LedgerReader` stays the narrow seam the
 * turn path prefetches through; this is the full surface the server and the
 * reports use.
 */
export interface AsyncLedger extends LedgerReader {
	record(entry: LedgerEntry): Promise<void>;
	conversationSpend(conversationKey: string): Promise<number>;
	blendedRate(windowDays: number): Promise<BlendedRate | null>;
	trust(slug: string, harnessId?: string, task?: string): Promise<ModelTrust | null>;
	allTrust(): Promise<ModelTrust[]>;
	latency(slug: string, harnessId?: string): Promise<ModelLatency | null>;
	tokenRatio(tokenizer: string): Promise<number | null>;
	recentEntries(limit: number): Promise<LedgerEntry[]>;
	providerSpendSince(slugPrefix: string, sinceMs: number): Promise<number>;
	softFailureSpikes(nowMs?: number, recentMs?: number, baselineMs?: number): Promise<SoftFailureSpike[]>;
	latestForSession(ompSessionId: string): Promise<LedgerEntry | null>;
	entriesForSession(ompSessionId: string, limit: number): Promise<LedgerEntry[]>;
	prune(retentionDays: number | null, nowMs?: number): Promise<PruneResult>;
	markWasted(id: string): Promise<void>;
}
