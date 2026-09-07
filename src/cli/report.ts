/**
 * `auto-model-router report`: usage analytics over the ledger — which
 * providers and models were routed, what they cost, how fast they were, how
 * much of the prompt was served from cache, and the tier mix. The same
 * aggregation backs `GET /v1/router/report` and omp's `/router report`.
 */

import { existsSync } from "node:fs";
import { loadConfig } from "../config/load.ts";
import { createCatalog } from "../catalog/openrouter-catalog.ts";
import { baselinePrices, buildUsageReport, renderUsageReport } from "../cost/report.ts";
import { openDb } from "../util/sqlite.ts";
import { configOpts, flagInt, flagString, type CliArgs } from "./args.ts";

export async function reportCommand(args: CliArgs): Promise<void> {
	const days = flagInt(args, "days") ?? 7;
	const harnessId = flagString(args, "harness") ?? "";
	const cfg = loadConfig(configOpts(args));

	// Looking must not create the ledger file.
	if (!existsSync(cfg.ledger.path)) {
		if (args.flags.has("json")) {
			console.log(JSON.stringify({ windowDays: days, harnessId, totals: null, providers: [], models: [], tiers: [], days: [] }, null, 2));
		} else {
			console.log(`no ledger at ${cfg.ledger.path} yet`);
		}
		return;
	}

	const db = openDb(cfg.ledger.path);
	try {
		// Baseline prices from the cached catalog: no network for a report.
		const dead = { dispatch: () => Promise.reject(new Error("offline")), complete: () => Promise.reject(new Error("offline")), fetchModels: () => Promise.reject(new Error("offline")), fetchModelsForUser: () => Promise.reject(new Error("offline")) };
		const snapshot = createCatalog(cfg, dead, db).peek();
		const baselines = baselinePrices(cfg.report.baselines, (s) => snapshot?.models.find((m) => m.slug === s));
		const report = buildUsageReport(db, { windowDays: days, harnessId, baselines });
		if (args.flags.has("json")) console.log(JSON.stringify(report, null, 2));
		else console.log(renderUsageReport(report));
	} finally {
		db.close();
	}
}
