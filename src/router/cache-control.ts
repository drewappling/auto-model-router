/**
 * Cache-breakpoint placement (Anthropic-style `cache_control: ephemeral`;
 * OpenRouter translates these to OpenAI/Google cache primitives, so one
 * mechanism covers every target). Returns message indices to mark.
 *
 * Placement is chosen for REUSE ACROSS TURNS, not for a single request. A
 * breakpoint only pays off when a LATER turn asks to read the exact same byte
 * prefix, so every boundary here must be one the next turn will reproduce:
 *
 *  - the system prefix, which never moves;
 *  - byte MILESTONES at fixed multiples of `cache.milestoneTokens`, which land
 *    on the same message every turn for as long as the prefix is unchanged
 *    (a boundary at "roughly 75% of history" drifts with every appended
 *    message, so it writes a fresh entry each turn and never reads one);
 *  - the tail, so the whole of this turn's prompt becomes the entry the NEXT
 *    turn reads. A conversation is append-only: nothing already in the array
 *    can change later, so there is no "volatile tail" to keep out of the
 *    cache. Walking back over an agent loop's trailing tool run instead left
 *    everything the loop had accumulated permanently uncached.
 *
 * Milestones are measured over POST-compaction sizes, so the boundaries match
 * the bytes actually dispatched.
 */

import type { CatalogModel } from "../catalog/types.ts";
import type { RouterConfig } from "../config/types.ts";
import { priceAt } from "../cost/forecast.ts";
import { estimateTokens } from "../tokens/estimate.ts";
import type { CompactionEdit, NormRequest } from "../wire/types.ts";
import { compactedBytes } from "./compaction.ts";

export function planCacheBreakpoints(
	req: NormRequest,
	model: CatalogModel,
	cfg: RouterConfig,
	compactionPlan: readonly CompactionEdit[] = [],
): number[] {
	if (!cfg.cache.injectBreakpoints) return [];
	const promptTokens = estimateTokens(req.promptBytes, model.tokenizer, null);
	// Small prompts cannot amortize cache-write cost.
	if (promptTokens < cfg.cache.minPromptTokens) return [];
	// A breakpoint on a model with no published cache-read price cannot pay for itself.
	if (priceAt(model, Math.max(1, promptTokens)).cacheRead === undefined) return [];

	const messages = req.messages;
	if (messages.length === 0) return [];

	const picks: number[] = [];

	// 1. End of the last system message: the most stable, usually largest prefix.
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i]?.role;
		if (role === "system" || role === "developer") {
			picks.push(i);
			break;
		}
	}

	// 2. The tail: everything this turn sent, cached for the next turn to read.
	picks.push(messages.length - 1);

	// 3. Stable byte milestones through the history, newest first so the slots
	//    left over by 1 and 2 cover the largest readable prefixes.
	const editByIndex = new Map<number, CompactionEdit>();
	for (const e of compactionPlan) editByIndex.set(e.index, e);
	const bytesPerToken = req.promptBytes / Math.max(1, promptTokens);
	const milestoneBytes = Math.max(1, Math.floor(cfg.cache.milestoneTokens * bytesPerToken));
	const milestones: number[] = [];
	let cumulative = 0;
	let nextMilestone = milestoneBytes;
	for (let i = 0; i < messages.length - 1; i++) {
		const m = messages[i];
		if (m === undefined) continue;
		cumulative += compactedBytes(m.textBytes, editByIndex.get(i));
		if (cumulative >= nextMilestone) {
			milestones.push(i);
			// Skip past every milestone this message already crossed, so one huge
			// message cannot claim a run of adjacent boundaries.
			while (cumulative >= nextMilestone) nextMilestone += milestoneBytes;
		}
	}
	for (let i = milestones.length - 1; i >= 0; i--) {
		const idx = milestones[i];
		if (idx !== undefined) picks.push(idx);
	}

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
