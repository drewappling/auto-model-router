/**
 * Upstream + catalog assembly shared by the server and the CLIs, so `models`
 * and `explain` see exactly the catalog a turn would route over — including
 * Ollama Cloud when it is enabled.
 */

import type { Database } from "bun:sqlite";
import { createCompositeCatalog } from "../catalog/composite.ts";
import { createOllamaCatalog } from "../catalog/ollama-catalog.ts";
import { createCatalog } from "../catalog/openrouter-catalog.ts";
import type { CatalogSource } from "../catalog/types.ts";
import type { RouterConfig } from "../config/types.ts";
import { createMultiUpstream } from "../upstream/multi.ts";
import { createOllamaClient, type OllamaClient } from "../upstream/ollama.ts";
import { createLedger } from "../cost/ledger.ts";
import { createOllamaUsageSource, NO_USAGE, type OllamaUsageSource } from "../upstream/ollama-usage.ts";
import { createOpenRouterClient } from "../upstream/openrouter.ts";
import type { UpstreamClient } from "../upstream/types.ts";
import { createLogger, type Logger } from "../util/log.ts";

export interface Providers {
	upstream: UpstreamClient;
	catalog: CatalogSource & { ollamaModels?(): unknown[]; ollamaBias?(): number };
	/** Non-null when Ollama Cloud is enabled; carries the circuit breaker. */
	ollama: OllamaClient | null;
	/** Plan usage reader; inert without a key. */
	ollamaUsage: OllamaUsageSource;
	/** Multiplier that brings the ledger's Ollama estimate in line with the plan meter; 1 until calibrated. */
	ollamaCostScale: () => number;
}

export function createProviders(cfg: RouterConfig, db: Database, log: Logger = createLogger(cfg.logLevel)): Providers {
	const openrouter = createOpenRouterClient(cfg);
	const openrouterCatalog = createCatalog(cfg, openrouter, db);
	if (!cfg.ollama.enabled) return { upstream: openrouter, catalog: openrouterCatalog, ollama: null, ollamaUsage: NO_USAGE, ollamaCostScale: () => 1 };
	// Ollama Cloud is a second upstream ranked in the same catalog: `ollama/…`
	// slugs dispatch to it, everything else to OpenRouter.
	const ollama = createOllamaClient(cfg);
	// Plan usage lives on ollama.com whichever base URL dispatches; it needs the
	// key, so the daemon path without `/login ollama-cloud` keeps a static bias.
	const ledgerForCalibration = createLedger(db, cfg);
	const ollamaUsage = createOllamaUsageSource({
		apiKey: cfg.ollama.apiKey,
		pollMs: cfg.ollama.usagePollMs,
		timeoutMs: Math.min(cfg.ollama.timeoutMs, 15_000),
		log,
		// Each poll records the meter beside the ledger's Ollama total, so the
		// estimate can be scaled to what ollama.com actually bills.
		calibration: { db, ledgerUsd: () => ledgerForCalibration.providerSpendSince?.("ollama/", 0) ?? 0, planCreditsOverrideUsd: cfg.ollama.planCreditsUsd },
	});
	return {
		upstream: createMultiUpstream(openrouter, ollama),
		catalog: createCompositeCatalog(openrouterCatalog, createOllamaCatalog(cfg.ollama, log, fetch, db), ollama, {
			costBias: cfg.ollama.costBias,
			biasUntilUsage: cfg.ollama.biasUntilUsage,
			usage: ollamaUsage,
		}),
		ollama,
		ollamaUsage,
		ollamaCostScale: () => ollamaUsage.calibration()?.factor ?? 1,
	};
}
