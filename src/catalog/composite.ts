/**
 * A `CatalogSource` that presents OpenRouter's catalog and Ollama Cloud's as
 * one snapshot, so selection ranks them together.
 *
 * The merged snapshot object is reused until either side actually changes,
 * because `tierPlanFor` memoises per snapshot identity and a fresh object per
 * turn would recompute the tier plan every turn for nothing.
 *
 * While the Ollama breaker is open (plan quota or concurrency limit hit), the
 * Ollama models are left out entirely: a candidate that will 402 or 429 is
 * not a candidate, and hiding it here means the turn routes straight to an
 * OpenRouter model instead of paying a doomed dispatch first.
 *
 * The same rule covers OpenRouter: without a key its models cannot be
 * dispatched (its catalog is public, so they would still be listed), and
 * `serveOpenRouter` leaves them out so an Ollama-only deployment routes over
 * Ollama Cloud alone instead of picking models that 401 at dispatch time. The
 * OpenRouter catalog is still fetched: Ollama's models borrow their twins'
 * benchmarks and capabilities from it.
 */

import type { OllamaAvailability } from "../upstream/ollama.ts";
import { effectiveOllamaBias, NO_USAGE, type OllamaUsageSource } from "../upstream/ollama-usage.ts";
import { mergeSnapshots, type OllamaCatalogSource } from "./ollama-catalog.ts";
import type { CatalogModel, CatalogShrink, CatalogSnapshot, CatalogSource } from "./types.ts";

export interface CompositeBias {
	/** Static multiplier from config. */
	costBias: number;
	/** Plan usage fraction at which the bias switches off (list price). */
	biasUntilUsage: number;
	usage: OllamaUsageSource;
	/** When given, read on every use instead of the static pair, so a config hot reload applies. */
	live?: () => { costBias: number; biasUntilUsage: number };
	/** False when OpenRouter cannot dispatch (no key): its models are listed for metadata only, never served. Default true. */
	serveOpenRouter?: () => boolean;
	/** Named upstreams' models, built from the OpenRouter models (twins) and filtered by each upstream's breaker. */
	named?: {
		models(openrouter: readonly CatalogModel[]): readonly CatalogModel[];
		serving(id: string): boolean;
		/** That upstream's `costBias`, so prepaid capacity ranks below list price. 1 when it has none. */
		bias?(id: string): number;
	};
}

/** Shared empty list, so a deployment without named upstreams keeps the merged snapshot's identity. */
const NO_NAMED: readonly CatalogModel[] = [];

export function createCompositeCatalog(
	openrouter: CatalogSource,
	ollama: OllamaCatalogSource,
	availability: OllamaAvailability,
	bias: CompositeBias = { costBias: 1, biasUntilUsage: 1, usage: NO_USAGE },
): CatalogSource & { ollamaModels(): CatalogModel[]; ollamaBias(): number; peekAll(): CatalogSnapshot | null } {
	let lastBase: CatalogSnapshot | null = null;
	let lastOllama: readonly CatalogModel[] = [];
	let lastAvailable = true;
	let lastServeBase = true;
	let lastBias = 1;
	let lastNamed: readonly CatalogModel[] = [];
	let lastNamedServing = "";
	let merged: CatalogSnapshot | null = null;

	/** The multiplier in force from the latest usage reading (no network). */
	function currentBias(): number {
		const b = bias.live?.() ?? bias;
		return effectiveOllamaBias(b.costBias, b.biasUntilUsage, bias.usage.peek());
	}

	function combine(base: CatalogSnapshot, models: readonly CatalogModel[]): CatalogSnapshot {
		const available = availability.available();
		const serveBase = bias.serveOpenRouter?.() ?? true;
		const providerBias = currentBias();
		// Named upstreams: every enabled entry's models, minus those of an upstream in cooldown.
		const namedAll = bias.named?.models(base.models) ?? NO_NAMED;
		const namedServing = namedAll.map((m) => (bias.named?.serving(m.provider) ?? true ? "1" : "0")).join("");
		if (merged !== null && base === lastBase && models === lastOllama && available === lastAvailable && serveBase === lastServeBase && providerBias === lastBias && namedAll === lastNamed && namedServing === lastNamedServing) return merged;
		lastBase = base;
		lastOllama = models;
		lastAvailable = available;
		lastServeBase = serveBase;
		lastBias = providerBias;
		lastNamed = namedAll;
		lastNamedServing = namedServing;
		const named = namedAll.filter((m) => bias.named?.serving(m.provider) ?? true);
		merged = serveBase ? mergeSnapshots(base, available ? models : []) : { ...base, models: available ? [...models] : [] };
		if (named.length > 0) merged = { ...merged, models: [...merged.models, ...named] };
		// A fresh object either way once anything changed; stamp the live bias so
		// candidate scoring reads it off the snapshot it is ranking. Each named upstream
		// adds its own, so prepaid capacity ranks below list price without being free.
		const biases: Record<string, number> = { ollama: providerBias };
		for (const m of named) {
			const b = bias.named?.bias?.(m.provider) ?? 1;
			if (b !== 1) biases[m.provider] = b;
		}
		merged = { ...merged, providerBias: biases };
		return merged;
	}

	function find(slug: string): CatalogModel | undefined {
		const fromBase = openrouter.find(slug);
		if (fromBase !== undefined) return fromBase;
		for (const m of lastOllama) if (m.slug === slug) return m;
		for (const m of ollama.peek()) if (m.slug === slug) return m;
		for (const m of lastNamed) if (m.slug === slug) return m;
		return undefined;
	}

	return {
		async get(): Promise<CatalogSnapshot> {
			const base = await openrouter.get();
			// Nothing to fetch while Ollama cannot serve (off, or its breaker open).
			const models = availability.available() ? await ollama.get(base.models) : ollama.peek();
			// Refreshes on its own poll interval; a cached reading returns at once.
			await bias.usage.get();
			return combine(base, models);
		},
		async refresh(): Promise<CatalogSnapshot> {
			const base = await openrouter.refresh();
			ollama.invalidate();
			const models = availability.available() ? await ollama.get(base.models) : ollama.peek();
			await bias.usage.get();
			return combine(base, models);
		},
		ollamaBias: currentBias,
		peek(): CatalogSnapshot | null {
			const base = openrouter.peek();
			if (base === null) return null;
			return combine(base, ollama.peek());
		},
		find,
		/**
		 * Every model the catalog knows, whether or not its upstream can take a
		 * turn now: OpenRouter's without a key, Ollama's in cooldown, a named
		 * upstream's in cooldown. `peek()` is what routes; this is what a front
		 * door lists so it can say why a model is out. No network.
		 */
		peekAll(): CatalogSnapshot | null {
			const base = openrouter.peek();
			if (base === null) return null;
			return { ...base, models: [...base.models, ...ollama.peek(), ...(bias.named?.models(base.models) ?? NO_NAMED)] };
		},
		lastShrink(): CatalogShrink | null {
			return openrouter.lastShrink?.() ?? null;
		},
		ollamaModels(): CatalogModel[] {
			return [...ollama.peek()];
		},
	};
}
