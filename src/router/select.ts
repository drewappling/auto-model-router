/**
 * Selection: turn a classification into a concrete model decision.
 *
 * This is the economic core of the router: profile clamping, hysteresis,
 * candidate widening, the cache-aware stay/switch arithmetic, the budget
 * guard, fallbacks, cache breakpoints, probe planning, and capability clamps.
 */

import type { CatalogSnapshot } from "../catalog/types.ts";
import type { ProfileConfig, RouterConfig } from "../config/types.ts";
import { priceAt } from "../cost/forecast.ts";
import type { Ledger } from "../cost/types.ts";
import { explorationDraw } from "./explore.ts";
import type { NormRequest, ReasoningLevel } from "../wire/types.ts";
import { planCacheBreakpoints } from "./cache-control.ts";
import { buildCandidates } from "./candidates.ts";
import {
	TIER_ORDER,
	type Candidate,
	type Classification,
	type ConversationState,
	type Decision,
	type Exploration,
	type Features,
	type ProbePlan,
	type Rejection,
	type Tier,
} from "./types.ts";

export interface SelectArgs {
	req: NormRequest;
	features: Features;
	classification: Classification;
	profile: ProfileConfig;
	state: ConversationState;
	snapshot: CatalogSnapshot;
	ledger: Ledger | null;
	cfg: RouterConfig;
	nowMs: number;
	/**
	 * Slugs that already failed on this turn. Passed straight to
	 * `buildCandidates` so a failover retry lands on a different model.
	 */
	excludeSlugs?: readonly string[];
}

/**
 * Thrown when the budget guard rejects a turn. `status`/`code` mirror the
 * WireError shape so the server can render it as a 402-class response.
 */
export class BudgetExceededError extends Error {
	readonly status = 402;
	readonly code = "budget_exceeded";
	constructor(message: string) {
		super(message);
		this.name = "BudgetExceededError";
	}
}

// Mid-range completion assumption for forecasts. Long generations amortize
// into prompt-dominated cost anyway; precision here does not move rankings.
const EXPECTED_COMPLETION_TOKENS = 1024;
const DAY_MS = 86_400_000;

/**
 * Authors known to accept replayed assistant reasoning over chat completions:
 * Anthropic requires thinking-block replay for tool-use continuity, and Google
 * requires thought signatures. Everything else gets reasoning stripped — a
 * rejected replay costs a whole turn.
 */
const REASONING_REPLAY_AUTHORS: Record<string, true> = {
	anthropic: true,
	google: true,
};

function tierIdx(t: Tier): number {
	return TIER_ORDER.indexOf(t);
}

function tierAt(i: number): Tier | null {
	const t = TIER_ORDER[i];
	return t === undefined ? null : t;
}

/** Tier search order: the tier itself, then one up, one down, two up, ... within [minTier, maxTier]. */
function wideningOrder(tier: Tier, minTier: Tier, maxTier: Tier): Tier[] {
	const lo = tierIdx(minTier);
	const hi = tierIdx(maxTier);
	const c = tierIdx(tier);
	const out: Tier[] = [];
	for (let d = 0; d <= Math.max(hi - c, c - lo); d++) {
		const up = tierAt(c + d);
		const down = tierAt(c - d);
		if (d === 0) {
			if (up !== null) out.push(up);
			continue;
		}
		if (up !== null && c + d <= hi) out.push(up);
		if (down !== null && c - d >= lo) out.push(down);
	}
	return out;
}

export function select(args: SelectArgs): Decision {
	const { req, features, classification, profile, state, snapshot, ledger, cfg, nowMs } = args;
	const reasons: string[] = [];
	const minI = tierIdx(profile.minTier);
	const maxI = tierIdx(profile.maxTier);
	const clampTier = (t: Tier): Tier => tierAt(Math.min(Math.max(tierIdx(t), minI), maxI)) ?? t;

	// 1. Clamp the classified tier to the requesting profile's envelope.
	let effective = clampTier(classification.tier);
	if (effective !== classification.tier) {
		reasons.push(`classified ${classification.tier}, clamped to profile ${profile.id} [${profile.minTier}..${profile.maxTier}] → ${effective}`);
	}

	// 2. Hysteresis: while the sticky window is open, never route below the
	//    held tier — per-turn flapping would repeatedly cold-start prompt caches.
	let cls = classification;
	if (state.stickyUntilTurn > state.turn && state.currentTier !== null && tierIdx(state.currentTier) >= tierIdx(effective)) {
		const held = clampTier(state.currentTier);
		if (held !== effective) {
			reasons.push(`hysteresis: holding ${held} until turn ${state.stickyUntilTurn} (classified ${effective})`);
			cls = {
				...classification,
				tier: held,
				source: "sticky",
				reasons: [`hysteresis hold ${held} until turn ${state.stickyUntilTurn}`, ...classification.reasons],
			};
			effective = held;
		}
	}
	// Never downgrade more than maxDowngradePerTurn tiers in one turn, so
	// quality never falls off a cliff on a single odd classification.
	if (state.currentTier !== null) {
		const floor = Math.max(tierIdx(state.currentTier) - cfg.hysteresis.maxDowngradePerTurn, minI);
		if (tierIdx(effective) < floor) {
			const clamped = tierAt(floor);
			if (clamped !== null) {
				reasons.push(`downgrade limited to ${cfg.hysteresis.maxDowngradePerTurn} tier(s)/turn: ${effective} → ${clamped}`);
				effective = clamped;
			}
		}
	}

	// Whether a usable warm prompt cache exists right now. Shared by
	// exploration (2c) and candidate building (3) so both agree on the term.
	const cacheWarm = state.cacheWarmSlug !== null && nowMs - state.cacheWarmAtMs <= cfg.hysteresis.cacheWarmTtlMs;

	// 2c. Epsilon-greedy exploration: on a small deterministic fraction of
	//     turns, route one tier BELOW the tier we would otherwise use, so the
	//     ledger witnesses whether the cheaper tier would have sufficed.
	//
	//     Escalation is what makes this safe rather than reckless: if the
	//     cheaper tier flounders, the probe rejects the attempt and the turn
	//     escalates, so a bad draw costs one wasted cheap attempt rather than
	//     a failed turn.
	//
	//     Sticky turns are explored only once their cache has gone cold. The
	//     hold exists to protect a warm cache, so exploring while one is live
	//     would destroy precisely what the hold is for; once it has expired
	//     the objection lapses. This matters more than it sounds: most
	//     expensive turns reach their tier by hold rather than by
	//     classification, so excluding held turns confines exploration to the
	//     cheapest boundary in the system.
	//
	//     Still skipped on forced escalations (the probe already proved the
	//     cheaper tier failed) and on failover retries, where a second
	//     confound is not wanted.
	//
	//     This deliberately bypasses maxDowngradePerTurn by one tier: that
	//     limiter guards against a noisy classification, not against a probe
	//     that is sampled on purpose and escalates when it is wrong.
	let explored: Exploration | null = null;
	const ex = cfg.exploration;
	const stickyAllows =
		cls.source !== "sticky" ||
		ex.stickyPolicy === "always" ||
		(ex.stickyPolicy === "cold-cache" && !cacheWarm);
	const tierRate = ex.rates[effective] ?? 0;
	if (
		ex.enabled &&
		tierRate > 0 &&
		stickyAllows &&
		classification.source !== "escalation" &&
		(args.excludeSlugs === undefined || args.excludeSlugs.length === 0)
	) {
		const target = tierAt(Math.max(tierIdx(effective) - 1, minI));
		if (target !== null && target !== effective && explorationDraw(`explore:${req.conversationKey}:${state.turn}`) < tierRate) {
			const held = cls.source === "sticky" ? `, held tier (${cacheWarm ? "warm" : "cold"} cache)` : "";
			reasons.push(`exploration: deliberately routing ${effective} → ${target} (rate ${tierRate}${held})`);
			explored = { from: effective, to: target };
			effective = target;
		}
	}
	// 3. Candidates for the effective tier; widen one tier upward, then
	//    downward, and only fail when the whole profile envelope is exhausted.
	// The task type selects the quality axis and capability filters; the tier
	// still bounds cost (task selects, tier budgets).
	const warmSlug = cacheWarm ? state.cacheWarmSlug : null;
	const build = (t: Tier, relaxLevel = 0): { candidates: Candidate[]; rejected: Rejection[] } =>
		buildCandidates({
			req,
			features,
			tier: t,
			task: classification.task,
			snapshot,
			ledger,
			cfg,
			expectedCompletionTokens: EXPECTED_COMPLETION_TOKENS,
			warmSlug,
			relaxLevel,
			...(args.excludeSlugs === undefined ? {} : { excludeSlugs: args.excludeSlugs }),
		});
	let chosenTier = effective;
	let built: { candidates: Candidate[]; rejected: Rejection[] } | null = null;
	// Relax level the tier rescue used (0 = no rescue). The budget downgrade
	// search must rebuild at the same level, or it re-applies the strict config
	// that excluded every model and throws instead of downgrading.
	let rescuedRelax = 0;
	for (const t of wideningOrder(effective, profile.minTier, profile.maxTier)) {
		const b = build(t);
		if (b.candidates.length > 0) {
			built = b;
			chosenTier = t;
			break;
		}
		reasons.push(`no candidates in ${t} (${b.rejected.length} rejected)`);
		built ??= b;
	}
	// Tier rescue: the configured envelopes (price ceilings, quality floors,
	// trust bar) were tuned against the full catalog, and a guardrail can shrink
	// availability so no configured tier admits anything. Rather than 500, relax
	// the tier's economic constraints — in order, price → quality → trust — until
	// some AVAILABLE model qualifies. Hard capability filters (tools/images/
	// context) and the key-scoped allowlist are never lifted.
	if (built === null || built.candidates.length === 0) {
		const envelope = wideningOrder(effective, profile.minTier, profile.maxTier);
		let rescued = false;
		for (let relax = 1; relax <= 3 && !rescued; relax++) {
			for (const t of envelope) {
				const b = build(t, relax);
				if (b.candidates.length > 0) {
					built = b;
					chosenTier = t;
					rescued = true;
					rescuedRelax = relax;
					break;
				}
			}
		}
		if (rescued) {
			const first = built!.candidates[0];
			const label =
				rescuedRelax === 1
					? "price ceilings"
					: rescuedRelax === 2
						? "price ceilings + quality floors"
						: "price ceilings + quality floors + trust bar";
			reasons.push(
				`tier rescue: strict config excluded all available models; relaxed ${label} to pick ${first!.model.slug} (${chosenTier})`,
			);
		} else if (built === null || built.candidates.length === 0) {
			throw new Error(`no viable model: catalog exhausted across profile ${profile.id}`);
		}
	}
	if (chosenTier !== effective) reasons.push(`widened ${effective} → ${chosenTier}`);
	// After the rescue block, `built` is guaranteed non-null: the branch either
	// rescued a non-empty candidate set, or threw the `catalog exhausted` error.
	const resolved = built as { candidates: Candidate[]; rejected: Rejection[] };
	let candidates = resolved.candidates;
	const first = candidates[0];
	if (first === undefined) throw new Error(`no viable model: catalog exhausted across profile ${profile.id}`);
	let chosen = first;

	// 4. Cache-aware switch decision. Staying prices the previous turn's prompt
	//    at the warm model's cache-read rate; switching prices the full current
	//    prompt at the new model's cold rate plus its cache-write premium (we
	//    assume the whole prompt is written). Switch only when the saving
	//    clears switchMargin.
	let sticky = false;
	if (warmSlug !== null && chosen.model.slug !== warmSlug) {
		const warm = candidates.find((c) => c.model.slug === warmSlug);
		if (warm !== undefined) {
			const warmPrice = priceAt(warm.model, Math.max(1, state.lastPromptTokens));
			const newPrice = priceAt(chosen.model, Math.max(1, features.promptTokens));
			const stayCost = state.lastPromptTokens * (warmPrice.cacheRead ?? warmPrice.prompt);
			const switchCost = features.promptTokens * (newPrice.prompt + (newPrice.cacheWrite ?? 0));
			if (stayCost > switchCost * cfg.hysteresis.switchMargin) {
				reasons.push(
					`cache: switch ${warmSlug} → ${chosen.model.slug} (stay $${stayCost.toFixed(4)} > switch $${switchCost.toFixed(4)} × ${cfg.hysteresis.switchMargin})`,
				);
			} else {
				chosen = warm;
				sticky = true;
				reasons.push(
					`cache: keeping warm ${warmSlug} (stay $${stayCost.toFixed(4)} ≤ switch $${switchCost.toFixed(4)} × ${cfg.hysteresis.switchMargin})`,
				);
			}
		}
	}

	// 5. Budget guard, against the COLD forecast: a budget must survive a cache miss.
	const budget = {
		perTurnUsd: profile.budget?.perTurnUsd ?? cfg.budget.perTurnUsd,
		perConversationUsd: profile.budget?.perConversationUsd ?? cfg.budget.perConversationUsd,
		perDayUsd: profile.budget?.perDayUsd ?? cfg.budget.perDayUsd,
		onExceeded: profile.budget?.onExceeded ?? cfg.budget.onExceeded,
	};
	const breach = (c: Candidate): string | null => {
		if (budget.perTurnUsd !== undefined && c.forecast.coldUsd > budget.perTurnUsd) {
			return `cold forecast $${c.forecast.coldUsd.toFixed(4)} > per-turn budget $${budget.perTurnUsd}`;
		}
		if (budget.perConversationUsd !== undefined && state.spentUsd + c.forecast.coldUsd > budget.perConversationUsd) {
			return `conversation spend $${state.spentUsd.toFixed(4)} + cold forecast > per-conversation budget $${budget.perConversationUsd}`;
		}
		if (budget.perDayUsd !== undefined) {
			// Scope the rolling 24h ceiling to the requesting harness when it
			// identifies itself, so multiple harnesses sharing one router each get
			// their own daily budget instead of one exhausting it for the others.
			const daySpend = ledger?.spendSince(nowMs - DAY_MS, req.harnessId) ?? 0;
			if (daySpend + c.forecast.coldUsd > budget.perDayUsd) {
				return `24h spend $${daySpend.toFixed(4)} + cold forecast > per-day budget $${budget.perDayUsd}`;
			}
		}
		return null;
	};
	let budgetDowngraded = false;
	const why = breach(chosen);
	if (why !== null) {
		if (budget.onExceeded === "reject") throw new BudgetExceededError(why);
		// Downgrade: the cheapest candidate in the cheapest tier that fits.
		let rescue: { tier: Tier; candidate: Candidate; candidates: Candidate[] } | null = null;
		for (const t of wideningOrder(profile.minTier, profile.minTier, profile.maxTier)) {
			const b = build(t, rescuedRelax);
			let cheapest: Candidate | null = null;
			for (const c of b.candidates) {
				if (cheapest === null || c.forecast.coldUsd < cheapest.forecast.coldUsd) cheapest = c;
			}
			if (cheapest !== null && breach(cheapest) === null) {
				rescue = { tier: t, candidate: cheapest, candidates: b.candidates };
				break;
			}
		}
		if (rescue === null) throw new BudgetExceededError(`${why}; no cheaper candidate fits the budget`);
		reasons.push(`budget: ${why}; downgraded ${chosenTier} → ${rescue.tier} (${rescue.candidate.model.slug})`);
		chosen = rescue.candidate;
		chosenTier = rescue.tier;
		candidates = rescue.candidates;
		budgetDowngraded = true;
		sticky = false;
	}

	// 6. Same-tier fallbacks for OpenRouter's transient-error `models[]` cascade.
	const fallbacks: string[] = [];
	for (const c of candidates) {
		if (c.model.slug === chosen.model.slug) continue;
		fallbacks.push(c.model.slug);
		if (fallbacks.length >= 2) break;
	}

	// 7. Cache breakpoints.
	const cacheBreakpointMessageIndices = planCacheBreakpoints(req, chosen.model, cfg);

	// 8. Guarded probe: only tiers configured for probing, and only when a
	//    strictly higher tier exists inside the profile envelope to escalate into.
	const nextTier = tierAt(tierIdx(chosenTier) + 1);
	const escalateTo = nextTier !== null && tierIdx(nextTier) <= maxI ? nextTier : null;
	const probeEnabled = cfg.escalation.enabled && escalateTo !== null && cfg.escalation.probeTiers.includes(chosenTier);
	const probe: ProbePlan = {
		enabled: probeEnabled,
		maxTokens: cfg.escalation.probeTokens,
		maxHoldMs: cfg.escalation.maxHoldMs,
		escalateTo: probeEnabled ? escalateTo : null,
	};

	// 9. Clamp reasoning and output budget to what the target supports.
	let reasoning: ReasoningLevel | undefined = req.reasoning;
	if (reasoning !== undefined && !chosen.model.supportsReasoning) {
		if (reasoning !== "off") reasons.push(`dropped reasoning=${reasoning}: ${chosen.model.slug} does not support it`);
		reasoning = undefined;
	}
	if (chosen.model.reasoningMandatory && (reasoning === undefined || reasoning === "off")) {
		reasoning = "minimal";
		reasons.push(`reasoning forced to minimal: ${chosen.model.slug} has mandatory reasoning`);
	}
	let maxTokens: number | undefined = req.maxTokens;
	const ceiling = chosen.model.maxCompletionTokens;
	if (ceiling !== undefined) {
		// The ceiling is a hard limit anyway; passing it explicitly also caps runaway completions.
		maxTokens = maxTokens === undefined ? ceiling : Math.min(maxTokens, ceiling);
	}
	const stripAssistantReasoning = !(chosen.model.supportsReasoning && REASONING_REPLAY_AUTHORS[chosen.model.author] === true);

	return {
		slug: chosen.model.slug,
		fallbacks,
		tier: chosenTier,
		classification: cls,
		features,
		forecast: chosen.forecast,
		sessionId: state.sessionId,
		sticky,
		cacheBreakpointMessageIndices,
		reasoning,
		maxTokens,
		stripAssistantReasoning,
		probe,
		considered: candidates,
		rejected: resolved.rejected,
		reasons,
		explored,
		budgetDowngraded,
	};
}
