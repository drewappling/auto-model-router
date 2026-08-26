/**
 * Read-only analysis of a ledger snapshot.
 *
 * Answers the questions that decide whether a learned classifier is worth
 * building at all: does the adjudicator ever actually run, how are tiers
 * distributed, and how much label signal (escalations) exists.
 *
 * Usage: bun run research/analyze-ledger.ts [path-to-snapshot.db]
 */

import { Database } from "bun:sqlite";

const path = process.argv[2] ?? "research-data/snapshot.db";
const db = new Database(path, { readonly: true });

function section(label: string, sql: string): void {
	console.log(`\n=== ${label} ===`);
	try {
		const rows = db.query(sql).all() as Record<string, unknown>[];
		if (rows.length === 0) {
			console.log("  (no rows)");
			return;
		}
		for (const r of rows) {
			console.log("  " + Object.entries(r).map(([k, v]) => `${k}=${v}`).join("  "));
		}
	} catch (err) {
		console.log("  ERROR: " + (err instanceof Error ? err.message : String(err)));
	}
}

section(
	"tier distribution",
	`SELECT tier, COUNT(*) n, ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM ledger), 1) pct
	 FROM ledger GROUP BY tier ORDER BY n DESC`,
);

section(
	"classification source",
	`SELECT classification_source src, COUNT(*) n,
	        ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM ledger), 1) pct
	 FROM ledger GROUP BY src ORDER BY n DESC`,
);

section(
	"adjudicator activity (from reasons text)",
	`SELECT
	   SUM(CASE WHEN reasons LIKE '%adjudicator skipped%' THEN 1 ELSE 0 END) AS skipped_cost_guard,
	   SUM(CASE WHEN reasons LIKE '%adjudicator failed%'  THEN 1 ELSE 0 END) AS failed,
	   SUM(CASE WHEN reasons LIKE '%not a tier word%'     THEN 1 ELSE 0 END) AS bad_reply,
	   SUM(CASE WHEN reasons LIKE '%adjudicator:%'        THEN 1 ELSE 0 END) AS verdict_used,
	   COUNT(*) AS total_turns
	 FROM ledger`,
);

section(
	"escalation signals",
	`SELECT COALESCE(escalation_signal, '(none)') signal, COUNT(*) n
	 FROM ledger GROUP BY signal ORDER BY n DESC`,
);

section(
	"spend and waste",
	`SELECT SUM(wasted) wasted_turns,
	        ROUND(SUM(COALESCE(reported_usd, predicted_usd)), 4) total_usd,
	        ROUND(SUM(CASE WHEN wasted = 1 THEN COALESCE(reported_usd, predicted_usd) ELSE 0 END), 4) wasted_usd
	 FROM ledger`,
);

section(
	"spend by served model",
	`SELECT COALESCE(served_slug, slug) model, COUNT(*) n,
	        ROUND(SUM(COALESCE(reported_usd, predicted_usd)), 4) usd
	 FROM ledger GROUP BY model ORDER BY usd DESC LIMIT 10`,
);

section(
	"error kinds",
	`SELECT COALESCE(error_kind, '(none)') kind, COUNT(*) n
	 FROM ledger GROUP BY kind ORDER BY n DESC`,
);

db.close();
