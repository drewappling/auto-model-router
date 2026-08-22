/**
 * Router configuration.
 *
 * Layered: built-in defaults <- `$OMP_ROUTER_HOME/config.yml` <- environment
 * <- CLI flags. Every field is optional on disk; `RouterConfig` is the fully
 * resolved shape the rest of the code consumes.
 */

import type { Tier } from "../router/types.ts";

export type QualityAxis = "coding" | "agentic" | "intelligence";

export interface ServerConfig {
	host: string;
	port: number;
	/** Optional bearer required from clients. Unset ⇒ loopback-only, no auth. */
	apiKey?: string;
	/**
	 * Harness identity emitted as the `X-Omp-Harness` header in the generated
	 * `models.yml` provider block. Lets multiple coding harnesses share one
	 * router while keeping per-harness daily budgets and toast scoping. Empty
	 * ⇒ no header (single-harness default).
	 */
	harnessId?: string;
}

export interface OpenRouterConfig {
	baseUrl: string;
	/** Resolved from config, then `OPENROUTER_API_KEY`. */
	apiKey: string;
	/** Sent as `HTTP-Referer`, for OpenRouter attribution. */
	referer?: string;
	/** Sent as `X-Title`. */
	title: string;
	/** Per-request timeout, ms. */
	timeoutMs: number;
	/** Catalog freshness threshold, ms: refetch on traffic when older than this. */
	catalogTtlMs: number;
	/** Background catalog refresh cadence, ms. 0 disables the periodic refresh. */
	catalogRefreshMs: number;
}

/** Quality/price envelope for one complexity tier. */
export interface TierConfig {
	/**
	 * Minimum quality on the request's chosen axis, 0-100 (Artificial Analysis
	 * index as published by OpenRouter). The tier's capability guarantee.
	 */
	minQuality: number;
	/** Hard ceiling on input price, USD per million tokens. Unset ⇒ unbounded. */
	maxInputPerMtok?: number;
	/** Hard ceiling on output price, USD per million tokens. Unset ⇒ unbounded. */
	maxOutputPerMtok?: number;
	/**
	 * Exponent on quality in the ranking score. 0 ⇒ pick the cheapest model
	 * above the floor (Pareto-style). Higher ⇒ pay for headroom above it.
	 */
	qualityExponent: number;
	/** Slugs always allowed in this tier regardless of the quality floor. */
	pin: string[];
}

export interface FilterConfig {
	/** Glob patterns; a model must match one. Empty ⇒ allow all. */
	allow: string[];
	/** Glob patterns; matching models are dropped. Applied after `allow`. */
	deny: string[];
	/** Consider zero-price models. Off by default: rate limits make them expensive in retries. */
	includeFree: boolean;
	/** Require `supported_parameters` to include `tools` whenever the request offers tools. */
	requireToolSupport: boolean;
	/** Drop models whose ledger success rate is below this, once `minTrustSamples` is met. */
	minTrust: number;
	/** Attempts required before `minTrust` is enforced against a model. */
	minTrustSamples: number;
	/**
	 * Headroom multiplier applied to estimated prompt tokens when checking a
	 * model's context window, absorbing token-estimate error and the response.
	 */
	contextHeadroom: number;
}

export interface ClassifierConfig {
	/**
	 * Heuristic confidence below which the LLM adjudicator is consulted.
	 * 0 disables the adjudicator entirely.
	 */
	ambiguityThreshold: number;
	/** Slug used for adjudication. Must be cheap and fast. */
	model: string;
	/** Skip adjudication when it would exceed this fraction of the forecast turn cost. */
	maxCostFraction: number;
	/** Absolute per-call ceiling, USD. */
	maxCostUsd: number;
	timeoutMs: number;
	/** Adjudication verdicts cached per turn fingerprint. */
	cacheSize: number;
	/** Which quality axis to score against when the request offers tools. */
	toolAxis: QualityAxis;
	/** Axis for plain chat requests. */
	chatAxis: QualityAxis;
	/** Tool-loop depth above which the agentic axis takes over. */
	agenticLoopDepth: number;
}

export interface EscalationConfig {
	enabled: boolean;
	/** Hold this many text tokens before committing the stream to the client. */
	probeTokens: number;
	/** Hard ceiling on hold time, ms. Elapsing commits the attempt. */
	maxHoldMs: number;
	/** Max escalation retries per turn. */
	maxAttempts: number;
	/** Tiers eligible for probing. Frontier tiers are usually excluded. */
	probeTiers: Tier[];
	/** Signals that trigger escalation. Narrowing this makes the guard more permissive. */
	triggers: string[];
	/** Treat a `length` finish on an empty tool call as a failure. */
	escalateOnLengthStop: boolean;
}

export interface HysteresisConfig {
	/** Turns to hold a tier after committing to it. */
	holdTurns: number;
	/** Turns to hold after an escalation, so a hard sub-task stays on the strong model. */
	holdTurnsAfterEscalation: number;
	/**
	 * Switch models only when the expected saving exceeds the forfeited cache
	 * discount by this multiple. 1.0 ⇒ break even; higher ⇒ stickier.
	 */
	switchMargin: number;
	/** Assume a warm cache expires after this long. OpenRouter sticky sessions: 5-10 min. */
	cacheWarmTtlMs: number;
	/** Downgrade at most this many tiers per turn, so quality never falls off a cliff. */
	maxDowngradePerTurn: number;
}

export interface CacheConfig {
	/**
	 * Inject Anthropic-style `cache_control` breakpoints. OpenRouter translates
	 * them to OpenAI/Google cache primitives, so one mechanism covers every target.
	 */
	injectBreakpoints: boolean;
	/** Max breakpoints per request. Anthropic allows 4. */
	maxBreakpoints: number;
	/** Skip injection below this prompt-token estimate; small prompts cannot cache. */
	minPromptTokens: number;
}

export interface BudgetConfig {
	/** Reject or downgrade when a turn's cold forecast exceeds this, USD. */
	perTurnUsd?: number;
	/** Force the cheapest viable tier once a conversation exceeds this, USD. */
	perConversationUsd?: number;
	/** Rolling 24h ceiling, USD. */
	perDayUsd?: number;
	/** At the ceiling: drop to the cheapest viable model, or fail the request outright. */
	onExceeded: "downgrade" | "reject";
}

/**
 * A virtual model exposed to clients. `auto` is the general profile; the
 * others bias the same machinery toward cost or quality.
 */
export interface ProfileConfig {
	/** Model id as clients see it, e.g. `auto`. */
	id: string;
	/** Display name in omp's model picker. */
	name: string;
	/** Clamp classification to at most this tier. */
	maxTier: Tier;
	/** Floor classification at this tier. */
	minTier: Tier;
	/** Context window advertised to omp; drives its compaction threshold. */
	contextWindow: number;
	/** Max output tokens advertised to omp. */
	maxTokens: number;
	/** Per-profile budget overrides. */
	budget?: Partial<BudgetConfig>;
}

export interface LedgerConfig {
	/** SQLite path. Defaults to `$OMP_ROUTER_HOME/router.db`. */
	path: string;
	/** Window for the blended rate published to omp, days. */
	blendWindowDays: number;
	/** Requests required before the measured blend replaces `fallbackBlend`. */
	blendMinSamples: number;
	/** Blend used before enough samples exist, USD per million tokens. */
	fallbackBlend: { inputPerMtok: number; outputPerMtok: number };
	/** Drop conversation state untouched for longer than this, ms. */
	conversationTtlMs: number;
}

export interface RouterConfig {
	server: ServerConfig;
	openrouter: OpenRouterConfig;
	tiers: Record<Tier, TierConfig>;
	filters: FilterConfig;
	classifier: ClassifierConfig;
	escalation: EscalationConfig;
	hysteresis: HysteresisConfig;
	cache: CacheConfig;
	budget: BudgetConfig;
	profiles: ProfileConfig[];
	ledger: LedgerConfig;
	logLevel: "silent" | "error" | "warn" | "info" | "debug";
}
