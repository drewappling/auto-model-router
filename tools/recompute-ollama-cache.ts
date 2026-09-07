#!/usr/bin/env bun
/**
 * One-off backfill: re-price historical Ollama ledger rows with the router's
 * cache estimate (`src/cost/cache-estimate.ts`).
 *
 * Rows recorded before the estimate existed booked every prompt token at the
 * full input rate, overstating Ollama spend ~3.7x against ollama.com's meter.
 * This walks each conversation's Ollama rows in order, applies the same rule
 * the live path applies (same model as the previous kept row within
 * `hysteresis.cacheWarmTtlMs` ⇒ the previous prompt is the cached prefix),
 * and rewrites `usage`, `cost_breakdown` and `reported_usd` for rows whose
 * cost the router itself computed (Ollama never reports a cost). Rows that
 * already carry a cache count are left alone, so it is safe to re-run.
 *
 * Usage:
 *   bun tools/recompute-ollama-cache.ts            # dry run: prints the delta
 *   bun tools/recompute-ollama-cache.ts --apply    # backs up router.db, then writes
 */

import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { ollamaRateFor } from "../src/catalog/ollama-prices.ts";
import { loadConfig } from "../src/config/load.ts";
import { estimateUnreportedCache } from "../src/cost/cache-estimate.ts";
import type { UsageCounts } from "../src/cost/types.ts";

const apply = process.argv.includes("--apply");
const cfg = loadConfig({});
const ttl = cfg.hysteresis.cacheWarmTtlMs;

interface Row {
	id: string;
	ck: string;
	t: number;
	latency: number;
	slug: string;
	usage: string;
	reported: number | null;
	wasted: number;
	error: string | null;
}

const db = new Database(cfg.ledger.path);
db.exec("PRAGMA busy_timeout = 5000");
const rows = db
	.query(
		`SELECT id, conversation_key ck, created_at_ms t, latency_ms latency, COALESCE(served_slug, slug) slug, usage, reported_usd reported, wasted, error
		 FROM ledger WHERE COALESCE(served_slug, slug) LIKE 'ollama/%' ORDER BY conversation_key, created_at_ms`,
	)
	.all() as Row[];

let before = 0;
let after = 0;
let changed = 0;
const updates: { id: string; usage: string; breakdown: string; usd: number }[] = [];
let prev: Row | undefined;
let prevPrompt = 0;
for (const r of rows) {
	const usage = JSON.parse(r.usage) as UsageCounts;
	const sameConv = prev !== undefined && prev.ck === r.ck;
	const rate = ollamaRateFor(r.slug.slice("ollama/".length), cfg.ollama.prices);
	before += r.reported ?? 0;
	if (rate === null || r.reported === null || r.error !== null) {
		after += r.reported ?? 0;
		if (r.error === null) {
			prev = r;
			prevPrompt = usage.promptTokens;
		}
		continue;
	}
	const est = estimateUnreportedCache(usage, {
		previousSlug: sameConv ? (prev?.slug ?? null) : null,
		previousPromptTokens: sameConv ? prevPrompt : 0,
		previousAtMs: sameConv ? (prev?.t ?? 0) : 0,
		servedSlug: r.slug,
		nowMs: r.t,
		cacheWarmTtlMs: ttl,
	});
	const input = rate.rate.input / 1e6;
	const cached = (rate.rate.cachedInput ?? rate.rate.input) / 1e6;
	const output = rate.rate.output / 1e6;
	const fresh = Math.max(0, est.promptTokens - est.cachedTokens);
	const breakdown = {
		freshPrompt: fresh * input,
		cacheRead: est.cachedTokens * cached,
		cacheWrite: 0,
		completion: est.completionTokens * output,
		reasoning: 0,
		images: 0,
		request: 0,
		total: 0,
		tierAtPromptTokens: 0,
	};
	breakdown.total = breakdown.freshPrompt + breakdown.cacheRead + breakdown.completion;
	after += breakdown.total;
	if (est.cachedTokens !== usage.cachedTokens) {
		changed++;
		updates.push({ id: r.id, usage: JSON.stringify(est), breakdown: JSON.stringify(breakdown), usd: breakdown.total });
	}
	// The next row's "previous" is this row as dispatched, whether or not it was wasted:
	// a wasted probe still warmed the prefix.
	prev = r;
	prevPrompt = est.promptTokens;
}

console.log(`ollama rows: ${rows.length}, re-priced: ${changed}`);
console.log(`ledger Ollama spend: $${before.toFixed(2)} → $${after.toFixed(2)}`);
if (!apply) {
	console.log("dry run; pass --apply to write (router.db is backed up first)");
	db.close();
	process.exit(0);
}

const backupDir = join(dirname(cfg.ledger.path), "backups");
mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const backup = join(backupDir, `router-pre-ollama-cache-${stamp}.db`);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
copyFileSync(cfg.ledger.path, backup);
console.log(`backup: ${backup}`);

const stmt = db.prepare("UPDATE ledger SET usage = $usage, cost_breakdown = $breakdown, reported_usd = $usd WHERE id = $id");
const tx = db.transaction((list: typeof updates) => {
	for (const u of list) stmt.run({ $usage: u.usage, $breakdown: u.breakdown, $usd: u.usd, $id: u.id });
});
tx(updates);
console.log(`updated ${updates.length} rows`);
db.close();
