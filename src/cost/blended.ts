/**
 * Blended rate: the spend-weighted average price per million tokens, over a
 * rolling window, that omp displays as "what tokens cost through this router".
 *
 * The ledger stores each entry's REPORTED total and the component split its
 * own model pricing implies (`cost_breakdown`). OpenRouter gives us no
 * per-component reported prices, so each entry's reported dollars are
 * apportioned across buckets in proportion to its predicted component split —
 * exact when our pricing matches theirs, and self-correcting via the reported
 * total when it does not.
 */

import type { Database } from "bun:sqlite";
import type { RouterConfig } from "../config/types.ts";
import type { BlendedRate, CostBreakdown, UsageCounts } from "./types.ts";

interface BlendRow {
	usage: string;
	reported_usd: number;
	cost_breakdown: string;
}

// Buckets with no window traffic still need a rate for the display; these are
// the typical Anthropic-style relative prices, used only as display priors.
const OUTPUT_TO_INPUT_PRIOR = 5;
const CACHE_READ_TO_INPUT_PRIOR = 0.1;
const CACHE_WRITE_TO_INPUT_PRIOR = 1.25;

export function computeBlendedRate(db: Database, cfg: RouterConfig, windowDays: number): BlendedRate | null {
	const sinceMs = Date.now() - windowDays * 86_400_000;
	// We own the schema; row shape fixed by util/sqlite.ts and cost/ledger.ts.
	const rows = db
		.query(
			`SELECT usage, reported_usd, cost_breakdown FROM ledger
			 WHERE created_at_ms >= ? AND reported_usd IS NOT NULL AND cost_breakdown IS NOT NULL`,
		)
		.all(sinceMs) as BlendRow[];

	let sampleCount = 0;
	let inputUsd = 0;
	let inputTokens = 0;
	let outputUsd = 0;
	let outputTokens = 0;
	let cacheReadUsd = 0;
	let cacheReadTokens = 0;
	let cacheWriteUsd = 0;
	let cacheWriteTokens = 0;

	for (const row of rows) {
		const usage = JSON.parse(row.usage) as UsageCounts;
		const split = JSON.parse(row.cost_breakdown) as CostBreakdown;
		const tokenSplit = split.freshPrompt + split.cacheRead + split.cacheWrite + split.completion + split.reasoning;
		// Entries whose usage produced no token-billed cost (pure image/request
		// billing) carry no price signal per token; skip them.
		if (tokenSplit <= 0) continue;
		const freshTokens = Math.max(usage.promptTokens - usage.cachedTokens - usage.cacheWriteTokens, 0);

		inputUsd += (row.reported_usd * split.freshPrompt) / tokenSplit;
		inputTokens += freshTokens;
		outputUsd += (row.reported_usd * (split.completion + split.reasoning)) / tokenSplit;
		outputTokens += usage.completionTokens;
		cacheReadUsd += (row.reported_usd * split.cacheRead) / tokenSplit;
		cacheReadTokens += usage.cachedTokens;
		cacheWriteUsd += (row.reported_usd * split.cacheWrite) / tokenSplit;
		cacheWriteTokens += usage.cacheWriteTokens;
		sampleCount += 1;
	}

	if (sampleCount < cfg.ledger.blendMinSamples) return null;

	const inputPerMtok = inputTokens > 0 ? (inputUsd / inputTokens) * 1e6 : 0;
	return {
		inputPerMtok,
		outputPerMtok: outputTokens > 0 ? (outputUsd / outputTokens) * 1e6 : inputPerMtok * OUTPUT_TO_INPUT_PRIOR,
		cacheReadPerMtok: cacheReadTokens > 0 ? (cacheReadUsd / cacheReadTokens) * 1e6 : inputPerMtok * CACHE_READ_TO_INPUT_PRIOR,
		cacheWritePerMtok: cacheWriteTokens > 0 ? (cacheWriteUsd / cacheWriteTokens) * 1e6 : inputPerMtok * CACHE_WRITE_TO_INPUT_PRIOR,
		sampleCount,
		windowDays,
	};
}
