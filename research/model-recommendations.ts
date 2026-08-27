/**
 * Which models to ENABLE on the OpenRouter key. The key-scoped catalog is narrow
 * (guardrails/preferences), so tiers — `hard` especially — resolve to one
 * candidate and can't take a price ceiling or same-tier failover. This fetches
 * the FULL public catalog, runs it through the router's real tier filters, and
 * reports the models that WOULD be eligible per tier but are not currently
 * admitted by the key. Read-only. Needs network.
 *
 *   bun run research/model-recommendations.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";

process.env.AUTO_MODEL_ROUTER_HOME = join(homedir(), ".auto-model-router");

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot } from "../src/catalog/types.ts";
import { loadConfig } from "../src/config/load.ts";
import { buildCandidates } from "../src/router/candidates.ts";
import { extractFeatures } from "../src/router/features.ts";
import { effectiveQualityFloor, tierPlanFor } from "../src/router/tier-plan.ts";
import type { Tier } from "../src/router/types.ts";
import { createOpenRouterClient } from "../src/upstream/openrouter.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";

const cfg = loadConfig({});

const client = createOpenRouterClient(cfg);

// Current key-scoped availability, fetched LIVE (/models/user) so it reflects
// account changes immediately — the cached snapshot lags until a router refresh.
const userRaw = await client.fetchModelsForUser(AbortSignal.timeout(30_000));
const keyScoped = new Set<string>(
	userRaw.map(normalizeCatalogModel).filter((m): m is CatalogModel => m !== null).map((m) => m.slug),
);

// Full public catalog (carries AA benchmarks).
const raw = await client.fetchModels(AbortSignal.timeout(30_000));
const models = raw.map(normalizeCatalogModel).filter((m): m is CatalogModel => m !== null);
const snapshot: CatalogSnapshot = { models, fetchedAtMs: Date.now() };
console.log(`public catalog: ${models.length} models; key-scoped now (live): ${keyScoped.size}\n`);

// A representative hard coding turn, so task=coding (axis=coding).
const req = parseChatRequest(
	{ model: "auto", messages: [{ role: "user", content: "Refactor the scheduler to remove the global lock and prove it stays correct under concurrency." }] },
	new Headers(),
);
const features = extractFeatures(req, 8000);

// Cover both axes a coding agent actually routes on: coding (task=coding) and
// intelligence (task=chat). Model choice for `hard` should be strong on both.
const combos: Array<[Tier, "coding" | "chat"]> = [
	["hard", "coding"],
	["hard", "chat"],
	["moderate", "coding"],
];
for (const [tier, task] of combos) {
	const axis = cfg.tasks[task].axis;
	const tc = cfg.tiers[tier];
	// Floor if the FULL catalog were available (not the collapsed key-scoped floor).
	const floor = cfg.adaptiveTierFloors
		? effectiveQualityFloor(tc.minQuality, tier, axis, tierPlanFor(snapshot, cfg))
		: tc.minQuality;
	const { candidates } = buildCandidates({
		req,
		features,
		tier,
		task,
		snapshot,
		ledger: null,
		cfg,
		expectedCompletionTokens: 8000,
		warmSlug: null,
	});
	const ranked = [...candidates].sort((a, b) => b.qualityScore - a.qualityScore);
	const haveNow = ranked.filter((c) => keyScoped.has(c.model.slug)).length;
	console.log(`\n===== ${tier} (axis ${axis}, floor ${floor.toFixed(1)}) — ${ranked.length} eligible in full catalog, ${haveNow} already on your key =====`);
	console.log("  add?  slug".padEnd(46) + "q     in$/Mtok  ctx");
	for (const c of ranked.slice(0, 14)) {
		const tag = keyScoped.has(c.model.slug) ? "have " : "ADD  ";
		console.log(
			`  ${tag} ${c.model.slug.padEnd(38)} ${String(c.qualityScore).padEnd(5)} ${(c.model.price.prompt * 1e6).toFixed(2).padStart(7)}  ${c.model.contextLength}`,
		);
	}
}
