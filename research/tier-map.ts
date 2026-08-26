/**
 * Full placement matrix: for every catalog model, which tiers it is eligible
 * for, on each routed axis (coding task -> coding axis, chat task -> intelligence
 * axis). Faithful to src/router/candidates.ts (adaptive floors, price ceilings,
 * capability filters). Reads the on-disk catalog cache; no network.
 *
 *   bun run research/tier-map.ts [db]
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot } from "../src/catalog/types.ts";
import { loadConfig } from "../src/config/load.ts";
import { buildCandidates } from "../src/router/candidates.ts";
import { extractFeatures } from "../src/router/features.ts";
import { effectiveQualityFloor, tierPlanFor } from "../src/router/tier-plan.ts";
import { TIER_ORDER, type Tier, type TaskType } from "../src/router/types.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";

const dbPath = process.argv[2] ?? join(homedir(), ".auto-model-router", "router.db");
const db = new Database(dbPath, { readonly: true });
const row = db.query("SELECT payload FROM catalog_cache WHERE id = 1").get() as { payload: string } | null;
db.close();
if (row === null) {
	console.log("no cached catalog");
	process.exit(1);
}

const models: CatalogModel[] = (JSON.parse(row.payload) as unknown[])
	.map(normalizeCatalogModel)
	.filter((m): m is CatalogModel => m !== null)
	.sort((a, b) => a.price.prompt - b.price.prompt);

const snapshot: CatalogSnapshot = { models, fetchedAtMs: Date.now() };
const cfg = loadConfig({});

const req = parseChatRequest(
	{ model: "auto", messages: [{ role: "user", content: "Implement and verify the change." }] },
	new Headers(),
);
const features = extractFeatures(req, 4000);

// reason -> single-char code for the matrix cell
function code(reason: string | undefined): string {
	if (reason === undefined) return "OK ";
	if (reason === "below_quality_floor") return "qual";
	if (reason === "over_price_ceiling") return "pric";
	if (reason === "free_tier_excluded") return "free";
	return reason.slice(0, 4);
}

const axes: Array<{ label: string; task: TaskType }> = [
	{ label: "coding axis (task=coding)", task: "coding" as TaskType },
	{ label: "intelligence axis (task=chat)", task: "chat" as TaskType },
];

for (const { label, task } of axes) {
	const axis = cfg.tasks[task].axis;
	console.log(`\n===== ${label} =====`);

	// Effective (adaptive) floor per tier on this axis.
	const floors: Record<string, number> = {};
	for (const tier of TIER_ORDER) {
		const tc = cfg.tiers[tier];
		const adaptive = cfg.adaptiveTierFloors
			? effectiveQualityFloor(tc.minQuality, tier, axis, tierPlanFor(snapshot, cfg))
			: tc.minQuality;
		floors[tier] = Math.max(adaptive, cfg.tasks[task].minQuality ?? 0);
	}
	console.log(
		`floors  ` +
			TIER_ORDER.map((t) => `${t}=${floors[t]?.toFixed(1)}(cfg ${cfg.tiers[t].minQuality})`).join("  ") +
			`\nceil$   ` +
			TIER_ORDER.map((t) => `${t}=${cfg.tiers[t].maxInputPerMtok ?? "inf"}`).join("  ") +
			`\n`,
	);

	// Per tier: eligible set + rejection reasons.
	const perTier = TIER_ORDER.map((tier) => {
		const { candidates, rejected } = buildCandidates({
			req,
			features,
			tier,
			task,
			snapshot,
			ledger: null,
			cfg,
			expectedCompletionTokens: 4000,
			warmSlug: null,
		});
		const elig = new Set(candidates.map((c) => c.model.slug));
		const rej = new Map(rejected.map((r) => [r.slug, r.reason]));
		return { tier, elig, rej };
	});

	const qOf = (m: CatalogModel): number | undefined =>
		axis === "coding" ? m.quality.coding : axis === "agentic" ? m.quality.agentic : m.quality.intelligence;

	const nameW = Math.max(...models.map((m) => m.slug.length));
	const header =
		"model".padEnd(nameW) + "  in$   " + "q".padEnd(6) + TIER_ORDER.map((t) => t.slice(0, 4).padEnd(6)).join("");
	console.log(header);
	console.log("-".repeat(header.length));
	for (const m of models) {
		const q = qOf(m);
		const cells = perTier
			.map((pt) => (pt.elig.has(m.slug) ? "OK " : code(pt.rej.get(m.slug))).padEnd(6))
			.join("");
		console.log(
			m.slug.padEnd(nameW) +
				"  " +
				(m.price.prompt * 1e6).toFixed(2).padStart(5) +
				"  " +
				(q === undefined ? "-" : q.toFixed(1)).padEnd(6) +
				cells,
		);
	}
}
console.log("\ncells: OK=eligible  qual=below_quality_floor  pric=over_price_ceiling  free=free_tier_excluded");
