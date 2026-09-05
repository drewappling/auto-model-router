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
 */

import type { OllamaAvailability } from "../upstream/ollama.ts";
import { mergeSnapshots, type OllamaCatalogSource } from "./ollama-catalog.ts";
import type { CatalogModel, CatalogShrink, CatalogSnapshot, CatalogSource } from "./types.ts";

export function createCompositeCatalog(
	openrouter: CatalogSource,
	ollama: OllamaCatalogSource,
	availability: OllamaAvailability,
): CatalogSource & { ollamaModels(): CatalogModel[] } {
	let lastBase: CatalogSnapshot | null = null;
	let lastOllama: readonly CatalogModel[] = [];
	let lastAvailable = true;
	let merged: CatalogSnapshot | null = null;

	function combine(base: CatalogSnapshot, models: readonly CatalogModel[]): CatalogSnapshot {
		const available = availability.available();
		if (merged !== null && base === lastBase && models === lastOllama && available === lastAvailable) return merged;
		lastBase = base;
		lastOllama = models;
		lastAvailable = available;
		merged = mergeSnapshots(base, available ? models : []);
		return merged;
	}

	function find(slug: string): CatalogModel | undefined {
		const fromBase = openrouter.find(slug);
		if (fromBase !== undefined) return fromBase;
		for (const m of lastOllama) if (m.slug === slug) return m;
		for (const m of ollama.peek()) if (m.slug === slug) return m;
		return undefined;
	}

	return {
		async get(): Promise<CatalogSnapshot> {
			const base = await openrouter.get();
			const models = await ollama.get(base.models);
			return combine(base, models);
		},
		async refresh(): Promise<CatalogSnapshot> {
			const base = await openrouter.refresh();
			ollama.invalidate();
			const models = await ollama.get(base.models);
			return combine(base, models);
		},
		peek(): CatalogSnapshot | null {
			const base = openrouter.peek();
			if (base === null) return null;
			return combine(base, ollama.peek());
		},
		find,
		lastShrink(): CatalogShrink | null {
			return openrouter.lastShrink?.() ?? null;
		},
		ollamaModels(): CatalogModel[] {
			return [...ollama.peek()];
		},
	};
}
