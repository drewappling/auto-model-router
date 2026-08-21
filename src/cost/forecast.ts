/**
 * Cost arithmetic. This is the only place token counts become dollars, so
 * the billing subtleties live here exactly once:
 *
 *  - `usage.promptTokens` INCLUDES cached tokens (OpenAI/OpenRouter
 *    convention), so fresh tokens are what remains after subtracting cache
 *    reads and writes.
 *  - `usage.reasoningTokens` is a SUBSET of `completionTokens`; billing both
 *    at full rate would double-count. When the model publishes no separate
 *    reasoning rate, completion swallows reasoning at the completion price.
 */

import type { CatalogModel, Price } from "../catalog/types.ts";
import type { CostBreakdown, CostForecast, UsageCounts } from "./types.ts";

/** Highest override tier applicable at this prompt size; base price below every threshold. */
export function priceAt(model: CatalogModel, promptTokens: number): Price {
	// priceTiers is sorted ascending by minPromptTokens, so the last match wins.
	let price = model.price;
	for (const tier of model.priceTiers) {
		if (tier.minPromptTokens <= promptTokens) price = tier.price;
	}
	return price;
}

function tierThresholdAt(model: CatalogModel, promptTokens: number): number {
	let threshold = 0;
	for (const tier of model.priceTiers) {
		if (tier.minPromptTokens <= promptTokens) threshold = tier.minPromptTokens;
	}
	return threshold;
}

function clampCount(value: number, max: number): number {
	return Math.min(Math.max(value, 0), max);
}

export function computeCost(model: CatalogModel, usage: UsageCounts): CostBreakdown {
	const price = priceAt(model, usage.promptTokens);

	const cachedTokens = clampCount(usage.cachedTokens, usage.promptTokens);
	const cacheWriteTokens = clampCount(usage.cacheWriteTokens, usage.promptTokens - cachedTokens);
	const freshTokens = Math.max(usage.promptTokens - cachedTokens - cacheWriteTokens, 0);
	const reasoningTokens = clampCount(usage.reasoningTokens, usage.completionTokens);

	const freshPrompt = freshTokens * price.prompt;
	// Unpublished cache rates fall back to the full prompt price: absence of a
	// published discount must never become a predicted discount.
	const cacheRead = cachedTokens * (price.cacheRead ?? price.prompt);
	const cacheWrite = cacheWriteTokens * (price.cacheWrite ?? price.prompt);

	let completion: number;
	let reasoning: number;
	if (price.reasoning !== undefined) {
		reasoning = reasoningTokens * price.reasoning;
		completion = (usage.completionTokens - reasoningTokens) * price.completion;
	} else {
		reasoning = 0;
		completion = usage.completionTokens * price.completion;
	}

	const images = usage.images * (price.image ?? 0);
	const request = price.request ?? 0;

	return {
		freshPrompt,
		cacheRead,
		cacheWrite,
		completion,
		reasoning,
		images,
		request,
		total: freshPrompt + cacheRead + cacheWrite + completion + reasoning + images + request,
		tierAtPromptTokens: tierThresholdAt(model, usage.promptTokens),
	};
}

export function forecast(
	model: CatalogModel,
	args: { promptTokens: number; completionTokens: number; cacheHitRate: number; images: number },
): CostForecast {
	const cacheHitRate = Math.min(Math.max(args.cacheHitRate, 0), 1);
	const usage: UsageCounts = {
		promptTokens: args.promptTokens,
		cachedTokens: Math.round(args.promptTokens * cacheHitRate),
		cacheWriteTokens: 0,
		completionTokens: args.completionTokens,
		reasoningTokens: 0,
		images: args.images,
	};
	const breakdown = computeCost(model, usage);

	// The worst case a budget guard must survive is a completely cold cache.
	// That is the MAX of two computations: no cache activity at all, and a
	// full first-time cache write. Taking the write case alone would understate
	// models (several Geminis) whose published cache-write rate is BELOW their
	// prompt rate; taking the no-cache case alone would understate Anthropic-
	// style models whose write rate is a premium over prompt.
	const coldNoCache = computeCost(model, {
		promptTokens: args.promptTokens,
		cachedTokens: 0,
		cacheWriteTokens: 0,
		completionTokens: args.completionTokens,
		reasoningTokens: 0,
		images: args.images,
	});
	let coldUsd = coldNoCache.total;
	if (priceAt(model, args.promptTokens).cacheWrite !== undefined) {
		const coldFullWrite = computeCost(model, {
			promptTokens: args.promptTokens,
			cachedTokens: 0,
			cacheWriteTokens: args.promptTokens,
			completionTokens: args.completionTokens,
			reasoningTokens: 0,
			images: args.images,
		});
		coldUsd = Math.max(coldUsd, coldFullWrite.total);
	}

	return {
		slug: model.slug,
		expectedUsd: breakdown.total,
		coldUsd,
		breakdown,
		assumedPromptTokens: args.promptTokens,
		assumedCompletionTokens: args.completionTokens,
		assumedCacheHitRate: cacheHitRate,
	};
}
