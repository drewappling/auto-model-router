/**
 * Upstream + catalog assembly shared by the server and the CLIs, so `models`
 * and `explain` see exactly the catalog a turn would route over — including
 * Ollama Cloud when it is enabled.
 */

import type { Database } from "bun:sqlite";
import { createCompositeCatalog } from "../catalog/composite.ts";
import { createStaticCatalogSource } from "../catalog/static-catalog.ts";
import { createAnthropicClient } from "../upstream/anthropic.ts";
import { createCompatClient, type NamedUpstreamClient } from "../upstream/compat.ts";
import { createOllamaCatalog } from "../catalog/ollama-catalog.ts";
import { createCatalog } from "../catalog/openrouter-catalog.ts";
import type { CatalogSource } from "../catalog/types.ts";
import type { RouterConfig } from "../config/types.ts";
import { createMultiUpstream } from "../upstream/multi.ts";
import { createOllamaClient, type OllamaClient } from "../upstream/ollama.ts";
import { createLedger } from "../cost/ledger.ts";
import { setKnownUpstreamIds } from "../cost/report.ts";
import { createOllamaUsageSource, type OllamaUsageSource } from "../upstream/ollama-usage.ts";
import { createOpenRouterClient } from "../upstream/openrouter.ts";
import type { UpstreamClient } from "../upstream/types.ts";
import { createLogger, type Logger } from "../util/log.ts";

export interface Providers {
	upstream: UpstreamClient;
	catalog: CatalogSource & { ollamaModels?(): unknown[]; ollamaBias?(): number };
	/** Always present: it carries the circuit breaker. Whether it SERVES follows `cfg.ollama.enabled`. */
	ollama: OllamaClient;
	/** True while Ollama Cloud is enabled and out of cooldown, read live. */
	ollamaServing(): boolean;
	/** Plan usage reader; inert without a key. */
	ollamaUsage: OllamaUsageSource;
	/** Multiplier that brings the ledger's Ollama estimate in line with the plan meter; 1 until calibrated. */
	ollamaCostScale: () => number;
	/** The client for a named upstream id, built on first use; undefined for an id not configured. */
	named(id: string): NamedUpstreamClient | undefined;
	/** Ids of the named upstreams that can take a turn now: enabled, keyed, out of cooldown. */
	namedServing(): string[];
}

export function createProviders(cfg: RouterConfig, db: Database, log: Logger = createLogger(cfg.logLevel)): Providers {
	const openrouter = createOpenRouterClient(cfg);
	const openrouterCatalog = createCatalog(cfg, openrouter, db);
	// Ollama Cloud is a second upstream ranked in the same catalog: `ollama/…`
	// slugs dispatch to it, everything else to OpenRouter. It is always built, and
	// `ollama.enabled` decides per call whether it serves — so turning it on or off
	// in a running router is a config change, not a restart. Nothing is fetched
	// from it while it is off.
	const ollama = createOllamaClient(cfg);
	const ollamaServing = (): boolean => cfg.ollama.enabled && ollama.available();
	// Plan usage lives on ollama.com whichever base URL dispatches; it needs the
	// key, so the daemon path without `/login ollama-cloud` keeps a static bias.
	const ledgerForCalibration = createLedger(db, cfg);
	const ollamaUsage = createOllamaUsageSource({
		apiKey: () => cfg.ollama.apiKey,
		pollMs: cfg.ollama.usagePollMs,
		timeoutMs: Math.min(cfg.ollama.timeoutMs, 15_000),
		log,
		// Each poll records the meter beside the ledger's Ollama total, so the
		// estimate can be scaled to what ollama.com actually bills.
		calibration: { db, ledgerUsd: () => ledgerForCalibration.providerSpendSince?.("ollama/", 0) ?? 0, planCreditsOverrideUsd: cfg.ollama.planCreditsUsd },
	});
	// Named upstreams (OpenAI, Azure, Anthropic, vLLM…): a client per id, built when
	// first needed and kept — its breaker state must survive config reloads — while
	// the entry it reads is looked up live, so a changed key or URL applies at once.
	const namedClients = new Map<string, NamedUpstreamClient>();
	const named = (id: string): NamedUpstreamClient | undefined => {
		const entry = cfg.upstreams.find((u) => u.id === id);
		if (entry === undefined) return undefined;
		let client = namedClients.get(id);
		if (client === undefined) {
			client = entry.kind === "anthropic" ? createAnthropicClient(cfg, id) : createCompatClient(cfg, id);
			namedClients.set(id, client);
		}
		return client;
	};
	const namedServingOne = (id: string): boolean => {
		const entry = cfg.upstreams.find((u) => u.id === id);
		if (entry === undefined || !entry.enabled || entry.apiKey === "" && entry.kind !== "openai") return entry !== undefined && entry.enabled && (named(id)?.available() ?? false);
		return named(id)?.available() ?? false;
	};
	const namedServing = (): string[] => cfg.upstreams.filter((u) => u.enabled && namedServingOne(u.id)).map((u) => u.id);
	const staticCatalog = createStaticCatalogSource(cfg, log);
	setKnownUpstreamIds(cfg.upstreams.map((u) => u.id));
	return {
		upstream: createMultiUpstream(openrouter, ollama, named, () => cfg.upstreams.map((u) => u.id)),
		catalog: createCompositeCatalog(openrouterCatalog, createOllamaCatalog(cfg.ollama, log, fetch, db), { available: ollamaServing, cooldownUntilMs: () => ollama.cooldownUntilMs(), lastTrip: () => ollama.lastTrip() }, {
			costBias: cfg.ollama.costBias,
			biasUntilUsage: cfg.ollama.biasUntilUsage,
			usage: ollamaUsage,
			live: () => ({ costBias: cfg.ollama.costBias, biasUntilUsage: cfg.ollama.biasUntilUsage }),
			serveOpenRouter: () => cfg.openrouter.apiKey !== "",
			named: { models: (base) => staticCatalog.get(base), serving: namedServingOne },
		}),
		ollama,
		ollamaServing,
		ollamaUsage,
		ollamaCostScale: () => ollamaUsage.calibration()?.factor ?? 1,
		named,
		namedServing,
	};
}
