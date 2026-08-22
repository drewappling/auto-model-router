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
 * and take each band's lower bound as that tier's adaptive floor. The effective
 * floor is then `min(configured, adaptive)`:
 *
 *  - A healthy catalog keeps the configured floors verbatim (the adaptive floor
 *    sits above them, so `min` picks the configured value) — no behaviour change.
 *  - A narrowed catalog falls back to the adaptive floor, so `hard` still gets
 *    the best quartile of what is available instead of nothing at all.
 *
 * `min` is deliberate: adaptive floors may only RELAX a floor, never tighten
 * one. Tightening would let a rich catalog silently price us out of a tier the
 * operator explicitly configured.
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
	/** Adaptive floor per axis per tier. */
	floors: Record<QualityAxis, AxisFloors>;
	/** How many available models carried a score on each axis. */
	scoredCount: Record<QualityAxis, number>;
}

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

/** Computes the adaptive plan for a set of available models. */
export function computeTierPlan(models: readonly CatalogModel[], cfg: RouterConfig): TierPlan {
	const floors: Record<string, AxisFloors> = {};
	const scoredCount: Record<string, number> = {};
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
	}

	return {
		floors: floors as Record<QualityAxis, AxisFloors>,
		scoredCount: scoredCount as Record<QualityAxis, number>,
	};
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
 * The floor to actually enforce for a tier on an axis. Never tightens the
 * configured floor; only relaxes it when the available catalog cannot meet it.
 */
export function effectiveQualityFloor(
	configured: number,
	tier: Tier,
	axis: QualityAxis,
	plan: TierPlan,
): number {
	const adaptive = plan.floors[axis][tier];
	return Math.min(configured, adaptive);
}
