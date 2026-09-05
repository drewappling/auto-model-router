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
import { createOpenRouterClient } from "../upstream/openrouter.ts";
import type { UpstreamClient } from "../upstream/types.ts";
import { createLogger, type Logger } from "../util/log.ts";

export interface Providers {
	upstream: UpstreamClient;
	catalog: CatalogSource & { ollamaModels?(): unknown[] };
	/** Non-null when Ollama Cloud is enabled; carries the circuit breaker. */
	ollama: OllamaClient | null;
}

export function createProviders(cfg: RouterConfig, db: Database, log: Logger = createLogger(cfg.logLevel)): Providers {
	const openrouter = createOpenRouterClient(cfg);
	const openrouterCatalog = createCatalog(cfg, openrouter, db);
	if (!cfg.ollama.enabled) return { upstream: openrouter, catalog: openrouterCatalog, ollama: null };
	// Ollama Cloud is a second upstream ranked in the same catalog: `ollama/…`
	// slugs dispatch to it, everything else to OpenRouter.
	const ollama = createOllamaClient(cfg);
	return {
		upstream: createMultiUpstream(openrouter, ollama),
		catalog: createCompositeCatalog(openrouterCatalog, createOllamaCatalog(cfg.ollama, log), ollama),
		ollama,
	};
}
