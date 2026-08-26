/**
 * Projects how many exploration samples a given set of rates would actually
 * yield, from a ledger snapshot of real traffic.
 *
 * Choosing exploration rates blind is how you end up spending a month
 * sampling the cheapest boundary in the system. This answers the only
 * question that matters up front: at these rates, how many turns of each
 * tier do I get, and how long until there are enough to fit on?
 *
 * Cache-coldness is approximated by the gap to the previous turn in the same
 * conversation: if more than `cacheWarmTtlMs` elapsed, the prompt cache would
 * have expired, which is what makes a hysteresis-held turn explorable.
 *
 * Usage: bun run research/project-yield.ts [snapshot.db]
 */

import { Database } from "bun:sqlite";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { Tier } from "../src/router/types.ts";

const path = process.argv[2] ?? "research-data/snapshot.db";
const db = new Database(path, { readonly: true });

const TTL = DEFAULT_CONFIG.hysteresis.cacheWarmTtlMs;
const RATES = DEFAULT_CONFIG.exploration.rates;

interface Row {
	tier: Tier;
	total: number;
	old_eligible: number;
	new_eligible: number;
	spend: number;
}

const rows = db
	.query(
		`WITH t AS (
			SELECT tier, classification_source AS src,
			       COALESCE(reported_usd, predicted_usd) AS usd,
			       created_at_ms - LAG(created_at_ms) OVER (
			           PARTITION BY conversation_key ORDER BY created_at_ms
			       ) AS gap
			FROM ledger
		)
		SELECT tier,
		       COUNT(*) AS total,
		       ROUND(SUM(usd), 2) AS spend,
		       SUM(CASE WHEN src = 'heuristic' THEN 1 ELSE 0 END) AS old_eligible,
		       SUM(CASE WHEN src = 'heuristic'
		                  OR (src = 'sticky' AND (gap IS NULL OR gap > ${TTL}))
		                THEN 1 ELSE 0 END) AS new_eligible
		FROM t
		WHERE tier IN ('simple', 'moderate', 'hard')
		GROUP BY tier`,
	)
	.all() as unknown as Row[];

const { days } = db.query("SELECT (MAX(created_at_ms) - MIN(created_at_ms)) / 86400000.0 AS days FROM ledger").get() as {
	days: number;
};

const order: Tier[] = ["hard", "moderate", "simple"];
const byTier = new Map(rows.map((r) => [r.tier, r]));

console.log(`window: ${days.toFixed(2)} days\n`);
console.log("tier        spend   turns   elig(sticky-excl)  elig(cold-ok)   rate   /day    2wk    4wk");

let oldPerDay = 0;
let newPerDay = 0;
for (const tier of order) {
	const r = byTier.get(tier);
	if (r === undefined) continue;
	const rate = RATES[tier] ?? 0;
	const perDay = (r.new_eligible / days) * rate;
	oldPerDay += (r.old_eligible / days) * rate;
	newPerDay += perDay;
	console.log(
		"  " +
			tier.padEnd(10) +
			("$" + r.spend).padStart(6) +
			String(r.total).padStart(8) +
			String(r.old_eligible).padStart(19) +
			String(r.new_eligible).padStart(15) +
			String(rate).padStart(7) +
			perDay.toFixed(1).padStart(7) +
			(perDay * 14).toFixed(0).padStart(7) +
			(perDay * 28).toFixed(0).padStart(7),
	);
}

console.log("");
console.log(`total explored/day  sticky-excluded ${oldPerDay.toFixed(1)}  ->  cold-cache allowed ${newPerDay.toFixed(1)}`);
console.log(`over 4 weeks        sticky-excluded ${(oldPerDay * 28).toFixed(0)}  ->  cold-cache allowed ${(newPerDay * 28).toFixed(0)}`);

db.close();
