/**
 * `omp-router models` - the operator's window into routing policy.
 *
 * Eligibility is computed by calling the REAL `buildCandidates` path against a
 * representative synthetic request, not by reimplementing the filters here.
 * A second copy of the filter logic would drift from the router and this
 * command's whole value is that it cannot lie about what would be chosen.
 */

import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";

import { createCatalog } from "../catalog/openrouter-catalog.ts";
import { effectiveQualityFloor, tierPlanFor } from "../router/tier-plan.ts";
import { loadConfig } from "../config/load.ts";
import type { QualityAxis, RouterConfig } from "../config/types.ts";
import { createLedger } from "../cost/ledger.ts";
import type { Ledger } from "../cost/types.ts";
import { buildCandidates } from "../router/candidates.ts";
import { classifyTask } from "../router/classify.ts";
import { extractFeatures } from "../router/features.ts";
import { TIER_ORDER, type Candidate, type Rejection, type Tier } from "../router/types.ts";
import { estimatePromptTokens } from "../tokens/estimate.ts";
import { createOpenRouterClient } from "../upstream/openrouter.ts";
import { openDb } from "../util/sqlite.ts";
import { parseChatRequest } from "../wire/openai/request.ts";
import { configOpts, flagInt, flagString, type CliArgs } from "./args.ts";

/** Mid-range completion assumption, matching select.ts so forecasts line up. */
const EXPECTED_COMPLETION_TOKENS = 1024;
const DEFAULT_LIMIT = 15;

/**
 * A representative agent turn: tools offered, some history, no images. The
 * survey is only meaningful relative to a concrete request shape, and this is
 * the shape omp actually sends.
 */
function syntheticRequest() {
	const tools = [
		{
			type: "function",
			function: {
				name: "read",
				description: "Read a file from disk",
				parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
			},
		},
		{
			type: "function",
			function: {
				name: "edit",
				description: "Apply a line-anchored patch to a file",
				parameters: { type: "object", properties: { path: { type: "string" }, patch: { type: "string" } } },
			},
		},
	];
	return parseChatRequest(
		{
			model: "auto",
			stream: true,
			tools,
			messages: [
				{ role: "system", content: "You are a coding agent operating in a repository." },
				{ role: "user", content: "Refactor the retry helper so the backoff is testable." },
			],
		},
		new Headers(),
	);
}

function perMtok(perToken: number): string {
	return (perToken * 1e6).toFixed(3);
}

/**
 * "no published benchmark" and "benchmarked as weak" are different facts, and
 * collapsing both to 0.0 would misrepresent why a model is or is not eligible.
 */
function qualityCell(c: Candidate): string {
	const q = c.model.quality;
	const unscored = q.coding === undefined && q.agentic === undefined && q.intelligence === undefined;
	return unscored ? "-" : c.qualityScore.toFixed(1);
}

interface TierReport {
	tier: Tier;
	minQuality: number;
	/** Floor actually enforced; differs from `minQuality` under adaptive floors. */
	effectiveQuality: number;
	axis: QualityAxis;
	candidates: Candidate[];
	rejected: Rejection[];
}

function renderTier(report: TierReport, limit: number): void {
	const { tier, candidates, rejected } = report;
	// Make an adaptive relaxation visible: "floor 95 → 76.1 (adaptive)" explains
	// why models below the configured floor are eligible.
	const floor =
		report.effectiveQuality === report.minQuality
			? String(report.minQuality)
			: `${report.minQuality} → ${report.effectiveQuality.toFixed(1)} (adaptive)`;
	console.log(
		`\n[${tier}]  quality floor ${floor} on the ${report.axis} axis  -  ${candidates.length} eligible, ${rejected.length} excluded`,
	);
	if (candidates.length === 0) {
		console.log("  (nothing eligible: loosen the tier's floor or price ceiling)");
	} else {
		const rows = candidates.slice(0, limit);
		const slugWidth = Math.max(5, ...rows.map((c) => c.model.slug.length));
		console.log(
			`  ${"model".padEnd(slugWidth)}  ${"qual".padStart(5)}  ${"trust".padStart(5)}  ${"$/Mtok in".padStart(10)}  ${"$/Mtok out".padStart(10)}  ${"ctx".padStart(9)}  ${"turn $".padStart(9)}`,
		);
		console.log(
			`  ${"-".repeat(slugWidth)}  ${"-".repeat(5)}  ${"-".repeat(5)}  ${"-".repeat(10)}  ${"-".repeat(10)}  ${"-".repeat(9)}  ${"-".repeat(9)}`,
		);
		for (const c of rows) {
			console.log(
				`  ${c.model.slug.padEnd(slugWidth)}  ${qualityCell(c).padStart(5)}  ${c.trustScore.toFixed(2).padStart(5)}  ${perMtok(c.model.price.prompt).padStart(10)}  ${perMtok(c.model.price.completion).padStart(10)}  ${c.model.contextLength.toLocaleString("en-US").padStart(9)}  ${`$${c.forecast.expectedUsd.toFixed(5)}`.padStart(9)}`,
			);
		}
		if (candidates.length > rows.length) console.log(`  ... ${candidates.length - rows.length} more`);
	}

	// Hundreds of rejections per tier: summarise by cause, with examples.
	const byReason = new Map<string, string[]>();
	for (const r of rejected) {
		const list = byReason.get(r.reason);
		if (list === undefined) byReason.set(r.reason, [r.slug]);
		else list.push(r.slug);
	}
	if (byReason.size > 0) {
		console.log("  excluded:");
		const ordered = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
		for (const [reason, slugs] of ordered) {
			console.log(`    ${reason.padEnd(22)} ${String(slugs.length).padStart(4)}  e.g. ${slugs.slice(0, 3).join(", ")}`);
		}
	}
}

export async function modelsCommand(args: CliArgs): Promise<void> {
	const cfg: RouterConfig = loadConfig(configOpts(args));
	const limit = flagInt(args, "limit") ?? DEFAULT_LIMIT;
	const tierFlag = flagString(args, "tier");
	if (tierFlag !== undefined && !(TIER_ORDER as readonly string[]).includes(tierFlag)) {
		throw new Error(`--tier must be one of ${TIER_ORDER.join(", ")}, got "${tierFlag}"`);
	}
	const tiers = tierFlag === undefined ? TIER_ORDER : [tierFlag as Tier];

	// Reuse the on-disk catalog cache when present so a survey costs no network.
	const db: Database = openDb(cfg.ledger.path);
	const ledger: Ledger | null = existsSync(cfg.ledger.path) ? createLedger(db, cfg) : null;
	try {
		const upstream = createOpenRouterClient(cfg);
		const catalog = createCatalog(cfg, upstream, db);
		const snapshot = await catalog.get();

		const req = syntheticRequest();
		const promptTokens = estimatePromptTokens(req, "gpt", ledger);
		const features = extractFeatures(req, promptTokens);

		const reports: TierReport[] = tiers.map((tier) => {
			const tierCfg = cfg.tiers[tier];
			const task = classifyTask(features);
			const axis = cfg.tasks[task].axis;
			const { candidates, rejected } = buildCandidates({
				req,
				features,
				tier,
				task,
				snapshot,
				ledger,
				cfg,
				expectedCompletionTokens: EXPECTED_COMPLETION_TOKENS,
				warmSlug: null,
			});
			// Report the floor actually enforced, not the configured constant: with
			// adaptive floors on they differ, and printing the configured value
			// makes an eligible tier look impossible.
			const effective = cfg.adaptiveTierFloors
				? effectiveQualityFloor(tierCfg.minQuality, tier, axis, tierPlanFor(snapshot, cfg))
				: tierCfg.minQuality;
			return { tier, minQuality: tierCfg.minQuality, effectiveQuality: effective, axis, candidates, rejected };
		});

		if (args.flags.has("json")) {
			console.log(
				JSON.stringify(
					{
						catalogModels: snapshot.models.length,
						catalogAgeMs: Date.now() - snapshot.fetchedAtMs,
						promptTokens,
						tiers: reports.map((r) => ({
							tier: r.tier,
							minQuality: r.minQuality,
							axis: r.axis,
							eligible: r.candidates.slice(0, limit).map((c) => ({
								slug: c.model.slug,
								quality: c.qualityScore,
								trust: c.trustScore,
								inputPerMtok: c.model.price.prompt * 1e6,
								outputPerMtok: c.model.price.completion * 1e6,
								contextLength: c.model.contextLength,
								expectedUsd: c.forecast.expectedUsd,
								score: c.score,
							})),
							excluded: r.rejected.length,
						})),
					},
					null,
					2,
				),
			);
			return;
		}

		console.log(
			`catalog: ${snapshot.models.length} usable models, fetched ${Math.round((Date.now() - snapshot.fetchedAtMs) / 1000)}s ago`,
		);
		console.log(`survey request: ${promptTokens} estimated prompt tokens, ${req.tools.length} tools offered`);
		for (const report of reports) renderTier(report, limit);
	} finally {
		db.close();
	}
}
