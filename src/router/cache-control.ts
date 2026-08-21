/**
 * Cache-breakpoint placement (Anthropic-style `cache_control: ephemeral`;
 * OpenRouter translates these to OpenAI/Google cache primitives, so one
 * mechanism covers every target). Returns message indices to mark.
 */

import type { CatalogModel } from "../catalog/types.ts";
import type { RouterConfig } from "../config/types.ts";
import { priceAt } from "../cost/forecast.ts";
import { estimateTokens } from "../tokens/estimate.ts";
import type { NormMessage, NormRequest } from "../wire/types.ts";

export function planCacheBreakpoints(req: NormRequest, model: CatalogModel, cfg: RouterConfig): number[] {
	if (!cfg.cache.injectBreakpoints) return [];
	const promptTokens = estimateTokens(req.promptBytes, model.tokenizer, null);
	// Small prompts cannot amortize cache-write cost.
	if (promptTokens < cfg.cache.minPromptTokens) return [];
	// A breakpoint on a model with no published cache-read price cannot pay for itself.
	if (priceAt(model, Math.max(1, promptTokens)).cacheRead === undefined) return [];

	const messages = req.messages;
	const picks: number[] = [];

	// 1. End of the last system message: the most stable, usually largest prefix.
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i]?.role;
		if (role === "system" || role === "developer") {
			picks.push(i);
			break;
		}
	}

	// 2. End of the last message before the volatile tail — the newest
	//    user-authored content, or the trailing tool-result run of an agent
	//    loop. Caches everything the model has already seen, leaving only the
	//    fresh tail uncached.
	const tail = messages[messages.length - 1];
	if (tail !== undefined) {
		let pred: (m: NormMessage) => boolean;
		if (tail.role === "user") pred = (m) => m.role === "user";
		else if (tail.role === "tool") pred = (m) => m.role === "tool" || (m.role === "assistant" && m.toolCalls.length > 0);
		// An assistant tail has no fresh human content; the whole history is prefix.
		else pred = () => false;
		let i = messages.length - 1;
		while (i >= 0) {
			const m = messages[i];
			if (m === undefined || !pred(m)) break;
			i--;
		}
		if (i >= 0) picks.push(i);
	}

	// 3. Stable prefix boundary at roughly 75% of history.
	if (messages.length > 1) picks.push(Math.floor((messages.length - 1) * 0.75));

	// Dedupe preserving priority order, cap, return ascending indices.
	const seen = new Set<number>();
	const out: number[] = [];
	for (const i of picks) {
		if (i < 0 || i >= messages.length || seen.has(i)) continue;
		seen.add(i);
		out.push(i);
		if (out.length >= cfg.cache.maxBreakpoints) break;
	}
	return out.sort((a, b) => a - b);
}
