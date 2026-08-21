/**
 * Normalized view of the OpenRouter model catalog.
 *
 * Source of truth: `GET https://openrouter.ai/api/v1/models` (public, no auth).
 * Everything here is derived from that payload; nothing is hand-curated.
 */

/** USD **per token** (OpenRouter reports per-token decimal strings). */
export interface Price {
	/** Uncached prompt tokens. */
	prompt: number;
	/** Completion tokens. */
	completion: number;
	/** Prompt tokens served from cache. Absent ⇒ no cache-read discount published. */
	cacheRead?: number;
	/** Prompt tokens written to cache. Absent ⇒ writes are free or unpublished. */
	cacheWrite?: number;
	/** Internal reasoning tokens billed separately from completion. */
	reasoning?: number;
	/** Per-image surcharge (USD per image, not per token). */
	image?: number;
	/** Flat per-request surcharge (USD). */
	request?: number;
}

/**
 * A long-context pricing tier from `pricing.overrides[]`.
 *
 * Anthropic and Google roughly double their rates above a prompt-token
 * threshold (Sonnet 4.5: 2x above 200k). Ignoring these silently understates
 * long-conversation cost by ~50%, which is exactly when routing matters most.
 */
export interface PriceTier {
	/** Tier applies when prompt tokens >= this value. */
	minPromptTokens: number;
	price: Price;
}

export type Modality = "text" | "image" | "file" | "audio";

/** Quality axes lifted from `benchmarks.artificial_analysis`. 0-100 scale, may be absent. */
export interface QualityScores {
	intelligence?: number;
	coding?: number;
	agentic?: number;
}

export interface CatalogModel {
	/** OpenRouter slug, e.g. `anthropic/claude-sonnet-4.5`. Routing identity. */
	slug: string;
	/** Immutable dated slug, e.g. `anthropic/claude-4.5-sonnet-20250929`. */
	canonicalSlug: string;
	name: string;
	/** Max total context in tokens. */
	contextLength: number;
	/** `top_provider.max_completion_tokens`; absent ⇒ unpublished. */
	maxCompletionTokens?: number;
	/** `supported_parameters` includes `tools`. Hard filter for agent traffic. */
	supportsTools: boolean;
	/** `supported_parameters` includes `reasoning` or `include_reasoning`. */
	supportsReasoning: boolean;
	/** `reasoning.mandatory` — cannot be disabled, so reasoning tokens always bill. */
	reasoningMandatory: boolean;
	/** `supported_parameters` includes `tool_choice`. */
	supportsToolChoice: boolean;
	inputModalities: Modality[];
	/** Base pricing tier (prompt tokens below every override threshold). */
	price: Price;
	/** Override tiers, ascending by `minPromptTokens`. Empty for flat-priced models. */
	priceTiers: PriceTier[];
	quality: QualityScores;
	/** `architecture.tokenizer`, e.g. `Claude`, `GPT`, `Gemini`. Keys token-estimate calibration. */
	tokenizer: string;
	/** Every published price component is zero. */
	isFree: boolean;
	/** `created` as epoch ms; recency is a weak quality prior for unbenchmarked models. */
	createdAtMs: number;
	/** Provider namespace, i.e. the slug segment before `/`. */
	author: string;
}

export interface CatalogSnapshot {
	models: CatalogModel[];
	/** When this snapshot was fetched. */
	fetchedAtMs: number;
	/**
	 * True when the snapshot was fetched via key-scoped `GET /models/user`.
	 * False when fetched from the public `GET /models` endpoint.
	 */
	keyScoped?: boolean;
	/** Upstream ETag, when served. */
	etag?: string;
}

export interface CatalogSource {
	/** Returns a snapshot, refreshing from upstream when the cached one is older than the TTL. */
	get(): Promise<CatalogSnapshot>;
	/** Forces an upstream refresh, ignoring TTL. */
	refresh(): Promise<CatalogSnapshot>;
	/** Cached snapshot without touching the network. `null` before first successful fetch. */
	peek(): CatalogSnapshot | null;
	/** Slug lookup against the current snapshot. */
	find(slug: string): CatalogModel | undefined;
}
