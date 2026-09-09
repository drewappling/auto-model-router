/**
 * One `UpstreamClient` over several providers, keyed by catalog slug prefix.
 *
 * `ollama/…` slugs go to the Ollama client, `<id>/…` to the named upstream
 * with that id, everything else to OpenRouter. Catalog fetches and the
 * adjudicator's `complete` stay on OpenRouter, whose catalog is the router's
 * baseline; the other catalogs are read by their own sources, not through
 * this seam.
 */

import { isOllamaSlug } from "../catalog/ollama-catalog.ts";
import type { Dispatch, DispatchOptions, UpstreamClient } from "./types.ts";

/** The named upstream a slug belongs to, by its first segment; null for OpenRouter's own. */
export function namedUpstreamOf(slug: string, ids: Iterable<string>): string | null {
	const cut = slug.indexOf("/");
	if (cut <= 0) return null;
	const head = slug.slice(0, cut);
	for (const id of ids) if (id === head) return id;
	return null;
}

export function createMultiUpstream(openrouter: UpstreamClient, ollama: UpstreamClient, named: (id: string) => UpstreamClient | undefined = () => undefined, ids: () => Iterable<string> = () => []): UpstreamClient {
	const pick = (model: unknown): UpstreamClient => {
		if (typeof model !== "string") return openrouter;
		if (isOllamaSlug(model)) return ollama;
		const id = namedUpstreamOf(model, ids());
		return (id === null ? undefined : named(id)) ?? openrouter;
	};
	return {
		dispatch(opts: DispatchOptions): Promise<Dispatch> {
			return pick(opts.body.model).dispatch(opts);
		},
		complete(body, signal) {
			return pick(body.model).complete(body, signal);
		},
		fetchModels: (signal) => openrouter.fetchModels(signal),
		fetchModelsForUser: (signal) => openrouter.fetchModelsForUser(signal),
	};
}
