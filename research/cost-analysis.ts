/**
 * Where the money actually goes, from the live ledger. Read-only.
 *
 * Reframes optimization around the finding that ~96% of spend is the PROMPT,
 * not the model's output: decomposes spend by cost component, measures the
 * realized cache hit rate, and LOCALIZES cache misses to their cause (model
 * switching, warm-window expiry, first-turns, exploration). Also quantifies
 * abandoned-attempt waste and whether the LLM adjudicator ever fires.
 *
 *   bun run research/cost-analysis.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";

// Force PRODUCTION home; the fork's .env points it at research-data/home.
process.env.AUTO_MODEL_ROUTER_HOME = join(homedir(), ".auto-model-router");

import { Database } from "bun:sqlite";
import { loadConfig } from "../src/config/load.ts";

const cfg = loadConfig({});
const db = new Database(cfg.ledger.path, { readonly: true });

function rows(sql: string): Record<string, unknown>[] {
	return db.query(sql).all() as Record<string, unknown>[];
}
function table(title: string, data: Record<string, unknown>[]): void {
	console.log(`\n=== ${title} ===`);
	if (data.length === 0) {
		console.log("  (no rows)");
		return;
	}
	const cols = Object.keys(data[0]!);
	const w = cols.map((c) => Math.max(c.length, ...data.map((r) => String(r[c] ?? "").length)));
	console.log("  " + cols.map((c, i) => c.padEnd(w[i]!)).join("  "));
	for (const r of data) console.log("  " + cols.map((c, i) => String(r[c] ?? "").padEnd(w[i]!)).join("  "));
}

const usd = "json_extract(cost_breakdown,'$.%s')";
const comp = (k: string) => usd.replace("%s", k);

// 1. Spend by cost component.
table("spend by component (USD)", rows(`
	SELECT
		round(sum(${comp("freshPrompt")}),2) AS fresh_in,
		round(sum(${comp("cacheRead")}),2)   AS cache_read,
		round(sum(${comp("cacheWrite")}),2)  AS cache_write,
		round(sum(${comp("completion")}),2)  AS completion,
		round(sum(${comp("reasoning")}),2)   AS reasoning,
		round(sum(reported_usd),2)           AS total
	FROM ledger WHERE cost_breakdown IS NOT NULL`));

// 2. Token totals + input:output ratio + overall cache hit rate.
table("tokens", rows(`
	SELECT
		sum(json_extract(usage,'$.promptTokens'))     AS prompt_toks,
		sum(json_extract(usage,'$.completionTokens'))  AS completion_toks,
		round(sum(json_extract(usage,'$.promptTokens'))*1.0/max(1,sum(json_extract(usage,'$.completionTokens'))),0) AS in_out_ratio,
		round(sum(json_extract(usage,'$.cachedTokens'))*1.0/max(1,sum(json_extract(usage,'$.promptTokens'))),3) AS cache_hit_rate
	FROM ledger WHERE usage IS NOT NULL`));

// 3. Cache hit rate + spend by tier.
table("by tier", rows(`
	SELECT tier,
		count(*) AS n,
		round(sum(reported_usd),2) AS usd,
		round(avg(reported_usd),5) AS per_turn,
		round(sum(json_extract(usage,'$.cachedTokens'))*1.0/max(1,sum(json_extract(usage,'$.promptTokens'))),3) AS cache_hit
	FROM ledger WHERE usage IS NOT NULL GROUP BY tier ORDER BY usd DESC`));

// Per-turn view: first attempt only, with previous turn's model + timestamp.
const SEQ = `
	WITH seq AS (
		SELECT conversation_key, tier, served_slug, created_at_ms, reported_usd, usage, cost_breakdown, explored_from,
			LAG(served_slug)  OVER w AS prev_slug,
			LAG(created_at_ms) OVER w AS prev_ms,
			ROW_NUMBER()       OVER w AS rn
		FROM ledger
		WHERE served_slug IS NOT NULL AND reported_usd IS NOT NULL AND attempt = 0
		WINDOW w AS (PARTITION BY conversation_key ORDER BY turn, created_at_ms)
	)`;

// 4. Cache misses localized to model switching (continuation turns only).
table("switch effect (continuation turns)", rows(`${SEQ}
	SELECT
		CASE WHEN served_slug = prev_slug THEN 'stayed' ELSE 'switched' END AS kind,
		count(*) AS n,
		round(sum(reported_usd),2) AS usd,
		round(sum(json_extract(usage,'$.cachedTokens'))*1.0/max(1,sum(json_extract(usage,'$.promptTokens'))),3) AS cache_hit,
		round(sum(${comp("cacheWrite")}),2) AS cache_write
	FROM seq WHERE rn > 1 GROUP BY kind`));

// 5. Cache misses localized to warm-window expiry (continuation turns only).
const ttlMin = Math.round(cfg.hysteresis.cacheWarmTtlMs / 60000);
table(`gap effect (warm window = ${ttlMin} min)`, rows(`${SEQ}
	SELECT
		CASE WHEN (created_at_ms - prev_ms) < ${cfg.hysteresis.cacheWarmTtlMs} THEN 'within_window' ELSE 'expired' END AS gap,
		count(*) AS n,
		round(sum(json_extract(usage,'$.cachedTokens'))*1.0/max(1,sum(json_extract(usage,'$.promptTokens'))),3) AS cache_hit,
		round(sum(${comp("cacheWrite")}),2) AS cache_write
	FROM seq WHERE rn > 1 GROUP BY gap`));

// 6. First-turn vs continuation cache-write (first turns are unavoidably cold).
table("cache-write: first vs continuation", rows(`${SEQ}
	SELECT
		CASE WHEN rn = 1 THEN 'first_turn' ELSE 'continuation' END AS kind,
		count(*) AS n,
		round(sum(${comp("cacheWrite")}),2) AS cache_write,
		round(sum(${comp("freshPrompt")}),2) AS fresh_in
	FROM seq GROUP BY kind`));

// 7. Exploration's cache cost (stickyPolicy: always forfeits warm cache).
table("exploration effect", rows(`${SEQ}
	SELECT
		CASE WHEN explored_from IS NULL THEN 'normal' ELSE 'explored' END AS kind,
		count(*) AS n,
		round(sum(json_extract(usage,'$.cachedTokens'))*1.0/max(1,sum(json_extract(usage,'$.promptTokens'))),3) AS cache_hit,
		round(sum(${comp("cacheWrite")}),2) AS cache_write
	FROM seq WHERE rn > 1 GROUP BY kind`));

// 8. Abandoned-attempt waste.
table("waste (abandoned escalation attempts)", rows(`
	SELECT
		round(sum(CASE WHEN wasted = 1 THEN reported_usd ELSE 0 END),2) AS wasted_usd,
		sum(CASE WHEN wasted = 1 THEN 1 ELSE 0 END) AS wasted_rows,
		round(sum(reported_usd),2) AS total_usd
	FROM ledger WHERE reported_usd IS NOT NULL`));

// 9. Does the LLM adjudicator ever fire? confidence vs the ambiguity band.
table(`adjudicator (ambiguityThreshold = ${cfg.classifier.ambiguityThreshold})`, rows(`
	SELECT classification_source AS source, count(*) AS n,
		round(avg(confidence),3) AS avg_conf,
		sum(CASE WHEN confidence < ${cfg.classifier.ambiguityThreshold} THEN 1 ELSE 0 END) AS below_thresh
	FROM ledger WHERE confidence IS NOT NULL GROUP BY classification_source`));

// 10. Spend by prompt-size bucket.
table("spend by prompt size", rows(`
	SELECT
		CASE
			WHEN json_extract(usage,'$.promptTokens') < 50000  THEN 'a <50k'
			WHEN json_extract(usage,'$.promptTokens') < 150000 THEN 'b 50-150k'
			WHEN json_extract(usage,'$.promptTokens') < 300000 THEN 'c 150-300k'
			ELSE 'd 300k+' END AS bucket,
		count(*) AS n,
		round(sum(reported_usd),2) AS usd,
		round(avg(reported_usd),5) AS per_turn
	FROM ledger WHERE usage IS NOT NULL GROUP BY bucket ORDER BY bucket`));

db.close();
