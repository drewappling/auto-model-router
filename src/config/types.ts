/**
 * Router configuration.
 *
 * Layered: built-in defaults <- `$AUTO_MODEL_ROUTER_HOME/config.yml` <- environment
 * <- CLI flags. Every field is optional on disk; `RouterConfig` is the fully
 * resolved shape the rest of the code consumes.
 */

import type { TaskType, Tier } from "../router/types.ts";

export type QualityAxis = "coding" | "agentic" | "intelligence";

/**
 * Per-task routing envelope. Task type selects the quality axis, capability
 * filters, and quality floor; the complexity tier's price ceiling and the
 * budget guard still cap cost (task selects, tier budgets).
 */
export interface TaskConfig {
	/** Quality axis to score candidates against for this task. */
	axis: QualityAxis;
	/** Minimum quality on that axis, 0-100. Overrides the tier floor when higher. */
	minQuality?: number;
	/** Require image input support. Hard filter for vision tasks. */
	requireImage?: boolean;
	/** Slugs always eligible for this task regardless of quality floor. */
	prefer?: string[];
}

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
	 * Scope model trust to the requesting harness instead of the whole ledger.
	 * Off by default: shared trust converges on more samples and keeps the
	 * demotion guard effective with a small catalog. Enable only when harnesses
	 * route over meaningfully different model sets and each has enough traffic
	 * to learn its own reliability.
	 */
	trustScopedByHarness: boolean;
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
	/**
	 * Escalate when a `length` finish truncated TOOL-CALL ARGUMENTS, leaving
	 * structurally unusable output. A length finish on prose never escalates:
	 * that is the caller's own `max_tokens`, and a retry truncates identically.
	 */
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

/**
 * Epsilon-greedy exploration: deliberately route a small fraction of turns
 * one tier BELOW the classified tier, to learn whether the cheaper model
 * would have sufficed.
 *
 * Without it the ledger only ever witnesses UNDER-routing: a tier that was
 * too low escalates and is recorded, while over-routing stays invisible
 * because the cheaper model was never run. Weights fit on that one-sided
 * evidence can only ever ratchet toward more expensive routing.
 */
export interface ExplorationConfig {
	/** Off by default: this deliberately degrades a slice of real turns. */
	enabled: boolean;
	/**
	 * Per-tier sampling rate, 0-1. A tier that is absent, or set to 0, is
	 * never explored. `trivial` is the floor and cannot drop, so a rate for
	 * it has no effect.
	 *
	 * Rates are per-tier because the tiers are wildly unequal as evidence.
	 * In one observed window 635 explorable turns were `simple` and 1 was
	 * `hard`, while `hard` carried ~30% of all spend. A single uniform rate
	 * therefore spends nearly the whole exploration budget on the cheapest
	 * question in the system.
	 */
	rates: Partial<Record<Tier, number>>;
	/**
	 * Which hysteresis-held turns exploration may touch.
	 *
	 * `never`      the held population is untouchable.
	 * `cold-cache` explore a hold only after its prompt cache has expired.
	 * `always`     explore holds regardless, forfeiting a live cache read.
	 *
	 * This matters more than it sounds. ~95% of hard-tier spend arrives by
	 * hold rather than by classification, so `never` confines exploration to
	 * the cheapest boundary in the system. But held turns are consecutive
	 * turns of an active loop and are therefore warm BY CONSTRUCTION, so
	 * `cold-cache` barely reaches them either: on one real window it moved
	 * explorable hard turns from 1 to 11. Reaching that population in any
	 * useful volume means `always`, and paying the forfeited cache read --
	 * a real cost, but a bounded and directly measurable one.
	 */
	stickyPolicy: "never" | "cold-cache" | "always";
	/**
	 * Randomise the POST-ESCALATION hold length per conversation, to learn
	 * what it should be.
	 *
	 * `holdTurnsAfterEscalation` is a hand-picked constant that nothing has
	 * ever validated, and it governs most expensive spend: a turn escalates
	 * once, then the hold bills the next several turns at the escalated
	 * tier. Assignment is per conversation, so each conversation is one
	 * clean randomised arm rather than a confounded mixture.
	 */
	holdTurns: {
		enabled: boolean;
		/** Candidate hold lengths. One is drawn per conversation. */
		values: number[];
	};
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
	/** SQLite path. Defaults to `$AUTO_MODEL_ROUTER_HOME/router.db`. */
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
	tasks: Record<TaskType, TaskConfig>;
	filters: FilterConfig;
	classifier: ClassifierConfig;
	escalation: EscalationConfig;
	hysteresis: HysteresisConfig;
	exploration: ExplorationConfig;
	cache: CacheConfig;
	budget: BudgetConfig;
	profiles: ProfileConfig[];
	ledger: LedgerConfig;
	/**
	 * Derive each tier's quality floor from the models actually available at
	 * every catalog refresh, relaxing (never tightening) the configured floors.
	 * Without this, a narrow OpenRouter guardrail leaves every tier above
	 * `trivial` permanently empty and the router is stuck on the cheapest model.
	 */
	adaptiveTierFloors: boolean;
	logLevel: "silent" | "error" | "warn" | "info" | "debug";
}
