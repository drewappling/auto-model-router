/**
 * Parity: the one ledger must answer identically on both engines, reading the
 * same production rows.
 *
 * The point is not that the SQL looks portable — it is that trust, latency,
 * spend, blend, escalation cost and every report come out EQUAL, because
 * routing decisions are made from those numbers and a front door may read a
 * SQLite file while the router writes Postgres. Every silent bug found while
 * porting (a `SUM()` read as a string skewing a trust score, a double-encoded
 * JSON column nulling an escalation term, a nested `json_extract` path that
 * SQLite tolerates and Postgres reads as NULL) was caught by comparing
 * computed values rather than by a type error.
 *
 * Usage: bun tools/ledger-parity.ts <sqlite-path> [postgres-url]
 */
import { Database } from "bun:sqlite";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { createSqlLedger } from "../src/cost/ledger-sql.ts";
import { migrateStore } from "../src/util/schema.ts";
import type { AsyncLedger } from "../src/cost/types.ts";
import { openSqlDb, type SqlDb } from "../src/util/sql.ts";
import { decisionEntries, exportRows, feedbackView, spendUsdSince } from "../src/cost/views.ts";
import { buildUsageReport } from "../src/cost/report.ts";
import { buildDailySummary, countTierChanges } from "../src/cost/summary.ts";

const sqlitePath = process.argv[2] ?? "/data/router/router.db";
const pgUrl = process.argv[3] ?? "";

// Windows wide open so every row counts, and the scoped query shapes exercised.
const cfg: RouterConfig = structuredClone(DEFAULT_CONFIG);
cfg.filters.trustWindowDays = 0;
cfg.filters.feedbackWeight = 1;
cfg.filters.cacheReliabilityMinSamples = 1;
cfg.filters.escalationCostWeight = 1;
cfg.filters.latencyMinSamples = 1;

// The source of real rows. Read-only: the harness copies out of it and
// never writes to a live ledger.
const db = new Database(sqlitePath, { readonly: true });

const slugs = (db.query("SELECT DISTINCT slug FROM ledger WHERE slug IS NOT NULL").all() as { slug: string }[]).map((r) => r.slug);
const harnesses = (db.query("SELECT DISTINCT harness_id FROM ledger WHERE harness_id <> '' LIMIT 2").all() as { harness_id: string }[]).map(
	(r) => r.harness_id,
);
const sessions = (
	db.query("SELECT DISTINCT omp_session_id FROM ledger WHERE omp_session_id <> '' LIMIT 2").all() as { omp_session_id: string }[]
).map((r) => r.omp_session_id);

/**
 * Key-order-insensitive comparison. A JSON column round-tripped through
 * Postgres' jsonb comes back with its keys reordered — jsonb does not preserve
 * input order — which is not a difference in the value.
 */
function stable(value: unknown): string {
	return JSON.stringify(value, (_key, v: unknown) =>
		v !== null && typeof v === "object" && !Array.isArray(v)
			? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
			: v,
	);
}

/**
 * Structural comparison with a tolerance on every number, at any depth.
 *
 * Two engines summing the same rows in a different order land a few ULPs apart
 * ($39.722225609861425 against ...56), which is arithmetic, not divergence. A
 * strict compare on a nested total would report that as a mismatch and bury
 * the real ones.
 */
function deepEqual(a: unknown, b: unknown, tol: number): boolean {
	if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= tol * Math.max(1, Math.abs(a));
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return stable(a) === stable(b);
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => deepEqual(v, b[i], tol));
	}
	const ra = a as Record<string, unknown>;
	const rb = b as Record<string, unknown>;
	const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
	for (const key of keys) if (!deepEqual(ra[key], rb[key], tol)) return false;
	return true;
}

let checks = 0;
let bad = 0;
/** Which side is which in a mismatch report; set before each comparison pass. */
let labelA = "a";
let labelB = "b";
function eq(label: string, a: unknown, b: unknown, tol = 1e-9): void {
	checks++;
	const same = deepEqual(a, b, tol);
	if (!same) {
		bad++;
		console.log(`  MISMATCH ${label}\n    ${labelA}=${JSON.stringify(a)}\n    ${labelB}=${JSON.stringify(b)}`);
	}
}

/** Copies the real rows into whichever store the unified ledger will read. */
async function load(target: SqlDb): Promise<void> {
	await migrateStore(target);
	for (const table of ["ledger", "feedback", "token_calibration"]) {
		await target.sql.unsafe(`DELETE FROM ${table}`);
	}
	// The json columns are TEXT in the source; Postgres wants objects, so they
	// are parsed when the destination stores JSONB.
	const jsonCols = new Set(["usage", "cost_breakdown", "features", "classifier_reasons", "reasons"]);
	const copy = async (table: string): Promise<number> => {
		const cols = (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
		const rows = db.query(`SELECT ${cols.join(", ")} FROM ${table}`).all() as Record<string, unknown>[];
		for (let i = 0; i < rows.length; i += 500) {
			const batch = rows.slice(i, i + 500).map((r) => {
				const o: Record<string, unknown> = {};
				for (const c of cols) {
					const v = r[c] ?? null;
					o[c] = target.dialect === "postgres" && jsonCols.has(c) && typeof v === "string" ? JSON.parse(v) : v;
				}
				return o;
			});
			await target.sql`INSERT INTO ${target.sql.unsafe(table)} ${target.sql(batch, ...cols)}`;
		}
		return rows.length;
	};
	const ledgerRows = await copy("ledger");
	// tokenRatio reads this table, so without it the unified side reports null
	// against a real calibrated ratio — another harness-shaped "mismatch".
	await copy("token_calibration");
	let feedbackRows = 0;
	try {
		feedbackRows = await copy("feedback");
	} catch (err) {
		// Never swallowed: a failed feedback copy makes the unified side read no
		// verdicts and shows up as a trust-score "mismatch" that is really a
		// harness bug. It cost a diagnosis once already.
		console.log(`  feedback copy FAILED: ${err instanceof Error ? err.message : String(err)}`);
	}
	console.log(`  loaded ${ledgerRows} ledger rows, ${feedbackRows} feedback rows`);
}

/**
 * Every ported view, as one comparable value. The views moved to the shim in
 * the same change as the ledger, so there is no synchronous version left to
 * diff against — what matters is that the two ENGINES agree, since a front
 * door may read a file while the router writes a database.
 */
async function viewsSnapshot(db: SqlDb): Promise<Record<string, unknown>> {
	const harness = harnesses[0] ?? null;
	// A FIXED instant: the windows are relative to "now", so two engines read a
	// moment apart would legitimately disagree and hide a real difference.
	const nowMs = 1_789_000_000_000;
	const report = await buildUsageReport(db, { windowDays: 3650, nowMs });
	const summary = await buildDailySummary(db, { nowMs });
	return {
		reportTotals: report.totals,
		reportProviders: report.providers.map((r) => [r.key, r.dispatches, Number(r.spendUsd.toFixed(9)), Number(r.cacheHitRate.toFixed(9)), r.escalations, r.errors]),
		reportModels: report.models.map((m) => [m.key, m.provider, m.dispatches, Number(m.spendUsd.toFixed(9)), m.tiers, m.feedback]),
		reportTiers: report.tiers.map((r) => [r.key, r.dispatches, Number(r.spendUsd.toFixed(9))]),
		reportDays: report.days.map((d) => [d.day, d.dispatches, Number(d.spendUsd.toFixed(9)), Number(d.cacheHitRate.toFixed(9))]),
		reportAnatomy: report.anatomy,
		summaryCurrent: summary.current,
		summaryPrevious: summary.previous,
		summaryTopModels: summary.topModels.map((m) => [m.slug, m.dispatches, Number(m.spendUsd.toFixed(9))]),
		tierChanges: await countTierChanges(db, 0, ""),
		spendAll: await spendUsdSince(db, 0, null),
		spendHarness: harness === null ? 0 : await spendUsdSince(db, 0, [harness]),
		spendNone: await spendUsdSince(db, 0, []),
		exportRows: (await exportRows(db, 0, null)).map((r) => [r.day, r.harnessId, r.slug, r.scope, r.dispatches, r.promptTokens, r.cachedTokens, r.completionTokens, Number(r.spendUsd.toFixed(9)), r.escalations, r.errors]),
		feedback: await feedbackView(db, 0, null),
		decisions: (await decisionEntries(db, { sinceMs: 0, harness: null, limit: 25 })).map((e) => [e.id, e.slug, e.servedSlug, e.tier, e.wasted, e.feedback.length, e.costBreakdown?.total ?? null]),
	};
}

/**
 * Every signal the router reads off the ledger, as one comparable value.
 *
 * A FIXED instant throughout: `spendSince` and the spike windows are relative
 * to "now", so two engines read a moment apart would legitimately disagree and
 * hide a real difference.
 */
async function ledgerSnapshot(unified: AsyncLedger): Promise<Record<string, unknown>> {
	const nowMs = 1_789_000_000_000;
	const out: Record<string, unknown> = {};

	for (const days of [0, 1, 7]) {
		const since = days === 0 ? 0 : nowMs - days * 86_400_000;
		out[`spendSince(${days}d)`] = await unified.spendSince(since);
		for (const h of harnesses) out[`spendSince(${days}d,${h})`] = await unified.spendSince(since, h);
	}

	const esc = await unified.escalationCost(cfg.ledger.blendWindowDays);
	out.escalationCost = esc === null ? null : [esc.samples, esc.usdPerPromptToken];
	const blend = await unified.blendedRate(cfg.ledger.blendWindowDays);
	out.blendedRate = blend === null ? null : [blend.sampleCount, blend.inputPerMtok, blend.outputPerMtok, blend.cacheReadPerMtok];

	// The prefetch the turn path actually uses, global and per harness.
	for (const harness of [undefined, ...harnesses]) {
		const tag = harness ?? "global";
		const signals = await unified.signals(slugs, harness);
		for (const slug of slugs) {
			const s = signals.get(slug);
			const trust = s?.trust ?? null;
			const latency = s?.latency ?? null;
			out[`trust[${tag}][${slug}]`] = trust === null
				? null
				: [trust.attempts, trust.escalations, trust.errors, trust.successRate, trust.meanCostError];
			out[`latency[${tag}][${slug}]`] = latency === null ? null : [latency.samples, latency.ttftMs, latency.tokensPerSec];
		}
	}

	// Keyed by slug: row order is not part of the meaning here.
	out.allTrust = Object.fromEntries((await unified.allTrust()).map((t) => [t.slug, [t.attempts, t.successRate]]));
	const cache = await unified.cacheReliability(slugs);
	out.cacheReliability = Object.fromEntries(slugs.map((s) => [s, cache.get(s) === undefined ? null : [cache.get(s)?.samples, cache.get(s)?.hitRate]]));

	for (const prefix of ["ollama/", "deepseek/", "anthropic-subscription/"]) {
		out[`providerSpendSince(${prefix})`] = await unified.providerSpendSince(prefix, 0);
	}

	// Entry round-trip: the JSON columns are where a dialect difference shows.
	out.recentEntries = (await unified.recentEntries(25)).map((e) => [e.id, e.usage, e.reasons, e.costBreakdown ?? null, e.scope ?? null, e.wasted]);

	for (const session of sessions) {
		out[`latestForSession(${session})`] = (await unified.latestForSession(session))?.id ?? null;
		out[`entriesForSession(${session})`] = (await unified.entriesForSession(session, 5)).map((e) => e.id);
	}

	out.softFailureSpikes = (await unified.softFailureSpikes(nowMs)).map((s) => [s.slug, s.recentRate, s.recentDispatches, s.baselineRate]);
	for (const tokenizer of ["gpt", "claude", "qwen", "llama"]) {
		out[`tokenRatio(${tokenizer})`] = await unified.tokenRatio(tokenizer);
	}
	return out;
}

const targets: { engine: string; url: string }[] = [
	{ engine: "sqlite", url: `sqlite:///tmp/ledger-parity-${Date.now()}.db` },
	...(pgUrl === "" ? [] : [{ engine: "postgres", url: pgUrl }]),
];

const snapshots = new Map<string, Record<string, unknown>>();
for (const target of targets) {
	console.log(`\n=== loading ${target.engine} ===`);
	const store = openSqlDb(target.url);
	await load(store);
	const ledger = createSqlLedger(store, cfg, { findModel: () => null });
	snapshots.set(target.engine, { ...(await ledgerSnapshot(ledger)), ...(await viewsSnapshot(store)) });
	await store.close();
}

// Every signal and every view, engine against engine. One engine alone still
// proves nothing was thrown: it loads the rows and computes the lot.
const [first, ...rest] = [...snapshots.keys()];
if (first !== undefined) {
	const a = snapshots.get(first) as Record<string, unknown>;
	labelA = first;
	for (const other of rest) {
		console.log(`\n=== ${other} vs ${first} ===`);
		labelB = other;
		const b = snapshots.get(other) as Record<string, unknown>;
		for (const key of Object.keys(a)) eq(key, a[key], b[key], 1e-9);
	}
	if (rest.length === 0) console.log(`\n=== ${first} only: ${Object.keys(a).length} values computed, nothing to compare against ===`);
}

console.log(`\n${checks - bad}/${checks} checks equal${bad === 0 ? "" : `, ${bad} MISMATCHED`}`);
process.exit(bad === 0 ? 0 : 1);
