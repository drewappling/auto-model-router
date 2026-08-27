/**
 * Reports how many candidates each tier actually has, from the live cached
 * catalog.
 *
 * The exploration plan assumes `hard` turns exist and have somewhere cheaper
 * to land. If a narrow OpenRouter key-scoping leaves upper tiers empty, or
 * only a handful of models carry benchmark scores, exploration cannot yield
 * what the projection promised. This checks that rather than assuming it.
 *
 * Usage: bun run research/tier-fill.ts [path-to-router.db]
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { normalizeCatalogModel } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot } from "../src/catalog/types.ts";
import { loadConfig } from "../src/config/load.ts";
import { scoreHeuristic } from "../src/router/classify.ts";
import { extractFeatures } from "../src/router/features.ts";
import { select } from "../src/router/select.ts";
import type { ConversationState, Tier } from "../src/router/types.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";

const dbPath = process.argv[2] ?? join(homedir(), ".auto-model-router", "router.db");
const db = new Database(dbPath, { readonly: true });
const row = db.query("SELECT payload FROM catalog_cache WHERE id = 1").get() as { payload: string } | null;
db.close();

if (row === null) {
	console.log("no cached catalog in " + dbPath);
	process.exit(0);
}

const models: CatalogModel[] = (JSON.parse(row.payload) as unknown[])
	.map(normalizeCatalogModel)
	.filter((m): m is CatalogModel => m !== null);

const snapshot: CatalogSnapshot = { models, fetchedAtMs: Date.now() };
const cfg = loadConfig({});

console.log(`catalog: ${models.length} models`);
console.log(`adaptiveTierFloors: ${cfg.adaptiveTierFloors}`);
console.log("");

const req = parseChatRequest(
	{
		model: "auto",
		messages: [
			{ role: "system", content: "You are a coding agent." },
			{ role: "user", content: "refactor the retry helper and explain the race condition" },
		],
	},
	new Headers(),
);
const features = extractFeatures(req, 4000);
const heuristic = scoreHeuristic(features, cfg);

const state: ConversationState = {
	key: "tier-fill-probe",
	sessionId: "probe",
	turn: 1,
	currentSlug: null,
	currentTier: null,
	stickyUntilTurn: 0,
	escalations: 0,
	spentUsd: 0,
	lastPromptTokens: 0,
	cacheWarmSlug: null,
	cacheWarmAtMs: 0,
	updatedAtMs: Date.now(),
};

const profile = cfg.profiles.find((p) => p.id === "auto") ?? cfg.profiles[0];
if (profile === undefined) {
	console.log("no profiles configured");
	process.exit(1);
}

console.log("tier      candidates  chosen                          note");
for (const tier of ["trivial", "simple", "moderate", "hard"] as Tier[]) {
	try {
		const d = select({
			req,
			features,
			classification: { ...heuristic, tier },
			profile,
			state,
			snapshot,
			ledger: null,
			cfg,
			nowMs: Date.now(),
		});
		// A widened decision means the requested tier had nothing of its own.
		const widened = d.reasons.find((r) => r.startsWith("widened"));
		console.log(
			"  " +
				tier.padEnd(10) +
				String(d.considered.length).padStart(10) +
				"  " +
				d.slug.padEnd(32) +
				(widened ?? ""),
		);
	} catch (err) {
		console.log("  " + tier.padEnd(10) + "  ERROR: " + (err instanceof Error ? err.message : String(err)));
	}
}
