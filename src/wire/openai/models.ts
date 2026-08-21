import type { RouterConfig } from "../../config/types.ts";
import type { BlendedRate } from "../../cost/types.ts";

/**
 * Virtual profiles have no real creation date; a pinned constant keeps
 * /v1/models output stable for client caches.
 */
const PROFILES_CREATED = 1767225600; // 2026-01-01T00:00:00Z

export function renderModelList(cfg: RouterConfig, blend: BlendedRate | null): unknown {
	const inputPerMtok = blend ? blend.inputPerMtok : cfg.ledger.fallbackBlend.inputPerMtok;
	const outputPerMtok = blend ? blend.outputPerMtok : cfg.ledger.fallbackBlend.outputPerMtok;
	return {
		object: "list",
		data: cfg.profiles.map((p) => {
			// OpenRouter-style per-token price strings, converted from our
			// per-million-token internal representation.
			const pricing: Record<string, string> = {
				prompt: String(inputPerMtok / 1e6),
				completion: String(outputPerMtok / 1e6),
			};
			if (blend) {
				pricing.input_cache_read = String(blend.cacheReadPerMtok / 1e6);
				pricing.input_cache_write = String(blend.cacheWritePerMtok / 1e6);
			}
			return {
				id: p.id,
				object: "model",
				created: PROFILES_CREATED,
				owned_by: "omp-router",
				name: p.name,
				context_length: p.contextWindow,
				pricing,
			};
		}),
	};
}
