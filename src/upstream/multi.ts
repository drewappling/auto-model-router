/**
 * One `UpstreamClient` over several providers, keyed by catalog slug prefix.
 *
 * `ollama/…` slugs go to the Ollama client; everything else is OpenRouter.
 * Catalog fetches and the adjudicator's `complete` stay on OpenRouter, whose
 * catalog is the router's baseline; Ollama's own listing is read by its
 * catalog source, not through this seam.
 */

import { isOllamaSlug } from "../catalog/ollama-catalog.ts";
import type { Dispatch, DispatchOptions, UpstreamClient } from "./types.ts";

export function createMultiUpstream(openrouter: UpstreamClient, ollama: UpstreamClient): UpstreamClient {
	return {
		dispatch(opts: DispatchOptions): Promise<Dispatch> {
			const model = opts.body.model;
			return typeof model === "string" && isOllamaSlug(model) ? ollama.dispatch(opts) : openrouter.dispatch(opts);
		},
		complete(body, signal) {
			const model = body.model;
			return typeof model === "string" && isOllamaSlug(model) ? ollama.complete(body, signal) : openrouter.complete(body, signal);
		},
		fetchModels: (signal) => openrouter.fetchModels(signal),
		fetchModelsForUser: (signal) => openrouter.fetchModelsForUser(signal),
	};
}
