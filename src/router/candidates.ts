/**
 * Candidate construction: hard capability filters over the catalog, then
 * forecast + scoring for the survivors. The `rejected` array is what
 * `omp-router explain` shows, so every drop records its precise reason.
 */

import type { CatalogModel, CatalogSnapshot } from "../catalog/types.ts";
import type { QualityAxis, RouterConfig } from "../config/types.ts";
import { forecast, priceAt } from "../cost/forecast.ts";
import type { Ledger } from "../cost/types.ts";
import type { NormRequest } from "../wire/types.ts";
import type { Candidate, Features, Rejection, Tier } from "./types.ts";

export interface BuildCandidatesArgs {
	req: NormRequest;
	features: Features;
	tier: Tier;
	axis: QualityAxis;
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

export function buildCandidates(args: BuildCandidatesArgs): { candidates: Candidate[]; rejected: Rejection[] } {
	const { req, features, tier, axis, snapshot, ledger, cfg, expectedCompletionTokens, warmSlug, relaxLevel = 0 } = args;
	const tierCfg = cfg.tiers[tier];
	const filters = cfg.filters;
	const relaxPrice = relaxLevel >= 1;
	const relaxQuality = relaxLevel >= 2;
	const relaxTrust = relaxLevel >= 3;
	const allowRes = filters.allow.map(globToRe);
	const denyRes = filters.deny.map(globToRe);
	const needTools = req.tools.length > 0 && filters.requireToolSupport;
	const minContext = Math.ceil(features.promptTokens * filters.contextHeadroom) + expectedCompletionTokens;
	let images = 0;
	if (req.hasImages) for (const m of req.messages) images += m.images;

	const candidates: Candidate[] = [];
	const rejected: Rejection[] = [];

	for (const model of snapshot.models) {
		const slug = model.slug;

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
		if (req.hasImages && !model.inputModalities.includes("image")) {
			rejected.push({ slug, reason: "no_image_support" });
			continue;
		}
		if (model.contextLength < minContext) {
			rejected.push({ slug, reason: "context_too_small", detail: `window ${model.contextLength} < required ${minContext}` });
			continue;
		}

		const pinned = tierCfg.pin.includes(slug);
		const quality = resolveQuality(model, axis);
		if (!pinned && !relaxQuality && tierCfg.minQuality > 0) {
			if (quality === null) {
				rejected.push({ slug, reason: "below_quality_floor", detail: "no published quality score" });
				continue;
			}
			if (quality.score < tierCfg.minQuality) {
				rejected.push({ slug, reason: "below_quality_floor", detail: `${quality.score} < floor ${tierCfg.minQuality}` });
				continue;
			}
		}

		// Price ceilings at the ACTUAL prompt size: long-context overrides can
		// push a model over the ceiling exactly when conversations get long.
		// Catalog prices are per-token; ceilings are per million tokens.
		const price = priceAt(model, Math.max(1, features.promptTokens));
		if (!relaxPrice && tierCfg.maxInputPerMtok !== undefined && price.prompt * 1e6 > tierCfg.maxInputPerMtok) {
			rejected.push({
				slug,
				reason: "over_price_ceiling",
				detail: `input $${(price.prompt * 1e6).toFixed(2)}/Mtok > ceiling $${tierCfg.maxInputPerMtok}`,
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

		const trust = ledger?.trust(slug) ?? null;
		if (!relaxTrust && trust !== null && trust.attempts >= filters.minTrustSamples && trust.successRate < filters.minTrust) {
			rejected.push({
				slug,
				reason: "untrusted",
				detail: `success ${trust.successRate.toFixed(2)} over ${trust.attempts} attempts < ${filters.minTrust}`,
			});
			continue;
		}

		const fc = forecast(model, {
			promptTokens: features.promptTokens,
			completionTokens: expectedCompletionTokens,
			cacheHitRate: 0,
			images,
		});
		const trustScore = trust !== null && trust.attempts > 0 ? trust.successRate : UNMEASURED_TRUST;
		const qualityScore = quality?.score ?? 0;
		// Shared scoring: trust converts flakiness into money — a model failing
		// 20% of the time really costs ~25% more in retries. qualityExponent 0
		// makes this "cheapest above the floor"; the floor does the quality work.
		const effectiveUsd = fc.expectedUsd / Math.max(trustScore, 0.5);
		const score = Math.pow(qualityScore / 100, tierCfg.qualityExponent) / Math.max(effectiveUsd, 1e-9);

		const reasons: string[] = [
			quality === null
				? "unscored on every quality axis"
				: `quality ${quality.score} on ${quality.axis}${quality.axis === axis ? "" : ` (fallback from ${axis})`}`,
			trust === null || trust.attempts === 0
				? `trust unmeasured: neutral prior ${UNMEASURED_TRUST}`
				: `trust ${trustScore.toFixed(2)} over ${trust.attempts} attempts`,
			`expected $${fc.expectedUsd.toFixed(6)}`,
		];
		if (pinned) reasons.push("pinned into tier");
		candidates.push({ model, forecast: fc, qualityScore, trustScore, score, reasons });
	}

	candidates.sort((a, b) => {
		const d = b.score - a.score;
		if (d !== 0) return d;
		// Ties break toward the model already warm in this conversation, then
		// lexically for determinism.
		if (a.model.slug === warmSlug) return -1;
		if (b.model.slug === warmSlug) return 1;
		return a.model.slug < b.model.slug ? -1 : 1;
	});
	return { candidates, rejected };
}
