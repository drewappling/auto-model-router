/**
 * Adaptive tier floors: derive each tier's quality floor from the models that
 * are ACTUALLY available, recomputed whenever a catalog refresh installs a new
 * snapshot.
 *
 * Why this exists. The configured floors (trivial 0, simple 40, moderate 60,
 * hard 72) are absolute points on the Artificial Analysis index, tuned against
 * the full ~420-model catalog. An OpenRouter key's guardrail can narrow the
 * available set to a handful of models that all sit below those points, and an
 * absolute floor then admits NOTHING: every tier above `trivial` goes
 * permanently empty, selection widens down, and the router is trapped serving
 * the cheapest model for every turn regardless of how hard the work is.
 *
 * The fix is to treat the floors as relative when the absolute ones cannot be
 * met. Rank the available scored models, split them into four quantile bands,
 * and take each band's lower bound as that tier's adaptive floor. The adaptive
 * floor applies ONLY when the configured one leaves the tier thin:
 *
 *  - When at least `MIN_FLOOR_ADMITS` rankable models meet the configured
 *    floor, the configured floor stands verbatim — no behaviour change.
 *  - When fewer do (a narrowed catalog), the effective floor is
 *    `min(configured, adaptive)`, so `hard` still gets the best quartile of
 *    what is available instead of nothing at all.
 *
 * The thinness gate is load-bearing. An earlier version applied `min` always,
 * on the assumption that a healthy catalog's bands sit above the configured
 * floors. They do not: a wide catalog carries a long tail of weak scored models
 * (measured on 347 key-admitted models: coding p50 = 45.8 against a configured
 * `moderate` floor of 60, p75 = 59.9 against `hard`'s 72), so `min` silently
 * relaxed every tier and a coding-50 model won `moderate` — then escalated 14x
 * more often than the model the configured floor would have picked.
 *
 * Adaptive floors may only RELAX a floor, never tighten one. Tightening would
 * let a rich catalog silently price us out of a tier the operator explicitly
 * configured.
 *
 * Unscored models are never imputed a score (see `candidates.ts`), so a catalog
 * with no benchmarks at all yields all-zero floors: every tier admits every
 * model and the price ceiling plus `qualityExponent` do the differentiating.
 * That is the honest degradation — there is genuinely no measured quality
 * spread to rank on.
 */

import type { CatalogModel, CatalogSnapshot } from "../catalog/types.ts";
import type { QualityAxis, RouterConfig } from "../config/types.ts";
import { TIER_ORDER, type Tier } from "./types.ts";

const AXES: readonly QualityAxis[] = ["coding", "agentic", "intelligence"];

/** Adaptive floor per tier, for one quality axis. */
export type AxisFloors = Record<Tier, number>;

export interface TierPlan {
	/** Adaptive quality floor per axis per tier. */
	floors: Record<QualityAxis, AxisFloors>;
	/** How many available models carried a score on each axis. */
	scoredCount: Record<QualityAxis, number>;
	/** Rankable models' scores per axis, ascending — what the floors were cut from. */
	scores: Record<QualityAxis, readonly number[]>;
	/** Adaptive input-price ceiling ($/Mtok) per tier, from the catalog's price spread. */
	priceCeilings: Record<Tier, number>;
}

/**
 * Rankable models a configured floor must admit for it to stand as written.
 * Below this the tier is "thin" and the adaptive band may relax the floor.
 * Three, not one: a lone survivor leaves no same-tier failover and no
 * meaningful cost ranking, which is the narrowed-catalog situation this whole
 * module exists to escape.
 */
export const MIN_FLOOR_ADMITS = 3;

/**
 * Models that could plausibly serve a turn, for ranking purposes: the built-in
 * denials (floating aliases, batch endpoints, stealth, meta-routers) and free
 * models would otherwise skew the quantiles with entries selection can never
 * pick. This mirrors the built-in denials in `buildCandidates`; per-request
 * filters (tools, context, images) are deliberately NOT applied, because the
 * plan is computed once per refresh, not once per request.
 */
function isRankable(model: CatalogModel, includeFree: boolean): boolean {
	const slug = model.slug;
	if (slug.startsWith("~") || slug.endsWith(":batch") || slug.startsWith("stealth/")) return false;
	if (model.author === "openrouter") return false;
	if (model.price.prompt < 0 || model.price.completion < 0) return false;
	if (model.isFree && !includeFree) return false;
	return true;
}

/**
 * Quantile band lower bounds over an ascending score list, one per tier.
 *
 * Tier k of n takes the score at index `floor(len * k / n)`. With four tiers
 * that is the min, p25, p50 and p75, so each tier's floor admits roughly the
 * top `(n-k)/n` of the available models — every tier non-empty by construction
 * whenever at least one model is scored.
 */
function bandFloors(ascending: readonly number[]): AxisFloors {
	const floors: Record<string, number> = {};
	const len = ascending.length;
	for (let k = 0; k < TIER_ORDER.length; k++) {
		const tier = TIER_ORDER[k];
		if (tier === undefined) continue;
		if (len === 0) {
			floors[tier] = 0;
			continue;
		}
		const index = Math.min(len - 1, Math.floor((len * k) / TIER_ORDER.length));
		floors[tier] = ascending[index] ?? 0;
	}
	return floors as AxisFloors;
}

/**
 * Per-tier input-price ceiling ($/Mtok) from an ascending price list: quantile
 * UPPER bounds, so each higher tier admits a larger, pricier slice. p25/p50/p75
 * for trivial/simple/moderate, and p90 for `hard` — high enough to keep the
 * strong models but dropping the priciest outliers. The catalog decides the
 * dollar values, so this self-tunes to whatever models a key actually admits.
 */
const CEILING_QUANTILES: readonly number[] = [0.25, 0.5, 0.75, 0.9];

function bandCeilings(ascending: readonly number[]): Record<Tier, number> {
	const out: Record<string, number> = {};
	const len = ascending.length;
	for (let k = 0; k < TIER_ORDER.length; k++) {
		const tier = TIER_ORDER[k];
		if (tier === undefined) continue;
		if (len === 0) {
			out[tier] = Number.POSITIVE_INFINITY; // no data ⇒ no cap
			continue;
		}
		const q = CEILING_QUANTILES[k] ?? 1;
		const index = Math.min(len - 1, Math.max(0, Math.ceil(len * q) - 1));
		out[tier] = ascending[index] ?? Number.POSITIVE_INFINITY;
	}
	return out as Record<Tier, number>;
}

/** Computes the adaptive plan for a set of available models. */
export function computeTierPlan(models: readonly CatalogModel[], cfg: RouterConfig): TierPlan {
	const floors: Record<string, AxisFloors> = {};
	const scoredCount: Record<string, number> = {};
	const axisScores: Record<string, readonly number[]> = {};
	const includeFree = cfg.filters.includeFree;

	for (const axis of AXES) {
		const scores: number[] = [];
		for (const model of models) {
			if (!isRankable(model, includeFree)) continue;
			const score = model.quality[axis];
			if (score === undefined) continue;
			scores.push(score);
		}
		scores.sort((a, b) => a - b);
		floors[axis] = bandFloors(scores);
		scoredCount[axis] = scores.length;
		axisScores[axis] = scores;
	}
	// Input prices ($/Mtok) of the rankable models, ascending, for the ceilings.
	const prices: number[] = [];
	for (const model of models) {
		if (!isRankable(model, includeFree)) continue;
		prices.push(model.price.prompt * 1e6);
	}
	prices.sort((a, b) => a - b);

	return {
		floors: floors as Record<QualityAxis, AxisFloors>,
		scoredCount: scoredCount as Record<QualityAxis, number>,
		scores: axisScores as Record<QualityAxis, readonly number[]>,
		priceCeilings: bandCeilings(prices),
	};
}

/** Rankable models scoring at least `floor` on an axis. `scores` is ascending. */
export function countAdmitted(scores: readonly number[], floor: number): number {
	// Binary search for the first score >= floor; everything after it qualifies.
	let lo = 0;
	let hi = scores.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((scores[mid] ?? 0) < floor) lo = mid + 1;
		else hi = mid;
	}
	return scores.length - lo;
}

/**
 * Memoized per snapshot object AND config object. A catalog refresh installs a
 * fresh `CatalogSnapshot`, which misses the cache and recomputes the plan — so
 * the plan tracks availability on exactly the polling interval, with no timer
 * of its own. Keyed by config too so separate routers (and tests) never share.
 */
const planCache = new WeakMap<CatalogSnapshot, WeakMap<RouterConfig, TierPlan>>();

export function tierPlanFor(snapshot: CatalogSnapshot, cfg: RouterConfig): TierPlan {
	let perConfig = planCache.get(snapshot);
	if (perConfig === undefined) {
		perConfig = new WeakMap<RouterConfig, TierPlan>();
		planCache.set(snapshot, perConfig);
	}
	let plan = perConfig.get(cfg);
	if (plan === undefined) {
		plan = computeTierPlan(snapshot.models, cfg);
		perConfig.set(cfg, plan);
	}
	return plan;
}

/**
 * The floor to actually enforce for a tier on an axis. The configured floor
 * stands whenever at least MIN_FLOOR_ADMITS rankable models meet it; only a
 * thin tier is relaxed to the adaptive band, and never tightened.
 */
export function effectiveQualityFloor(
	configured: number,
	tier: Tier,
	axis: QualityAxis,
	plan: TierPlan,
): number {
	if (countAdmitted(plan.scores[axis], configured) >= MIN_FLOOR_ADMITS) return configured;
	const adaptive = plan.floors[axis][tier];
	return Math.min(configured, adaptive);
}

/**
 * The input-price ceiling ($/Mtok) to actually enforce for a tier. When adaptive
 * ceilings are off, this is just the configured value (possibly unset). When on,
 * the catalog-derived band applies, and an explicit config can only tighten it
 * further — never loosen it. Returns undefined for "no ceiling".
 */
export function effectivePriceCeiling(
	configured: number | undefined,
	tier: Tier,
	plan: TierPlan,
	enabled: boolean,
): number | undefined {
	if (!enabled) return configured;
	const adaptive = plan.priceCeilings[tier];
	const band = Number.isFinite(adaptive) ? adaptive : undefined;
	if (configured === undefined) return band;
	if (band === undefined) return configured;
	return Math.min(configured, band);
}
