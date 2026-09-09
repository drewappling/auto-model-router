/**
 * Catalog models for the named upstreams in `upstreams: []`.
 *
 * A direct provider publishes no routing catalog the way OpenRouter does, so
 * each entry names its models with prices (USD per million tokens) and what
 * routing needs to know. Quality scores come from the entry when given,
 * otherwise from the OpenRouter twin of the same model (`twin` names it, or
 * the normalised name finds it), so a direct `gpt-4o` ranks like OpenRouter's
 * `openai/gpt-4o` rather than as an unscored model stuck in the trivial tier.
 */

import type { RouterConfig, UpstreamEntry, UpstreamModelConfig } from "../config/types.ts";
import type { Logger } from "../util/log.ts";
import { normalizeModelKey } from "./benchmark-feeds.ts";
import { twinIndex } from "./ollama-catalog.ts";
import type { CatalogModel, Modality } from "./types.ts";

function tokenizerFor(kind: UpstreamEntry["kind"], twin: CatalogModel | null): string {
	if (twin !== null) return twin.tokenizer;
	return kind === "anthropic" ? "Claude" : kind === "openai" || kind === "azure" ? "GPT" : "Other";
}

/** One entry's models as catalog models. Pure. */
export function buildUpstreamModels(entry: UpstreamEntry, openrouter: readonly CatalogModel[]): CatalogModel[] {
	const twins = twinIndex(openrouter);
	const bySlug = new Map(openrouter.map((m) => [m.slug, m] as const));
	const out: CatalogModel[] = [];
	for (const m of entry.models) {
		const twin = (m.twin !== undefined ? bySlug.get(m.twin) : undefined) ?? twins.get(normalizeModelKey(m.id)) ?? null;
		const modalities: Modality[] = ["text"];
		if (m.vision ?? twin?.inputModalities.includes("image") ?? false) modalities.push("image");
		const price: CatalogModel["price"] = { prompt: m.input / 1e6, completion: m.output / 1e6 };
		if (m.cachedInput !== undefined) price.cacheRead = m.cachedInput / 1e6;
		if (m.cacheWrite !== undefined) price.cacheWrite = m.cacheWrite / 1e6;
		const model: CatalogModel = {
			slug: `${entry.id}/${m.id}`,
			canonicalSlug: `${entry.id}/${m.id}`,
			name: `${m.name ?? m.id} (${entry.id})`,
			provider: entry.id,
			contextLength: m.contextLength ?? twin?.contextLength ?? 128_000,
			supportsTools: m.supportsTools ?? twin?.supportsTools ?? true,
			supportsReasoning: m.supportsReasoning ?? twin?.supportsReasoning ?? false,
			reasoningMandatory: twin?.reasoningMandatory ?? false,
			supportsToolChoice: m.supportsToolChoice ?? true,
			inputModalities: modalities,
			price,
			priceTiers: [],
			quality: m.quality !== undefined ? { ...m.quality } : twin === null ? {} : { ...twin.quality },
			tokenizer: tokenizerFor(entry.kind, twin),
			isFree: m.input === 0 && m.output === 0,
			createdAtMs: twin?.createdAtMs ?? 0,
			author: entry.id,
		};
		const maxOut = m.maxCompletionTokens ?? twin?.maxCompletionTokens;
		if (maxOut !== undefined) model.maxCompletionTokens = maxOut;
		out.push(model);
	}
	return out;
}

export interface StaticCatalogSource {
	/** Models of every enabled entry, rebuilt when the entries or the OpenRouter models change. */
	get(openrouter: readonly CatalogModel[]): CatalogModel[];
	/** The last built set. */
	peek(): CatalogModel[];
}

/** Memoised over the live `cfg.upstreams` array (replaced wholesale on a change) and the OpenRouter models. */
export function createStaticCatalogSource(cfg: RouterConfig, log?: Logger): StaticCatalogSource {
	let lastEntries: readonly UpstreamEntry[] | null = null;
	let lastBase: readonly CatalogModel[] | null = null;
	let built: CatalogModel[] = [];
	return {
		get(openrouter) {
			if (cfg.upstreams === lastEntries && openrouter === lastBase) return built;
			lastEntries = cfg.upstreams;
			lastBase = openrouter;
			built = cfg.upstreams.filter((u) => u.enabled).flatMap((u) => buildUpstreamModels(u, openrouter));
			if (built.length > 0) log?.debug("named upstream models built", { models: built.length, upstreams: cfg.upstreams.filter((u) => u.enabled).map((u) => u.id).join(", ") });
			return built;
		},
		peek: () => built,
	};
}

/** The published model that an entry names, for clients that need its limits. */
export function upstreamModel(entry: UpstreamEntry, modelId: string): UpstreamModelConfig | undefined {
	return entry.models.find((m) => m.id === modelId);
}
