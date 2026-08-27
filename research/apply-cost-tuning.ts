/**
 * Applies the cost-optimization config changes to the PRODUCTION router config
 * (`~/.auto-model-router/config.yml`), merged + validated + backed up. Never
 * prints the AA key.
 *
 *   bun run research/apply-cost-tuning.ts          # SAFE NOW: disable the dead
 *                                                  # adjudicator only (routing-neutral).
 *   bun run research/apply-cost-tuning.ts --full   # WINDOW-CLOSE: also raise
 *                                                  # switchMargin and lower contextWindow
 *                                                  # (these CHANGE live routing).
 *
 * See [[omp-router-cost-optimization]]. Restart all omp windows after applying.
 */

import { chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The fork's .env points AUTO_MODEL_ROUTER_HOME at research-data/home; these
// changes must land in the PRODUCTION config the live routers read.
process.env.AUTO_MODEL_ROUTER_HOME = join(homedir(), ".auto-model-router");

import { routerConfigPath, writeRouterConfig } from "../src/cli/config-cmd.ts";
import { loadConfig } from "../src/config/load.ts";

const full = process.argv.includes("--full");
const cfg = loadConfig({});

// (3) Disable the broken adjudicator: classifier.model is absent from the catalog,
// so it never returns a verdict — always keeps the heuristic. Setting the
// threshold to 0 skips the doomed call. Routing-identical, just faster.
const patch: Record<string, unknown> = { classifier: { ambiguityThreshold: 0 } };

if (full) {
	// (2) Stop forfeiting warm cache for tiny completion savings.
	patch.hysteresis = { switchMargin: 4 };
	// (1) Force earlier compaction by advertising a smaller context window.
	// Preserve every other profile field; only contextWindow changes.
	patch.profiles = cfg.profiles.map((p) => ({
		id: p.id,
		name: p.name,
		minTier: p.minTier,
		maxTier: p.maxTier,
		contextWindow: 200_000,
		maxTokens: p.maxTokens,
	}));
	// (4) Cap the input-dominated hard cost. Now SAFE: the key admits ~13 hard
	// candidates, so a $3/Mtok ceiling still leaves gpt-5.6-sol (77.4), grok-4.6,
	// gpt-5.6-terra, glm-5.3, qwen3.8, kimi-k3 with failover; it drops only the
	// $5-10 models (opus-5, gpt-5.5, fable). Raise to ~$5 if you want opus-5
	// available for the very hardest turns. Merges into hard, preserving its floor.
	patch.tiers = { hard: { maxInputPerMtok: 3 } };
}

const target = routerConfigPath();
const backup = writeRouterConfig(target, patch);
try {
	chmodSync(target, 0o600); // keep the AA-key-bearing file locked down (advisory on Windows)
} catch {
	/* best-effort */
}

const after = loadConfig({});
console.log(`wrote ${target}${backup === null ? "" : `\nbackup ${backup}`}`);
console.log(`mode                     ${full ? "FULL (routing-changing)" : "adjudicator-only (safe)"}`);
console.log(`classifier.ambiguity     ${after.classifier.ambiguityThreshold}`);
console.log(`hysteresis.switchMargin  ${after.hysteresis.switchMargin}`);
console.log(`profiles contextWindow   ${after.profiles.map((p) => `${p.id}:${p.contextWindow}`).join(" ")}`);
// Confirm nothing unrelated was disturbed.
const k = after.benchmarks.artificialAnalysisApiKey;
console.log(`AA key intact            ${k.trim() === "" ? "MISSING" : `yes (…${k.slice(-4)})`}`);
console.log(`exploration intact       enabled=${after.exploration.enabled} holdArms=[${after.exploration.holdTurns.values.join(",")}] sticky=${after.exploration.stickyPolicy}`);
console.log("\nrestart all omp windows for this to take effect.");
