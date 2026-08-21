import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { loadConfig } from "../config/load.ts";
import { createLedger } from "../cost/ledger.ts";
import { computeStats, type RouterStats } from "../server/http.ts";
import { openDb } from "../util/sqlite.ts";
import { configOpts, flagInt, type CliArgs } from "./args.ts";

function usd(v: number): string {
	return `$${v.toFixed(4)}`;
}

function renderStats(stats: RouterStats): void {
	const windowLabel = stats.windowDays === null ? "all time" : `last ${stats.windowDays}d`;
	console.log(`window: ${windowLabel}   requests: ${stats.requests}   escalations: ${stats.escalations} (${(stats.escalationRate * 100).toFixed(1)}%)`);
	console.log(`spend: window ${usd(stats.windowSpendUsd)}   today ${usd(stats.spendTodayUsd)}   7d ${usd(stats.spend7dUsd)}   all-time ${usd(stats.spendAllTimeUsd)}`);
	console.log(
		`predicted-vs-reported drift: ${stats.meanPredictionError === null ? "n/a (no reported costs yet)" : `${(stats.meanPredictionError * 100).toFixed(1)}% mean relative error`}`,
	);
	console.log("");

	const slugWidth = Math.max(5, ...stats.perModel.map((r) => r.slug.length));
	console.log(`${"model".padEnd(slugWidth)}  ${"req".padStart(5)}  ${"spend".padStart(9)}  ${"share".padStart(6)}`);
	console.log(`${"-".repeat(slugWidth)}  ${"-".repeat(5)}  ${"-".repeat(9)}  ${"-".repeat(6)}`);
	if (stats.perModel.length === 0) {
		console.log("(no ledger entries in this window)");
		return;
	}
	for (const r of stats.perModel) {
		console.log(
			`${r.slug.padEnd(slugWidth)}  ${String(r.requests).padStart(5)}  ${usd(r.spendUsd).padStart(9)}  ${(r.share * 100).toFixed(1).padStart(5)}%`,
		);
	}
}

export async function statsCommand(args: CliArgs): Promise<void> {
	const days = flagInt(args, "days") ?? 7;
	const cfg = loadConfig(configOpts(args));

	// A stats query must not create the ledger file just by looking.
	let db: Database | null = null;
	let stats: RouterStats;
	if (existsSync(cfg.ledger.path)) {
		db = openDb(cfg.ledger.path);
		stats = computeStats(createLedger(db, cfg), { windowDays: days });
	} else {
		stats = {
			generatedAtMs: Date.now(),
			windowDays: days,
			spendTodayUsd: 0,
			spend7dUsd: 0,
			spendAllTimeUsd: 0,
			windowSpendUsd: 0,
			requests: 0,
			escalations: 0,
			escalationRate: 0,
			meanPredictionError: null,
			perModel: [],
			trust: [],
		};
	}

	try {
		if (args.flags.has("json")) console.log(JSON.stringify(stats, null, 2));
		else renderStats(stats);
	} finally {
		db?.close();
	}
}
