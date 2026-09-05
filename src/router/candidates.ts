/**
 * Candidate construction: hard capability filters over the catalog, then
 * forecast + scoring for the survivors. The `rejected` array is what
 * `auto-model-router explain` shows, so every drop records its precise reason.
 */

import type { CatalogModel, CatalogSnapshot } from "../catalog/types.ts";
import type { FilterConfig, QualityAxis, RouterConfig } from "../config/types.ts";
import { forecast, priceAt } from "../cost/forecast.ts";
import type { Ledger, LedgerSignals, ModelLatency } from "../cost/types.ts";
import type { NormRequest } from "../wire/types.ts";
import { effectivePriceCeiling, effectiveQualityFloor, tierPlanFor } from "./tier-plan.ts";
import type { Candidate, Features, Rejection, TaskType, Tier } from "./types.ts";

export interface BuildCandidatesArgs {
	/** Pre-fetched trust/latency signals for all candidate slugs. When provided, buildCandidates uses these instead of per-slug ledger calls. */
	signals?: Map<string, LedgerSignals>;
	/**
	 * Measured cost of an escalated retry per prompt token (from
	 * `Ledger.escalationCost`). With `filters.escalationCostWeight` > 0 a
	 * model's measured escalation rate is priced at this; absent ⇒ term inert.
	 */
	escalationUsdPerPromptToken?: number;
	req: NormRequest;
	features: Features;
	tier: Tier;
	/** Task type; its config selects the axis, quality floor, and image filter. */
	task: TaskType;
	snapshot: CatalogSnapshot;
	ledger: Ledger | null;
	cfg: RouterConfig;
	expectedCompletionTokens: number;
	/** Slug whose prompt cache is warm this turn; wins score ties. */
	warmSlug: string | null;
	/**
	 * Tier rescue depth when the strict config excludes every available model.
	 * 0 = strict (price ceiling + quality floor + trust bar all enforced).
	 * Higher levels drop constraints in order: 1 removes price ceilings, 2 also
	 * drops the quality floor, 3 also ignores the trust bar. Never lifts the
	 * hard capability filters (tools/images/context) or the key-scoped allowlist.
	 */
	relaxLevel?: number;
	/**
	 * Slugs this turn must not select — the models that already failed on it.
	 * Failover re-selects with the failed slug excluded so a retry lands on a
	 * DIFFERENT model instead of re-issuing the one that just errored.
	 */
	excludeSlugs?: readonly string[];
}

/** Tiny glob: `*` matches any run of characters; everything else is literal. */
function globToRe(glob: string): RegExp {
	const escaped = glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : `\\${ch}`));
	return new RegExp(`^${escaped}$`);
}

/**
 * Quality fallback chain: score the preferred axis first, then the general
 * intelligence index (the most widely published), then the remaining axis.
 * A model absent on every axis is UNSCORED — never impute a score from price.
 */
const AXIS_FALLBACK: Record<QualityAxis, readonly [QualityAxis, QualityAxis, QualityAxis]> = {
	coding: ["coding", "intelligence", "agentic"],
	agentic: ["agentic", "intelligence", "coding"],
	intelligence: ["intelligence", "coding", "agentic"],
};

function resolveQuality(model: CatalogModel, axis: QualityAxis): { score: number; axis: QualityAxis } | null {
	for (const a of AXIS_FALLBACK[axis]) {
		const v = model.quality[a];
		if (v !== undefined) return { score: v, axis: a };
	}
	return null;
}

/** Neutral trust prior for models our ledger has never observed. */
const UNMEASURED_TRUST = 0.9;

/**
 * Prior on the escalation rate, as pseudo-counts: an unobserved model is
 * assumed to escalate ESCALATION_PRIOR times in ESCALATION_PRIOR_N attempts
 * (0.25%), so a new cheap model is not priced out before it has been tried,
 * and a model with a handful of attempts is pulled toward that rather than
 * toward 0% or 100%.
 */
const ESCALATION_PRIOR = 0.05;
const ESCALATION_PRIOR_N = 20;

/** Excess-ratio cap so one very slow model cannot be penalised into oblivion. */
const LATENCY_EXCESS_CAP = 3;

/** Expected total wait: time to first token plus streaming the expected completion at measured throughput. */
function expectedWaitMs(latency: ModelLatency, expectedCompletionTokens: number): number {
	const streamMs = latency.tokensPerSec > 0 ? (expectedCompletionTokens / latency.tokensPerSec) * 1000 : 0;
	return latency.ttftMs + streamMs;
}

/**
 * Latency penalty as a multiplier on effective cost (>= 1; 1 = no penalty).
 *
 * Models the EXPECTED TOTAL WAIT the user experiences: time to first token, plus
 * streaming the expected completion at the model's measured throughput. That wait
 * above the reference (built from `latencyReferenceMs` + `latencyReferenceTokensPerSec`)
 * inflates effective cost — the same lever trust uses for flakiness — so a faster
 * model of equal quality and price outranks a sluggish one. Capturing throughput,
 * not just TTFT, is what catches a model that starts fast but streams slowly
 * (deepseek-v4-flash: ~2s TTFT yet ~20 tok/s → ~38s total). Inert when the weight
 * is 0 or the model has too few streamed samples to judge.
 *
 * The penalty CANNOT discipline a slow-but-cheap model: it is multiplicative on a
 * tiny cost and capped at LATENCY_EXCESS_CAP, so the model stays cheapest. That is
 * `filters.maxExpectedWaitMs`'s job — a hard drop, applied in buildCandidates.
 */
function latencyMultiplier(latency: ModelLatency | null, filters: FilterConfig, expectedCompletionTokens: number): number {
	if (latency === null || filters.latencyWeight <= 0 || latency.samples < filters.latencyMinSamples) return 1;
	const waitMs = expectedWaitMs(latency, expectedCompletionTokens);
	const refWaitMs = filters.latencyReferenceMs + (expectedCompletionTokens / filters.latencyReferenceTokensPerSec) * 1000;
	const excess = refWaitMs > 0 ? Math.max(0, (waitMs - refWaitMs) / refWaitMs) : 0;
	return 1 + filters.latencyWeight * Math.min(excess, LATENCY_EXCESS_CAP);
}

export function buildCandidates(args: BuildCandidatesArgs): { candidates: Candidate[]; rejected: Rejection[] } {
	const { req, features, tier, task, snapshot, ledger, cfg, expectedCompletionTokens, warmSlug, relaxLevel = 0 } = args;
	// A Set only when non-empty: the common path allocates nothing.
	const excluded = args.excludeSlugs === undefined || args.excludeSlugs.length === 0 ? null : new Set(args.excludeSlugs);
	const tierCfg = cfg.tiers[tier];
	const taskCfg = cfg.tasks[task];
	const filters = cfg.filters;
	const relaxPrice = relaxLevel >= 1;
	const relaxQuality = relaxLevel >= 2;
	const relaxTrust = relaxLevel >= 3;
	const allowRes = filters.allow.map(globToRe);
	const denyRes = filters.deny.map(globToRe);
	const needTools = req.tools.length > 0 && filters.requireToolSupport;
	const minContext = Math.ceil(features.promptTokens * filters.contextHeadroom) + expectedCompletionTokens;
	// Task selects the quality axis and capability filters; the tier still
	// bounds cost.
	const effectiveAxis = taskCfg.axis;
	// Two floors with different meanings, and only one of them may be relaxed:
	//  - the TIER floor is an economic envelope tuned against the full catalog,
	//    so when a guardrail narrows availability below it, relaxing to the
	//    best available band is right (otherwise the tier is empty forever).
	//  - the TASK floor is a capability requirement (vision needs a model that
	//    can actually see), so adaptive relaxation must never lower it.
	const taskFloor = taskCfg.minQuality ?? 0;
	const plan = cfg.adaptiveTierFloors || cfg.adaptivePriceCeilings ? tierPlanFor(snapshot, cfg) : null;
	const adaptiveTierFloor =
		cfg.adaptiveTierFloors && plan !== null
			? effectiveQualityFloor(tierCfg.minQuality, tier, effectiveAxis, plan)
			: tierCfg.minQuality;
	const qualityFloor = Math.max(taskFloor, adaptiveTierFloor);
	// Input-price ceiling: catalog-derived band when adaptive, else the fixed config.
	const priceCeiling =
		cfg.adaptivePriceCeilings && plan !== null
			? effectivePriceCeiling(tierCfg.maxInputPerMtok, tier, plan, true)
			: tierCfg.maxInputPerMtok;
	const taskPins = taskCfg.prefer ?? [];
	let images = 0;
	if (req.hasImages) for (const m of req.messages) images += m.images;

	const candidates: Candidate[] = [];
	const rejected: Rejection[] = [];
	// Carries the trust/latency-adjusted cost into the second scoring pass.
	const effectiveUsdBySlug = new Map<string, number>();

	for (const model of snapshot.models) {
		const slug = model.slug;

		// Failover exclusion comes first: a model that already failed this turn
		// is not a candidate no matter how well it scores.
		if (excluded !== null && excluded.has(slug)) {
			rejected.push({ slug, reason: "failed_this_turn" });
			continue;
		}

		// Hard-coded denials, before any user configuration. These slugs can
		// never serve an interactive turn:
		//  - "~vendor/model-latest": floating aliases whose identity changes
		//    underneath us, poisoning ledger trust statistics.
		//  - ":batch": asynchronous batch endpoints, unusable for streaming.
		//  - "stealth/": cloaked models with no stable identity.
		//  - "openrouter/": their meta-routers do our job at unknown cost.
		if (slug.startsWith("~") || slug.endsWith(":batch") || slug.startsWith("stealth/") || model.author === "openrouter") {
			rejected.push({ slug, reason: "denylisted", detail: "built-in deny: floating alias, batch endpoint, stealth, or meta-router" });
			continue;
		}
		// A negative price is OpenRouter's unknown/dynamic sentinel (-1), never a discount.
		if (model.price.prompt < 0 || model.price.completion < 0) {
			rejected.push({ slug, reason: "denylisted", detail: "dynamic pricing sentinel" });
			continue;
		}
		if (allowRes.length > 0 && !allowRes.some((re) => re.test(slug))) {
			rejected.push({ slug, reason: "not_allowlisted" });
			continue;
		}
		if (denyRes.some((re) => re.test(slug))) {
			rejected.push({ slug, reason: "denylisted", detail: "filters.deny" });
			continue;
		}
		if (model.isFree && !filters.includeFree) {
			rejected.push({ slug, reason: "free_tier_excluded" });
			continue;
		}
		if (needTools && !model.supportsTools) {
			rejected.push({ slug, reason: "no_tool_support" });
			continue;
		}
		if ((req.hasImages || taskCfg.requireImage === true) && !model.inputModalities.includes("image")) {
			rejected.push({ slug, reason: "no_image_support" });
			continue;
		}
		if (model.contextLength < minContext) {
			rejected.push({ slug, reason: "context_too_small", detail: `window ${model.contextLength} < required ${minContext}` });
			continue;
		}

		const pinned = tierCfg.pin.includes(slug) || taskPins.includes(slug);
		const quality = resolveQuality(model, effectiveAxis);
		if (!pinned && !relaxQuality && qualityFloor > 0) {
			if (quality === null) {
				rejected.push({ slug, reason: "below_quality_floor", detail: "no published quality score" });
				continue;
			}
			if (quality.score < qualityFloor) {
				rejected.push({ slug, reason: "below_quality_floor", detail: `${quality.score} < floor ${qualityFloor}` });
				continue;
			}
		}

		// Price ceilings at the ACTUAL prompt size: long-context overrides can
		// push a model over the ceiling exactly when conversations get long.
		// Catalog prices are per-token; ceilings are per million tokens.
		const price = priceAt(model, Math.max(1, features.promptTokens));
		if (!relaxPrice && priceCeiling !== undefined && price.prompt * 1e6 > priceCeiling) {
			rejected.push({
				slug,
				reason: "over_price_ceiling",
				detail: `input $${(price.prompt * 1e6).toFixed(2)}/Mtok > ceiling $${priceCeiling.toFixed(2)}`,
			});
			continue;
		}
		if (!relaxPrice && tierCfg.maxOutputPerMtok !== undefined && price.completion * 1e6 > tierCfg.maxOutputPerMtok) {
			rejected.push({
				slug,
				reason: "over_price_ceiling",
				detail: `output $${(price.completion * 1e6).toFixed(2)}/Mtok > ceiling $${tierCfg.maxOutputPerMtok}`,
			});
			continue;
		}

		// Use pre-fetched signals when available (batch lookup, one query per
		// signal kind for the entire candidate set instead of one per model).
		// Falls back to per-slug calls when signals is not provided (e.g. tests).
		const signals = args.signals;
		const trust =
			signals?.get(slug)?.trust ??
			ledger?.trust(slug, filters.trustScopedByHarness ? req.harnessId : undefined) ??
			null;
		if (!relaxTrust && trust !== null && trust.attempts >= filters.minTrustSamples && trust.successRate < filters.minTrust) {
			rejected.push({
				slug,
				reason: "untrusted",
				detail: `success ${trust.successRate.toFixed(2)} over ${trust.attempts} attempts < ${filters.minTrust}`,
			});
			continue;
		}

		// Fetch latency ONCE for both the ceiling gate here and the scoring
		// multiplier below. Absolute latency ceiling: a hard drop, mirroring the
		// price ceiling, for models PROVEN slow (>= latencyMinSamples). The penalty
		// alone cannot demote a slow-but-cheap model (see latencyMultiplier); this
		// gate can. Only measured models are dropped, so a new model still gets its
		// cold-start turns to accumulate samples. Relaxed with trust in rescue.
		const needLatency = filters.latencyWeight > 0 || filters.maxExpectedWaitMs !== undefined;
		const latency = needLatency
			? (signals?.get(slug)?.latency ??
				ledger?.latency(slug, filters.trustScopedByHarness ? req.harnessId : undefined) ??
				null)
			: null;
		if (
			!relaxTrust &&
			filters.maxExpectedWaitMs !== undefined &&
			latency !== null &&
			latency.samples >= filters.latencyMinSamples
		) {
			const waitMs = expectedWaitMs(latency, expectedCompletionTokens);
			if (waitMs > filters.maxExpectedWaitMs) {
				rejected.push({
					slug,
					reason: "over_latency_ceiling",
					detail: `expected wait ${Math.round(waitMs)}ms > ceiling ${filters.maxExpectedWaitMs}ms (ttft ${Math.round(latency.ttftMs)}ms, ${latency.tokensPerSec.toFixed(0)} tok/s over ${latency.samples} samples)`,
				});
				continue;
			}
		}

		// Every candidate is priced COLD, deliberately, and this has been measured
		// rather than assumed. Two reasons:
		//  1. `coldUsd` feeds the budget guard in select.ts, and a budget must
		//     survive a cache miss.
		//  2. Discounting the warm slug here only ever LOWERS its effective cost,
		//     so it can only make the warm model win more often — and the warm
		//     model is already either the cheapest candidate or kept by the
		//     dedicated stay-vs-switch comparison in select.ts step 4, which does
		//     price staying at `cacheRead` against switching at cold+`cacheWrite`.
		//     So the ranking change has no headroom to alter an outcome.
		// Verified with tools/replay.ts: scoring the warm candidate at hit rates
		// 0.5 / 0.8 / 0.95 changed 0 of 897 decisions, and 0 of 702 on the subset
		// whose conversations ran the expensive model. Cache economics belong in
		// the switch decision, not in candidate scoring — do not "fix" this.
		const fc = forecast(model, {
			promptTokens: features.promptTokens,
			completionTokens: expectedCompletionTokens,
			cacheHitRate: 0,
			images,
		});
		const trustScore = trust !== null && trust.attempts > 0 ? trust.successRate : UNMEASURED_TRUST;
		const qualityScore = quality?.score ?? 0;
		// Shared scoring: trust converts flakiness into money — a model failing
		// 20% of the time really costs ~25% more in retries. Latency does the same
		// for slowness (TTFT over the reference). qualityExponent 0 makes this
		// "cheapest above the floor"; the floor does the quality work.
		const latencyMult = latencyMultiplier(latency, filters, expectedCompletionTokens);
		// Escalation-cost term: the trust divisor prices a failure as a retry of
		// THIS model, but a probe escalation re-dispatches the whole prompt on
		// the next tier's model — measured at ~700x a cheap model's own turn cost.
		// Price the measured rate at what an escalated retry actually bills.
		const escalationRate =
			trust !== null && trust.attempts > 0
				? (trust.escalations + ESCALATION_PRIOR) / (trust.attempts + ESCALATION_PRIOR_N)
				: ESCALATION_PRIOR / ESCALATION_PRIOR_N;
		const escalationUsd =
			filters.escalationCostWeight > 0 && args.escalationUsdPerPromptToken !== undefined
				? filters.escalationCostWeight * escalationRate * args.escalationUsdPerPromptToken * features.promptTokens
				: 0;
		const effectiveUsd = (fc.expectedUsd / Math.max(trustScore, 0.5) + escalationUsd) * latencyMult;
		// Score is assigned in a SECOND PASS below: both qualityNormalization and
		// capabilityFloorUsd are properties of the candidate SET, not of one
		// model, so no per-model value can be computed here. Placeholder only.
		const score = 0;

		const reasons: string[] = [
			quality === null
				? "unscored on every quality axis"
				: `quality ${quality.score} on ${quality.axis}${quality.axis === effectiveAxis ? "" : ` (fallback from ${effectiveAxis})`}`,
			trust === null || trust.attempts === 0
				? `trust unmeasured: neutral prior ${UNMEASURED_TRUST}`
				: `trust ${trustScore.toFixed(2)} over ${trust.attempts} attempts`,
			`expected $${fc.expectedUsd.toFixed(6)}`,
		];
		if (escalationUsd > 0) {
			reasons.push(`escalation risk +$${escalationUsd.toFixed(6)} (rate ${(escalationRate * 100).toFixed(2)}% × measured retry cost)`);
		}
		if (latencyMult > 1 && latency !== null) {
			reasons.push(
				`latency penalty ×${latencyMult.toFixed(2)} (ttft ${Math.round(latency.ttftMs)}ms, ${latency.tokensPerSec.toFixed(0)} tok/s over ${latency.samples} samples)`,
			);
		}
		if (pinned) reasons.push("pinned into tier");
		candidates.push({ model, forecast: fc, qualityScore, trustScore, score, reasons });
		effectiveUsdBySlug.set(slug, effectiveUsd);
	}

	// Second pass: both new tier modes need the whole set.
	//  - qualityNormalization rescales quality to the set's own [worst, best]
	//    range, so the exponent operates on a full 0-1 spread instead of the
	//    raw index's compressed 69-78 band.
	//  - capabilityFloorUsd ignores the ratio entirely and takes the highest
	//    quality candidate affordable within the cap.
	const qualities = candidates.map((c) => c.qualityScore);
	const qMin = qualities.length > 0 ? Math.min(...qualities) : 0;
	const qMax = qualities.length > 0 ? Math.max(...qualities) : 0;
	const qSpread = qMax - qMin;
	const normalize = tierCfg.qualityNormalization === true && qSpread > 0;
	for (const c of candidates) {
		const effectiveUsd = effectiveUsdBySlug.get(c.model.slug) ?? c.forecast.expectedUsd;
		// Normalised quality is unitless in [0,1]: the set's cheapest-quality
		// model scores 0, its best scores 1. A single-model set has no spread,
		// so it keeps the raw path (guarded by qSpread > 0).
		const q = normalize ? (c.qualityScore - qMin) / qSpread : c.qualityScore / 100;
		c.score = Math.pow(q, tierCfg.qualityExponent) / Math.max(effectiveUsd, 1e-9);
		if (normalize) {
			c.reasons.push(`quality normalised ${q.toFixed(3)} within set [${qMin}, ${qMax}]`);
		}
	}

	candidates.sort((a, b) => {
		const d = b.score - a.score;
		if (d !== 0) return d;
		// When the quality floor is relaxed, unscored models all score 0 and the
		// lexical tie-break would pick alphabetically. Prefer the cheaper model
		// first, then the warm slug, then lexical for determinism.
		if (relaxQuality) {
			const cd = a.forecast.expectedUsd - b.forecast.expectedUsd;
			if (cd !== 0) return cd;
		}
		// Ties break toward the model already warm in this conversation, then
		// lexically for determinism.
		if (a.model.slug === warmSlug) return -1;
		if (b.model.slug === warmSlug) return 1;
		return a.model.slug < b.model.slug ? -1 : 1;
	});

	// Capability-floor mode: the top tier's job is "best model the work needs",
	// which quality-per-dollar cannot express — a bargain model always wins the
	// ratio however weak it is. Promote the highest-quality candidate whose
	// forecast turn cost fits the cap to the front. Strictly an upgrade: when
	// nothing is affordable, or the ranked winner is already the best quality,
	// the order is untouched.
	const floorUsd = tierCfg.capabilityFloorUsd;
	if (floorUsd !== undefined && candidates.length > 1) {
		let best: Candidate | undefined;
		for (const c of candidates) {
			if (c.forecast.coldUsd > floorUsd) continue;
			if (best === undefined || c.qualityScore > best.qualityScore) best = c;
		}
		if (best !== undefined && best !== candidates[0]) {
			const idx = candidates.indexOf(best);
			candidates.splice(idx, 1);
			candidates.unshift(best);
			best.reasons.push(
				`capability floor: highest quality ${best.qualityScore} within $${floorUsd}/turn (cold $${best.forecast.coldUsd.toFixed(4)})`,
			);
		}
	}
	return { candidates, rejected };
}
