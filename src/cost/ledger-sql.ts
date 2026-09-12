/**
 * The ledger, once, over either engine.
 *
 * Replaces the pair of backends this repo briefly carried (a synchronous
 * SQLite ledger and a Postgres one): two implementations of the same meaning
 * drift, and the ways they drift are silent — a `SUM()` returned as a string
 * skews a trust score by three points without raising anything, and a JSON
 * column stored double-encoded makes an escalation-cost term quietly null.
 * One implementation over `util/sql.ts` cannot diverge from itself.
 *
 * Everything here is async, because Postgres cannot be read synchronously and
 * a ledger that is only sometimes awaitable pushes that distinction into every
 * caller. `select` no longer reads the ledger at all — `router/index.ts`
 * prefetches through `LedgerReader` before ranking — so the turn path awaits
 * these once, concurrently, rather than per candidate.
 *
 * Row shapes and every row→value helper are shared with the original
 * implementation (`toTrust`, `toLatency`, `toEntry`, `foldBlendSamples`), so
 * what a trust score MEANS is defined in exactly one place.
 */

import type { CatalogModel } from "../catalog/types.ts";
import type { RouterConfig } from "../config/types.ts";
import { consumePendingEstimate } from "../tokens/estimate.ts";
import { jsonParam, jsonValue, num, numOrNull, type SqlDb } from "../util/sql.ts";
import { foldBlendSamples, type BlendSample } from "./blended.ts";
import { computeCost } from "./forecast.ts";
import {
	ATTRIBUTABLE_ERROR,
	CACHE_RELIABILITY_MEMO_MS,
	CACHE_RELIABILITY_ROWS,
	DAY_MS,
	errorKindOf,
	ESCALATION_COST_MEMO_MS,
	LATENCY_WINDOW_ROWS,
	MAX_SANE_BYTES_PER_TOKEN,
	MIN_CALIBRATION_SAMPLES,
	MIN_ESCALATION_SAMPLES,
	MIN_SANE_BYTES_PER_TOKEN,
	SPIKE_BASELINE_MS,
	SPIKE_MIN_DISPATCHES,
	SPIKE_MIN_FAILURES,
	SPIKE_MIN_RATE,
	SPIKE_RATIO,
	SPIKE_RECENT_MS,
	toEntry,
	toLatency,
	toTrust,
	TRUST_SELECT,
	type LedgerRow,
} from "./ledger.ts";
import type {
	AsyncLedger,
	BlendedRate,
	CostBreakdown,
	EscalationCost,
	LedgerEntry,
	LedgerSignals,
	ModelCacheReliability,
	ModelLatency,
	ModelTrust,
	PruneResult,
	SoftFailureSpike,
	UsageCounts,
} from "./types.ts";

// The spike thresholds belong to the reader they describe: importing them
// keeps one meaning across both handles rather than two sets that can drift.

interface TrustRowRaw {
	attempts: unknown;
	escalations: unknown;
	errors: unknown;
	failures: unknown;
	mean_cost_error: unknown;
}
interface LatencyRowRaw {
	samples: unknown;
	ttft_ms: unknown;
	ctok_sum: unknown;
	elapsed_ms_sum: unknown;
}

/** Postgres returns counts and BIGINT sums as strings; the helpers do arithmetic. */
function trustRow(raw: TrustRowRaw): Parameters<typeof toTrust>[1] {
	return {
		attempts: num(raw.attempts),
		escalations: num(raw.escalations),
		errors: num(raw.errors),
		failures: num(raw.failures),
		mean_cost_error: numOrNull(raw.mean_cost_error),
	};
}

function latencyRow(raw: LatencyRowRaw): Parameters<typeof toLatency>[1] {
	return {
		samples: num(raw.samples),
		ttft_ms: numOrNull(raw.ttft_ms),
		ctok_sum: numOrNull(raw.ctok_sum),
		elapsed_ms_sum: numOrNull(raw.elapsed_ms_sum),
	};
}

/** The feedback aggregate, coerced the same way. */
function feedbackRow(raw: { good: unknown; bad: unknown }): { good: number; bad: number } {
	return { good: num(raw.good), bad: num(raw.bad) };
}

/** `LATENCY_SELECT` with the JSON access the dialect needs. */
function latencySelect(db: SqlDb): string {
	const ctok = db.jsonNum("usage", "completionTokens");
	return `COUNT(CASE WHEN ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL THEN 1 END) AS samples,
		AVG(CASE WHEN ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL THEN ttft_ms END) AS ttft_ms,
		SUM(CASE WHEN ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL AND latency_ms > ttft_ms
			AND ${ctok} > 0 THEN ${ctok} END) AS ctok_sum,
		SUM(CASE WHEN ttft_ms IS NOT NULL AND ttft_ms > 0 AND error IS NULL AND latency_ms > ttft_ms
			AND ${ctok} > 0 THEN latency_ms - ttft_ms END) AS elapsed_ms_sum`;
}

const FEEDBACK_AGG = `COALESCE(SUM(CASE WHEN f.verdict = 'good' THEN 1 ELSE 0 END), 0) AS good,
		COALESCE(SUM(CASE WHEN f.verdict = 'bad' THEN 1 ELSE 0 END), 0) AS bad`;


/**
 * Ledger rows → entries, from either engine.
 *
 * `toEntry` parses the JSON columns because SQLite stores them as TEXT;
 * Postgres hands them back already parsed, and its integers and sums arrive as
 * strings. Normalising here keeps ONE definition of what a ledger entry is, so
 * a front door reading a file and a router reading a database cannot disagree
 * about a turn.
 */
export function entriesOf(rows: readonly unknown[]): LedgerEntry[] {
	return rows.map((raw) => {
		const row = raw as Record<string, unknown>;
		const asText = (value: unknown): string | null =>
			value === null || value === undefined ? null : JSON.stringify(jsonValue(value));
		return toEntry({
			...row,
			reasons: JSON.stringify(jsonValue<string[]>(row.reasons) ?? []),
			usage: JSON.stringify(jsonValue<UsageCounts>(row.usage) ?? {}),
			features: asText(row.features),
			classifier_reasons: asText(row.classifier_reasons),
			cost_breakdown: asText(row.cost_breakdown),
			created_at_ms: num(row.created_at_ms),
			turn: num(row.turn),
			predicted_usd: num(row.predicted_usd),
			reported_usd: numOrNull(row.reported_usd),
			attempt: num(row.attempt),
			latency_ms: numOrNull(row.latency_ms),
			ttft_ms: numOrNull(row.ttft_ms),
			wasted: num(row.wasted),
			prompt_tokens_saved: numOrNull(row.prompt_tokens_saved),
			redactions: numOrNull(row.redactions),
			score: numOrNull(row.score),
			confidence: numOrNull(row.confidence),
		} as unknown as LedgerRow);
	});
}

/** Where the price for a row's cost breakdown comes from. */
export interface LedgerDeps {
	/** The router's live catalog. A shared ledger has no catalog cache of its own. */
	findModel(slug: string): CatalogModel | null | undefined;
}

export function createSqlLedger(db: SqlDb, cfg: RouterConfig, deps: LedgerDeps): AsyncLedger {
	const { sql } = db;
	const latSelect = latencySelect(db);


	// Cast suffix for a nullable parameter, so Postgres can type a NULL
	// placeholder; empty on sqlite. Injected as SQL text, not bound.
	const nullText = db.nullableText;
	const promptTokens = db.jsonNum("usage", "promptTokens");
	const cachedTokens = db.jsonNum("usage", "cachedTokens");
	const cachedEstimated = db.jsonBool("usage", "cachedEstimated");
	let cacheMemo: { atMs: number; map: Map<string, ModelCacheReliability> } | null = null;
	let escalationMemo: { atMs: number; windowDays: number; value: EscalationCost | null } | null = null;

	/** Read at call time: hot reload mutates the config object in place. */
	const cutoffOf = (nowMs: number): number => (cfg.filters.trustWindowDays > 0 ? nowMs - cfg.filters.trustWindowDays * DAY_MS : 0);

	const feedbackFor = async (
		slugs: readonly string[],
		harnessId: string | undefined,
		cutoff: number,
		task?: string,
	): Promise<Map<string, { good: number; bad: number }>> => {
		const out = new Map<string, { good: number; bad: number }>();
		if (cfg.filters.feedbackWeight <= 0 || slugs.length === 0) return out;
		const harness = harnessId !== undefined && harnessId !== "" ? harnessId : null;
		const scopedTask = cfg.filters.feedbackByTask && task !== undefined && task !== "" ? task : null;
		// The verdict's own age bounds the window; the judged turn supplies the
		// harness and task scoping. A verdict on a turn of another task type, or
		// from another harness, is not evidence about THIS request.
		const rows = (await sql`
			SELECT f.slug, ${sql.unsafe(FEEDBACK_AGG)}
			FROM feedback f
			LEFT JOIN ledger l ON l.id = f.ledger_id
			WHERE f.slug IN ${sql([...slugs])} AND f.created_at_ms > ${cutoff}
				AND (${harness}${sql.unsafe(nullText)} IS NULL OR l.harness_id = ${harness})
				AND (${scopedTask}${sql.unsafe(nullText)} IS NULL OR l.task = ${scopedTask} OR l.task IS NULL)
			GROUP BY f.slug`) as { slug: string; good: unknown; bad: unknown }[];
		for (const row of rows) out.set(row.slug, feedbackRow(row));
		return out;
	};

	const trustFor = async (
		slugs: readonly string[],
		harnessId: string | undefined,
		cutoff: number,
	): Promise<Map<string, Parameters<typeof toTrust>[1]>> => {
		const out = new Map<string, Parameters<typeof toTrust>[1]>();
		if (slugs.length === 0) return out;
		const harness = harnessId !== undefined && harnessId !== "" ? harnessId : null;
		const rows = (await sql`
			SELECT slug, ${sql.unsafe(TRUST_SELECT)}
			FROM ledger
			WHERE slug IN ${sql([...slugs])} AND created_at_ms > ${cutoff}
				AND (${harness}${sql.unsafe(nullText)} IS NULL OR harness_id = ${harness})
			GROUP BY slug`) as (TrustRowRaw & { slug: string })[];
		for (const row of rows) out.set(row.slug, trustRow(row));
		return out;
	};

	const latencyFor = async (slugs: readonly string[], harnessId: string | undefined): Promise<Map<string, ModelLatency>> => {
		const out = new Map<string, ModelLatency>();
		if (slugs.length === 0) return out;
		const harness = harnessId !== undefined && harnessId !== "" ? harnessId : null;
		// The window is the newest LATENCY_WINDOW_ROWS rows PER SLUG, so it is a
		// ROW_NUMBER partition rather than one global LIMIT.
		const rows = (await sql`
			WITH windowed AS (
				SELECT slug, ttft_ms, latency_ms, error, usage,
					ROW_NUMBER() OVER (PARTITION BY slug ORDER BY created_at_ms DESC) AS rn
				FROM ledger
				WHERE slug IN ${sql([...slugs])} AND (${harness}${sql.unsafe(nullText)} IS NULL OR harness_id = ${harness})
			)
			SELECT slug, ${sql.unsafe(latSelect)} FROM windowed WHERE rn <= ${LATENCY_WINDOW_ROWS} GROUP BY slug`) as (LatencyRowRaw & {
			slug: string;
		})[];
		for (const row of rows) {
			const value = toLatency(row.slug, latencyRow(row));
			if (value !== null) out.set(row.slug, value);
		}
		return out;
	};

	const cacheMap = async (): Promise<Map<string, ModelCacheReliability>> => {
		const nowMs = Date.now();
		if (cacheMemo !== null && nowMs - cacheMemo.atMs <= CACHE_RELIABILITY_MEMO_MS) return cacheMemo.map;
		// Pair each turn with the previous turn of its conversation and measure
		// the hit rate only where a warm cache was actually expected. Rows whose
		// cache count the router ESTIMATED are excluded: they would measure our
		// own guess. `cachedEstimated` is a boolean in the usage JSON, so it is
		// compared as text rather than cast to an integer.
		const rows = (await sql`
			WITH recent AS (
				SELECT conversation_key AS ck, created_at_ms AS t, COALESCE(served_slug, slug) AS s,
					${sql.unsafe(promptTokens)} AS p, ${sql.unsafe(cachedTokens)} AS c,
					${sql.unsafe(cachedEstimated)} AS est
				FROM ledger WHERE wasted = 0 AND error IS NULL
				ORDER BY created_at_ms DESC, id DESC LIMIT ${CACHE_RELIABILITY_ROWS}),
			seq AS (
				SELECT s, p, c, est, t,
					LAG(s) OVER w AS prev_s, LAG(p) OVER w AS prev_p, LAG(t) OVER w AS prev_t
				FROM recent WINDOW w AS (PARTITION BY ck ORDER BY t))
			SELECT s AS slug, COUNT(*) AS samples,
				AVG(${sql.unsafe(db.least("1.0", `c * 1.0 / NULLIF(${db.least("prev_p", "p")}, 0)`))}) AS hit
			FROM seq
			WHERE prev_s = s AND p > 1000 AND prev_p > 1000 AND t - prev_t <= ${cfg.hysteresis.cacheWarmTtlMs} AND est = 0
			GROUP BY s`) as { slug: string; samples: unknown; hit: unknown }[];
		const map = new Map<string, ModelCacheReliability>();
		for (const row of rows) {
			map.set(row.slug, { slug: row.slug, samples: num(row.samples), hitRate: Math.min(1, Math.max(0, num(row.hit))) });
		}
		cacheMemo = { atMs: nowMs, map };
		return map;
	};

	const entriesFrom = entriesOf;


	return {
		async record(entry: LedgerEntry): Promise<void> {
			const model =
				entry.priceModel ??
				(entry.servedSlug !== null ? deps.findModel(entry.servedSlug) : undefined) ??
				deps.findModel(entry.slug) ??
				null;
			const breakdown = model !== null ? computeCost(model, entry.usage) : null;
			await sql`
				INSERT INTO ledger (
					id, created_at_ms, conversation_key, session_id, turn, requested_model, harness_id, omp_session_id,
					slug, served_slug, tier, classification_source, reasons, predicted_usd, reported_usd, usage,
					cost_breakdown, attempt, escalation_signal, latency_ms, ttft_ms, finish_reason, wasted,
					upstream_generation_id, error, error_kind, features, score, confidence, task, classifier_reasons,
					explored_from, hold_arm, prompt_tokens_saved, scope, redactions
				) VALUES (
					${entry.id}, ${entry.createdAtMs}, ${entry.conversationKey}, ${entry.sessionId}, ${entry.turn},
					${entry.requestedModel}, ${entry.harnessId}, ${entry.ompSessionId}, ${entry.slug}, ${entry.servedSlug},
					${entry.tier}, ${entry.classificationSource}, ${jsonParam(db, entry.reasons)}, ${entry.predictedUsd},
					${entry.reportedUsd}, ${jsonParam(db, entry.usage)}, ${jsonParam(db, breakdown)}, ${entry.attempt},
					${entry.escalationSignal}, ${entry.latencyMs}, ${entry.ttftMs}, ${entry.finishReason},
					${entry.wasted ? 1 : 0}, ${entry.upstreamGenerationId}, ${entry.error}, ${errorKindOf(entry.error)},
					${jsonParam(db, entry.features)}, ${entry.score}, ${entry.confidence}, ${entry.task},
					${jsonParam(db, entry.classifierReasons)}, ${entry.exploredFrom}, ${entry.holdArm},
					${entry.promptTokensSaved},
					${entry.scope === undefined || entry.scope === "" ? null : entry.scope}, ${entry.redactions ?? null}
				)
				ON CONFLICT (id) DO NOTHING`;
			// Always consume the pending estimate, even when the turn failed, so a
			// dead turn's bytes can never pair with a later turn's tokens.
			const pending = consumePendingEstimate(entry.conversationKey);
			if (entry.usage.promptTokens > 0 && pending !== null) {
				const tokenizer = (model?.tokenizer ?? pending.tokenizer).trim().toLowerCase();
				// Reject samples no real tokenizer could produce: the rows are
				// running sums, so one provider reporting inflated counts poisons a
				// whole family for thousands of samples.
				const bytesPerToken = pending.bytes / entry.usage.promptTokens;
				if (bytesPerToken >= MIN_SANE_BYTES_PER_TOKEN && bytesPerToken <= MAX_SANE_BYTES_PER_TOKEN) {
					await sql`
						INSERT INTO token_calibration (tokenizer, est_bytes, actual_tokens, samples)
						VALUES (${tokenizer}, ${pending.bytes}, ${entry.usage.promptTokens}, 1)
						ON CONFLICT (tokenizer) DO UPDATE SET
							est_bytes = token_calibration.est_bytes + ${pending.bytes},
							actual_tokens = token_calibration.actual_tokens + ${entry.usage.promptTokens},
							samples = token_calibration.samples + 1`;
				}
			}
		},

		async conversationSpend(conversationKey: string): Promise<number> {
			const rows = (await sql`
				SELECT COALESCE(SUM(COALESCE(reported_usd, predicted_usd)), 0) AS total
				FROM ledger WHERE conversation_key = ${conversationKey}`) as { total: unknown }[];
			return num(rows[0]?.total);
		},

		async spendSince(sinceMs: number, harnessId?: string): Promise<number> {
			const harness = harnessId !== undefined && harnessId !== "" ? harnessId : null;
			const rows = (await sql`
				SELECT COALESCE(SUM(COALESCE(reported_usd, predicted_usd)), 0) AS total
				FROM ledger
				WHERE created_at_ms >= ${sinceMs} AND (${harness}${sql.unsafe(nullText)} IS NULL OR harness_id = ${harness})`) as { total: unknown }[];
			return num(rows[0]?.total);
		},

		async blendedRate(windowDays: number): Promise<BlendedRate | null> {
			const rows = (await sql`
				SELECT usage, reported_usd, cost_breakdown FROM ledger
				WHERE created_at_ms >= ${Date.now() - windowDays * DAY_MS}
					AND reported_usd IS NOT NULL AND cost_breakdown IS NOT NULL`) as {
				usage: unknown;
				reported_usd: unknown;
				cost_breakdown: unknown;
			}[];
			const samples: BlendSample[] = [];
			for (const row of rows) {
				const usage = jsonValue<UsageCounts>(row.usage);
				const breakdown = jsonValue<CostBreakdown>(row.cost_breakdown);
				if (usage === null || breakdown === null) continue;
				samples.push({ usage, reportedUsd: num(row.reported_usd), breakdown });
			}
			return foldBlendSamples(samples, cfg, windowDays);
		},

		async trust(slug: string, harnessId?: string, task?: string): Promise<ModelTrust | null> {
			const cutoff = cutoffOf(Date.now());
			const rows = await trustFor([slug], harnessId, cutoff);
			const row = rows.get(slug);
			if (row === undefined || row.attempts === 0) return null;
			const fb = await feedbackFor([slug], harnessId, cutoff, task);
			return toTrust(slug, row, fb.get(slug) ?? null, cfg.filters.feedbackWeight);
		},

		async allTrust(): Promise<ModelTrust[]> {
			const cutoff = cutoffOf(Date.now());
			const rows = (await sql`
				SELECT slug, ${sql.unsafe(TRUST_SELECT)} FROM ledger WHERE created_at_ms > ${cutoff} GROUP BY slug`) as (TrustRowRaw & {
				slug: string;
			})[];
			const slugs = rows.map((r) => r.slug);
			const fb = await feedbackFor(slugs, undefined, cutoff);
			return rows.map((row) => toTrust(row.slug, trustRow(row), fb.get(row.slug) ?? null, cfg.filters.feedbackWeight));
		},

		async latency(slug: string, harnessId?: string): Promise<ModelLatency | null> {
			return (await latencyFor([slug], harnessId)).get(slug) ?? null;
		},

		async signals(slugs: readonly string[], harnessId?: string, task?: string): Promise<Map<string, LedgerSignals>> {
			const out = new Map<string, LedgerSignals>();
			if (slugs.length === 0) return out;
			const cutoff = cutoffOf(Date.now());
			// One query per signal kind for the whole candidate set, concurrently.
			const [trust, latency, fb] = await Promise.all([
				trustFor(slugs, harnessId, cutoff),
				latencyFor(slugs, harnessId),
				feedbackFor(slugs, harnessId, cutoff, task),
			]);
			for (const slug of slugs) {
				const t = trust.get(slug);
				out.set(slug, {
					trust: t === undefined || t.attempts === 0 ? null : toTrust(slug, t, fb.get(slug) ?? null, cfg.filters.feedbackWeight),
					latency: latency.get(slug) ?? null,
				});
			}
			return out;
		},

		async cacheReliability(slugs: readonly string[]): Promise<Map<string, ModelCacheReliability>> {
			const map = await cacheMap();
			const out = new Map<string, ModelCacheReliability>();
			for (const slug of slugs) {
				const hit = map.get(slug);
				if (hit !== undefined) out.set(slug, hit);
			}
			return out;
		},

		async escalationCost(windowDays: number): Promise<EscalationCost | null> {
			const nowMs = Date.now();
			if (escalationMemo !== null && escalationMemo.windowDays === windowDays && nowMs - escalationMemo.atMs < ESCALATION_COST_MEMO_MS) {
				return escalationMemo.value;
			}
			const rows = (await sql`
				SELECT COUNT(*) AS samples,
					COALESCE(SUM(COALESCE(reported_usd, predicted_usd)), 0) AS usd,
					COALESCE(SUM(${sql.unsafe(promptTokens)}), 0) AS prompt_tokens
				FROM ledger WHERE attempt > 0 AND error IS NULL AND created_at_ms >= ${nowMs - windowDays * DAY_MS}`) as {
				samples: unknown;
				usd: unknown;
				prompt_tokens: unknown;
			}[];
			const row = rows[0];
			const samples = num(row?.samples);
			const tokens = num(row?.prompt_tokens);
			const value: EscalationCost | null =
				row === undefined || samples < MIN_ESCALATION_SAMPLES || tokens <= 0
					? null
					: { usdPerPromptToken: num(row.usd) / tokens, samples, windowDays };
			escalationMemo = { atMs: nowMs, windowDays, value };
			return value;
		},

		async tokenRatio(tokenizer: string): Promise<number | null> {
			const rows = (await sql`
				SELECT est_bytes, actual_tokens, samples FROM token_calibration
				WHERE tokenizer = ${tokenizer.trim().toLowerCase()}`) as { est_bytes: unknown; actual_tokens: unknown; samples: unknown }[];
			const row = rows[0];
			if (row === undefined) return null;
			const actual = num(row.actual_tokens);
			if (num(row.samples) < MIN_CALIBRATION_SAMPLES || actual <= 0) return null;
			return num(row.est_bytes) / actual;
		},

		async recentEntries(limit: number): Promise<LedgerEntry[]> {
			return entriesFrom((await sql`SELECT * FROM ledger ORDER BY created_at_ms DESC LIMIT ${limit}`) as unknown[]);
		},

		async softFailureSpikes(nowMs = Date.now(), recentMs = SPIKE_RECENT_MS, baselineMs = SPIKE_BASELINE_MS): Promise<SoftFailureSpike[]> {
			const recentStart = nowMs - recentMs;
			const baselineStart = nowMs - recentMs - baselineMs;
			// Wasted rows stay in: they ARE the soft failures being counted.
			// Digest side calls are excluded — they are not the session's turns.
			const rows = (await sql`
				SELECT COALESCE(served_slug, slug) AS slug,
					SUM(CASE WHEN created_at_ms >= ${recentStart} THEN 1 ELSE 0 END) AS recent_n,
					SUM(CASE WHEN created_at_ms >= ${recentStart} AND (escalation_signal IS NOT NULL OR (${sql.unsafe(ATTRIBUTABLE_ERROR)})) THEN 1 ELSE 0 END) AS recent_f,
					SUM(CASE WHEN created_at_ms < ${recentStart} THEN 1 ELSE 0 END) AS base_n,
					SUM(CASE WHEN created_at_ms < ${recentStart} AND (escalation_signal IS NOT NULL OR (${sql.unsafe(ATTRIBUTABLE_ERROR)})) THEN 1 ELSE 0 END) AS base_f
				FROM ledger
				WHERE created_at_ms >= ${baselineStart} AND created_at_ms <= ${nowMs} AND requested_model <> 'digest'
				GROUP BY COALESCE(served_slug, slug)`) as {
				slug: string;
				recent_n: unknown;
				recent_f: unknown;
				base_n: unknown;
				base_f: unknown;
			}[];
			const spikes: SoftFailureSpike[] = [];
			for (const raw of rows) {
				const recentDispatches = num(raw.recent_n);
				const recentFailures = num(raw.recent_f);
				const baselineDispatches = num(raw.base_n);
				const baselineFailures = num(raw.base_f);
				if (recentDispatches < SPIKE_MIN_DISPATCHES || recentFailures < SPIKE_MIN_FAILURES) continue;
				const recentRate = recentFailures / recentDispatches;
				const baselineRate = baselineDispatches > 0 ? baselineFailures / baselineDispatches : 0;
				if (recentRate < SPIKE_MIN_RATE || recentRate < SPIKE_RATIO * baselineRate) continue;
				spikes.push({ slug: raw.slug, recentDispatches, recentFailures, recentRate, baselineDispatches, baselineFailures, baselineRate });
			}
			spikes.sort((a, b) => b.recentRate - a.recentRate || b.recentFailures - a.recentFailures);
			return spikes;
		},

		async providerSpendSince(slugPrefix: string, sinceMs: number): Promise<number> {
			const rows = (await sql`
				SELECT COALESCE(SUM(COALESCE(reported_usd, predicted_usd)), 0) AS total
				FROM ledger WHERE created_at_ms >= ${sinceMs} AND COALESCE(served_slug, slug) LIKE ${`${slugPrefix}%`}`) as {
				total: unknown;
			}[];
			return num(rows[0]?.total);
		},

		async prune(retentionDays: number | null, nowMs = Date.now()): Promise<PruneResult> {
			const oldest = async (): Promise<number | null> => {
				const rows = (await sql`SELECT MIN(created_at_ms) AS oldest FROM ledger`) as { oldest: unknown }[];
				return numOrNull(rows[0]?.oldest);
			};
			// null and 0 are the same instruction: keep everything. Still reports
			// how far back the ledger goes, which is what the caller asked.
			if (retentionDays === null || retentionDays <= 0) return { deleted: 0, oldestKeptMs: await oldest() };
			const cutoff = nowMs - retentionDays * DAY_MS;
			// Dependants first: a verdict on a forgotten turn is a note about a
			// conversation the operator asked us to forget. Matched by the row it
			// points at AND its own age, so verdicts orphaned by an older prune are
			// swept up too.
			await sql`DELETE FROM feedback WHERE created_at_ms < ${cutoff} OR ledger_id IN (SELECT id FROM ledger WHERE created_at_ms < ${cutoff})`;
			await sql`DELETE FROM ollama_meter_samples WHERE at_ms < ${cutoff}`;
			const deleted = (await sql`DELETE FROM ledger WHERE created_at_ms < ${cutoff} RETURNING id`) as { id: string }[];
			return { deleted: deleted.length, oldestKeptMs: await oldest() };
		},

		async markWasted(id: string): Promise<void> {
			await sql`UPDATE ledger SET wasted = 1 WHERE id = ${id}`;
		},

		async latestForSession(ompSessionId: string): Promise<LedgerEntry | null> {
			if (ompSessionId === "") return null;
			const rows = (await sql`
				SELECT * FROM ledger WHERE omp_session_id = ${ompSessionId} AND wasted = 0 AND requested_model <> 'digest'
				ORDER BY created_at_ms DESC LIMIT 1`) as unknown[];
			return entriesFrom(rows)[0] ?? null;
		},

		async entriesForSession(ompSessionId: string, limit: number): Promise<LedgerEntry[]> {
			if (ompSessionId === "") return [];
			const rows = (await sql`
				SELECT * FROM ledger WHERE omp_session_id = ${ompSessionId} AND wasted = 0 AND requested_model <> 'digest'
				ORDER BY created_at_ms DESC LIMIT ${Math.max(1, limit)}`) as unknown[];
			return entriesFrom(rows);
		},
	};
}
