/**
 * Routing brain contracts: features -> complexity tier -> concrete model.
 *
 * Every stage is a pure function of explicit inputs so decisions are
 * reproducible and `auto-model-router explain` can replay them offline.
 */

import type { CatalogModel } from "../catalog/types.ts";
import type { CostForecast } from "../cost/types.ts";
import type { CompactionEdit, NormRequest, ReasoningLevel } from "../wire/types.ts";

export type Tier = "trivial" | "simple" | "moderate" | "hard";

export const TIER_ORDER: readonly Tier[] = ["trivial", "simple", "moderate", "hard"] as const;

/**
 * Task type: the KIND of work, orthogonal to complexity tier. A vision task
 * routes to the best vision-capable model even if the tier would otherwise
 * pick a cheaper one; a documentation task stays cheap. Classified from
 * Features with no tokenizer or model call.
 */
export type TaskType = "coding" | "vision" | "documentation" | "data" | "chat";

export const TASK_ORDER: readonly TaskType[] = ["coding", "vision", "documentation", "data", "chat"] as const;

/**
 * Signals extracted from a request. Deliberately cheap: no tokenizer, no
 * network, no model call. Field names are stable because they are logged
 * verbatim into the ledger for later calibration.
 */
export interface Features {
	/** Estimated prompt tokens (see `tokens/estimate.ts`). */
	promptTokens: number;
	/** Estimated tokens in the newest user-authored content only. */
	newContentTokens: number;
	/** Assistant + user turns in history (excludes system). */
	turnDepth: number;
	/** Tools offered. omp exposes ~15-25; a bare chat request offers none. */
	toolCount: number;
	/** Total bytes of tool JSON schemas — usually the largest prompt component. */
	toolSchemaBytes: number;
	/**
	 * The last message is a tool result, i.e. this is a mechanical continuation
	 * of an agent loop rather than fresh human intent. The single strongest
	 * cheap-routing signal in agent traffic.
	 */
	isToolResultContinuation: boolean;
	/** Consecutive tool-result messages at the tail — loop depth. */
	toolLoopDepth: number;
	/** Distinct tool names used across the conversation. */
	distinctToolsUsed: number;
	/** A tool result at the tail reports an error or non-zero exit. */
	lastToolFailed: boolean;
	/** The same tool was called with identical arguments twice in a row. */
	repeatedToolCall: boolean;
	/**
	 * A byte-identical tool call (same name AND args) was re-issued within the
	 * last few assistant calls, adjacent or not — the agent is going in circles.
	 * Generalizes `repeatedToolCall`; the classifier scores THIS, so a stuck
	 * loop escalates even when the repeat is not back-to-back.
	 */
	circularToolCall: boolean;
	/**
	 * An image appears ANYWHERE in the conversation. Drives the model-capability
	 * filter: the payload still carries that image every turn, so a served model
	 * must accept image input even long after the image was introduced.
	 */
	hasImages: boolean;
	/**
	 * An image appears in the VOLATILE TAIL — the newest user-authored run. This
	 * is what makes a turn genuinely visual WORK, as opposed to a mechanical
	 * tool-loop continuation that merely carries a stale screenshot in context.
	 * Task classification keys on this so an agentic coding loop is scored on the
	 * coding axis, not pinned to the vision (intelligence) axis by an old image.
	 */
	hasNewImage: boolean;
	/** Fenced code blocks in the newest user content. */
	codeBlocks: number;
	/** Bytes inside fenced code blocks in the newest user content. */
	codeBytes: number;
	/** Diff/patch markers in the newest user content. */
	looksLikeDiff: boolean;
	/** Matched complexity keywords (architecture, debug, why, race, optimize, ...). */
	complexityKeywords: string[];
	/** Matched triviality keywords (rename, format, typo, bump, ...). */
	trivialityKeywords: string[];
	/** Client asked for reasoning, a direct statement of expected difficulty. */
	requestedReasoning: ReasoningLevel | undefined;
	/** Question marks in the newest user content. */
	questionCount: number;
	/** Newest user content is a single short imperative sentence. */
	isTerseInstruction: boolean;
}

export type ClassificationSource = "heuristic" | "llm" | "sticky" | "forced" | "escalation";

export interface Classification {
	tier: Tier;
	/** Task type: the kind of work, orthogonal to complexity. */
	task: TaskType;
	/** 0-1. Below the config's ambiguity band, the LLM adjudicator is consulted. */
	confidence: number;
	source: ClassificationSource;
	/** Ordered, human-readable justification. Logged and surfaced by `explain`. */
	reasons: string[];
	/** Raw heuristic score before tier bucketing, 0-1. */
	score: number;
}

/** A model that survived capability filtering, with its economics attached. */
export interface Candidate {
	model: CatalogModel;
	forecast: CostForecast;
	/** Quality on the axis chosen for this request (coding/agentic/intelligence), 0-100. */
	qualityScore: number;
	/** Laplace-smoothed success rate from our ledger, 0-1. Defaults to a neutral prior. */
	trustScore: number;
	/** Final ranking score. Higher wins. */
	score: number;
	/** Why this candidate ranked where it did. */
	reasons: string[];
}

export type RejectionReason =
	| "no_tool_support"
	| "context_too_small"
	| "no_image_support"
	| "below_quality_floor"
	| "over_price_ceiling"
	| "over_latency_ceiling"
	| "over_budget"
	| "denylisted"
	| "not_allowlisted"
	| "free_tier_excluded"
	| "reasoning_mandatory"
	| "untrusted"
	/** Already failed on this turn; excluded so failover picks a different model. */
	| "failed_this_turn";

export interface Rejection {
	slug: string;
	reason: RejectionReason;
	detail?: string;
}

/** Per-conversation routing memory. Persisted so restarts do not reset hysteresis. */
export interface ConversationState {
	key: string;
	/** Forwarded to OpenRouter as `session_id`. */
	sessionId: string;
	turn: number;
	/** Slug that served the previous committed turn. */
	currentSlug: string | null;
	currentTier: Tier | null;
	/**
	 * Hold the current tier until this turn index, to stop per-turn flapping
	 * that would repeatedly cold-start prompt caches.
	 */
	stickyUntilTurn: number;
	escalations: number;
	spentUsd: number;
	/** Prompt tokens on the previous turn, for cache-warmth arithmetic. */
	lastPromptTokens: number;
	/** Model whose prompt cache we believe is still warm. */
	cacheWarmSlug: string | null;
	/** When that cache was last touched; OpenRouter sticky sessions expire in 5-10 min. */
	cacheWarmAtMs: number;
	/**
	 * agentdox context block pinned to this conversation. Held stable across
	 * turns so the injected system prefix stays byte-identical and the prompt
	 * cache survives; refreshed only when the cache is already cold.
	 */
	contextVersion: string | null;
	/**
	 * The compaction plan applied on the previous dispatch. Re-applied verbatim
	 * each turn (after byte-length validation) so already-shrunk tool results
	 * stay shrunk: dropping them re-inflates mid-prefix bytes, which both breaks
	 * the prompt cache and un-saves the tokens. Fresh planning only extends it.
	 */
	compactionPlan: CompactionEdit[] | null;
	/** When that block was fetched, for the staleness TTL. */
	contextFetchedAtMs: number;
	updatedAtMs: number;
}

export interface ConversationStore {
	get(key: string): ConversationState | null;
	/** Loads existing state or creates a fresh record. */
	load(key: string): ConversationState;
	/**
	 * Persists the latest-wins fields. Deliberately does NOT write `spentUsd` or
	 * `escalations` — those accumulate via `accrue`, and writing back a snapshot
	 * here would clobber what a concurrent or already-billed dispatch added.
	 */
	save(state: ConversationState): void;
	/**
	 * Adds to the persisted counters, atomically in SQL.
	 *
	 * Separate from `save` because a dispatch that never reaches the commit path
	 * — a client abort, an upstream error — was still BILLED, and its cost must
	 * reach the per-conversation budget guard anyway. Requires `load` to have
	 * created the row.
	 */
	accrue(key: string, delta: { spentUsd?: number; escalations?: number }): void;
	/** Drops records untouched for longer than `maxAgeMs`. */
	prune(maxAgeMs: number): number;
}

/** Guarded-probe configuration for one dispatch. */
export interface ProbePlan {
	enabled: boolean;
	/** Hold output until this many text tokens have arrived. */
	maxTokens: number;
	/** Hard ceiling on hold time so a slow model cannot stall the client. */
	maxHoldMs: number;
	/** Tier to escalate to when the probe rejects the attempt. */
	escalateTo: Tier | null;
}

/** The routing decision for one turn. */
/**
 * A turn that was deliberately routed below its classified tier, so the
 * ledger witnesses whether the cheaper model would have sufficed.
 */
export interface Exploration {
	/** Tier the classifier actually chose. */
	from: Tier;
	/** Tier routed instead, exactly one step cheaper. */
	to: Tier;
}

export interface Decision {
	slug: string;
	/** Same-tier fallbacks for OpenRouter's `models[]` array; transient-error only. */
	fallbacks: string[];
	tier: Tier;
	classification: Classification;
	/** The extracted feature vector, retained verbatim for `explain`. */
	features: Features;
	forecast: CostForecast;
	sessionId: string;
	/** Reused the previous turn's model because switching was not worth the cache loss. */
	sticky: boolean;
	/** Message indices to mark with cache breakpoints. */
	cacheBreakpointMessageIndices: number[];
	/** In-place tool-result shrink edits to apply before dispatch. Empty ⇒ none. */
	compactionPlan: CompactionEdit[];
	/** Estimated prompt tokens removed by `compactionPlan`, for the ledger. */
	promptTokensSaved: number;
	reasoning: ReasoningLevel | undefined;
	maxTokens: number | undefined;
	stripAssistantReasoning: boolean;
	probe: ProbePlan;
	/** Candidates considered, ranked. Retained for `explain`. */
	considered: Candidate[];
	/** Filtered-out models with cause. Retained for `explain`. */
	rejected: Rejection[];
	reasons: string[];
	/** Set when epsilon-greedy exploration deliberately routed below the classified tier. */
	explored: Exploration | null;
	/** Budget guard forced a cheaper tier than the classifier asked for. */
	budgetDowngraded: boolean;
}

/** Why a guarded probe rejected an attempt. */
export type EscalationSignal =
	| "malformed_tool_args"
	| "refusal"
	| "empty_completion"
	| "repeat_tool_call"
	| "length_stop"
	| "missing_expected_tool_call"
	| "upstream_error";

export type ProbeVerdict =
	| { action: "commit"; reason: string }
	| { action: "escalate"; signal: EscalationSignal; reason: string };

export interface Router {
	/**
	 * Chooses a model for a request. Pure w.r.t. everything except the stores it
	 * reads. `excludeSlugs` removes models that already failed on this turn, so
	 * a failover retry cannot re-pick the slug that just errored.
	 */
	route(
		req: NormRequest,
		opts: { attempt: number; escalateFrom?: Tier; excludeSlugs?: readonly string[] },
	): Promise<Decision>;
}
