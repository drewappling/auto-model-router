#!/usr/bin/env bun
/**
 * Regenerates the `ledgerSnapshot` section of `site/data/benchmarks.json` from a
 * real install's ledger, so the published site can show live routing economics
 * instead of only the authored head-to-head suites.
 *
 * It reuses `computeStats` \u2014 the exact aggregation behind the `stats` command
 * and the `/stats` endpoint \u2014 so the site can never drift from what the tool
 * reports. The authored `suites` block is preserved untouched; only
 * `ledgerSnapshot` is rewritten.
 *
 * Intended to run at release time, on the machine that holds the live ledger,
 * and to commit the refreshed JSON alongside the version bump. When no ledger
 * exists the snapshot is set to null and the site renders a "no snapshot"
 * placeholder rather than fabricating numbers.
 *
 *   bun tools/export-benchmarks.ts               # all-time snapshot
 *   bun tools/export-benchmarks.ts --days 7       # last 7 days
 *   bun tools/export-benchmarks.ts --db path.db   # a specific ledger
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config/load.ts";
import { createLedger } from "../src/cost/ledger.ts";
import { computeStats } from "../src/server/http.ts";
import { openDb } from "../src/util/sqlite.ts";

const ROOT = resolve(import.meta.dir, "..");
const DATA_PATH = join(ROOT, "site", "data", "benchmarks.json");

function parseDays(argv: string[]): number | undefined {
	const i = argv.indexOf("--days");
	if (i === -1) return undefined;
	const n = Number(argv[i + 1]);
	if (!Number.isFinite(n) || n <= 0) throw new Error(`--days needs a positive number, got ${argv[i + 1]}`);
	return n;
}

function parseDb(argv: string[]): string | undefined {
	const i = argv.indexOf("--db");
	return i === -1 ? undefined : argv[i + 1];
}

const argv = process.argv.slice(2);
const days = parseDays(argv);
const cfg = loadConfig({});
const dbPath = parseDb(argv) ?? cfg.ledger.path;

const data = JSON.parse(readFileSync(DATA_PATH, "utf8")) as Record<string, unknown>;

if (!existsSync(dbPath)) {
	console.error(`no ledger at ${dbPath}; setting ledgerSnapshot to null`);
	data.ledgerSnapshot = null;
	writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	process.exit(0);
}

const db = openDb(dbPath);
try {
	const stats = computeStats(createLedger(db, cfg), days === undefined ? {} : { windowDays: days });
	const perTurnUsd = stats.requests > 0 ? stats.windowSpendUsd / stats.requests : 0;
	data.ledgerSnapshot = {
		generatedAt: new Date(stats.generatedAtMs).toISOString().slice(0, 10),
		windowDays: stats.windowDays,
		requests: stats.requests,
		spendAllTimeUsd: Number(stats.spendAllTimeUsd.toFixed(2)),
		spend7dUsd: Number(stats.spend7dUsd.toFixed(2)),
		perTurnUsd: Number(perTurnUsd.toFixed(4)),
		escalationRatePct: Number((stats.escalationRate * 100).toFixed(1)),
		// Top models by spend share; the long tail adds noise, not signal.
		perModel: stats.perModel.slice(0, 8).map((m) => ({
			slug: m.slug,
			requests: m.requests,
			sharePct: Number((m.share * 100).toFixed(1)),
		})),
	};
	writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	console.log(`ledgerSnapshot \u2190 ${stats.requests} turns from ${dbPath} (${stats.windowDays === null ? "all time" : `${stats.windowDays}d`})`);
} finally {
	db.close();
}
