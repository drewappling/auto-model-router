/**
 * OpenRouter catalog: normalization of the raw `/api/v1/models` payload and
 * a cached `CatalogSource` over it.
 *
 * Normalization is deliberately strict about money fields and lenient about
 * everything else: a record whose price is unknowable (`"-1"`, dynamic
 * routers like `openrouter/auto`) is dropped entirely, because routing on an
 * unknown price is how budgets silently blow up.
 */

import type { Database } from "bun:sqlite";
import type { RouterConfig } from "../config/types.ts";
import type { UpstreamClient } from "../upstream/types.ts";
import { createLogger } from "../util/log.ts";
import type { CatalogModel, CatalogSnapshot, CatalogSource, Modality, Price, PriceTier, QualityScores } from "./types.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isModality(value: unknown): value is Modality {
	return value === "text" || value === "image" || value === "file" || value === "audio";
}

/**
 * OpenRouter prices are decimal strings, USD per token. A negative value
 * means "unknown/dynamic" (their own meta-routers), NOT free — return null
 * for both missing/unparseable and negative, and let the caller decide
 * whether the component is mandatory.
 */
function parsePrice(value: unknown): number | null {
	if (typeof value !== "string" && typeof value !== "number") return null;
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/** True when every numeric component the record publishes is exactly zero. */
function allComponentsZero(record: Record<string, unknown>): boolean {
	for (const [key, value] of Object.entries(record)) {
		if (key === "overrides" || key === "discount") continue;
		if (typeof value !== "string" && typeof value !== "number") continue;
		const n = parsePrice(value);
		// An unparseable or negative component means "unknown", and unknown is not free.
		if (n === null || n !== 0) return false;
	}
	return true;
}

function tierComponentsZero(price: Price): boolean {
	return (
		price.prompt === 0 &&
		price.completion === 0 &&
		(price.cacheRead ?? 0) === 0 &&
		(price.cacheWrite ?? 0) === 0 &&
		(price.reasoning ?? 0) === 0 &&
		(price.image ?? 0) === 0 &&
		(price.request ?? 0) === 0
	);
}

/** Long-context override entries inherit any component they omit from the base price. */
function buildTierPrice(record: Record<string, unknown>, base: Price): Price {
	const price: Price = {
		prompt: parsePrice(record.prompt) ?? base.prompt,
		completion: parsePrice(record.completion) ?? base.completion,
	};
	const cacheRead = parsePrice(record.input_cache_read) ?? base.cacheRead;
	if (cacheRead !== undefined) price.cacheRead = cacheRead;
	const cacheWrite = parsePrice(record.input_cache_write) ?? base.cacheWrite;
	if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
	const reasoning = parsePrice(record.internal_reasoning) ?? base.reasoning;
	if (reasoning !== undefined) price.reasoning = reasoning;
	const image = parsePrice(record.image) ?? base.image;
	if (image !== undefined) price.image = image;
	const request = parsePrice(record.request) ?? base.request;
	if (request !== undefined) price.request = request;
	return price;
}

export function normalizeCatalogModel(raw: unknown): CatalogModel | null {
	const record = asRecord(raw);
	if (record === null) return null;

	const id = record.id;
	if (typeof id !== "string" || id.length === 0) return null;

	const pricing = asRecord(record.pricing);
	if (pricing === null) return null;
	const prompt = parsePrice(pricing.prompt);
	const completion = parsePrice(pricing.completion);
	// Negative or missing prompt/completion price ⇒ cost is unknowable ⇒ unusable.
	if (prompt === null || completion === null) return null;

	const contextLength = record.context_length;
	if (typeof contextLength !== "number" || !Number.isFinite(contextLength) || contextLength <= 0) return null;

	const price: Price = { prompt, completion };
	const cacheRead = parsePrice(pricing.input_cache_read);
	if (cacheRead !== null) price.cacheRead = cacheRead;
	const cacheWrite = parsePrice(pricing.input_cache_write);
	if (cacheWrite !== null) price.cacheWrite = cacheWrite;
	const reasoningPrice = parsePrice(pricing.internal_reasoning);
	if (reasoningPrice !== null) price.reasoning = reasoningPrice;
	const image = parsePrice(pricing.image);
	if (image !== null) price.image = image;
	const request = parsePrice(pricing.request);
	if (request !== null) price.request = request;

	// `pricing.overrides[]` mixes two kinds: token-tier entries keyed by
	// `min_prompt_tokens` (long-context surcharges) and `utc_start`/`utc_end`
	// time windows. PriceTier models only the token axis; time windows cannot
	// be routed around and are skipped.
	const priceTiers: PriceTier[] = [];
	const overrides = Array.isArray(pricing.overrides) ? pricing.overrides : [];
	for (const rawTier of overrides) {
		const tierRecord = asRecord(rawTier);
		if (tierRecord === null) continue;
		const minPromptTokens = tierRecord.min_prompt_tokens;
		if (typeof minPromptTokens !== "number" || !Number.isFinite(minPromptTokens) || minPromptTokens < 0) continue;
		priceTiers.push({ minPromptTokens, price: buildTierPrice(tierRecord, price) });
	}
	priceTiers.sort((a, b) => a.minPromptTokens - b.minPromptTokens);

	// Free means every published component is zero at every context length;
	// `openrouter/auto` never reaches here (unknown price dropped above).
	const isFree = allComponentsZero(pricing) && priceTiers.every((tier) => tierComponentsZero(tier.price));

	const params = Array.isArray(record.supported_parameters) ? record.supported_parameters : [];
	const supported: string[] = [];
	for (const p of params) if (typeof p === "string") supported.push(p);

	const architecture = asRecord(record.architecture);
	const inputModalities: Modality[] = [];
	const rawModalities = architecture !== null && Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
	for (const m of rawModalities) if (isModality(m) && !inputModalities.includes(m)) inputModalities.push(m);
	if (inputModalities.length === 0) inputModalities.push("text");
	const tokenizerRaw = architecture === null ? null : architecture.tokenizer;
	const tokenizer = typeof tokenizerRaw === "string" && tokenizerRaw.length > 0 ? tokenizerRaw : "Other";

	// Absent axes are omitted, never zero-filled: an unscored model must not
	// satisfy a quality floor (router treats "absent on every axis" as unscored).
	const quality: QualityScores = {};
	const benchmarks = asRecord(record.benchmarks);
	const aa = benchmarks === null ? null : asRecord(benchmarks.artificial_analysis);
	if (aa !== null) {
		const intelligence = aa.intelligence_index;
		if (typeof intelligence === "number" && Number.isFinite(intelligence)) quality.intelligence = intelligence;
		const coding = aa.coding_index;
		if (typeof coding === "number" && Number.isFinite(coding)) quality.coding = coding;
		const agentic = aa.agentic_index;
		if (typeof agentic === "number" && Number.isFinite(agentic)) quality.agentic = agentic;
	}

	const reasoningMeta = asRecord(record.reasoning);
	const topProvider = asRecord(record.top_provider);
	const created = record.created;
	const canonical = record.canonical_slug;
	const name = record.name;
	// `~vendor/model` slugs are floating aliases; the tilde is not part of the namespace.
	const bare = id.startsWith("~") ? id.slice(1) : id;
	const slash = bare.indexOf("/");

	const model: CatalogModel = {
		slug: id,
		canonicalSlug: typeof canonical === "string" && canonical.length > 0 ? canonical : id,
		name: typeof name === "string" && name.length > 0 ? name : id,
		contextLength,
		supportsTools: supported.includes("tools"),
		supportsReasoning: supported.includes("reasoning") || supported.includes("include_reasoning"),
		reasoningMandatory: reasoningMeta !== null && reasoningMeta.mandatory === true,
		supportsToolChoice: supported.includes("tool_choice"),
		inputModalities,
		price,
		priceTiers,
		quality,
		tokenizer,
		isFree,
		createdAtMs: typeof created === "number" && Number.isFinite(created) ? created * 1000 : 0,
		author: slash === -1 ? bare : bare.slice(0, slash),
	};
	if (topProvider !== null) {
		const maxCompletion = topProvider.max_completion_tokens;
		if (typeof maxCompletion === "number" && Number.isFinite(maxCompletion) && maxCompletion > 0) {
			model.maxCompletionTokens = maxCompletion;
		}
	}
	return model;
}

interface CacheRow {
	payload: string;
	fetched_at_ms: number;
	etag: string | null;
}

function normalizeAll(raw: unknown[]): CatalogModel[] {
	const models: CatalogModel[] = [];
	for (const record of raw) {
		const model = normalizeCatalogModel(record);
		if (model !== null) models.push(model);
	}
	return models;
}

export function createCatalog(cfg: RouterConfig, upstream: UpstreamClient, db: Database): CatalogSource {
	const log = createLogger(cfg.logLevel);
	let snapshot: CatalogSnapshot | null = null;
	let bySlug = new Map<string, CatalogModel>();
	let hydrated = false;
	let inflight: Promise<CatalogSnapshot> | null = null;

	const readCache = db.query("SELECT payload, fetched_at_ms, etag FROM catalog_cache WHERE id = 1");
	const writeCache = db.query(
		`INSERT INTO catalog_cache (id, payload, fetched_at_ms, etag) VALUES (1, ?, ?, NULL)
		 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at_ms = excluded.fetched_at_ms, etag = NULL`,
	);

	function install(models: CatalogModel[], fetchedAtMs: number, etag: string | null): CatalogSnapshot {
		const next: CatalogSnapshot = { models, fetchedAtMs };
		if (etag !== null) next.etag = etag;
		snapshot = next;
		const map = new Map<string, CatalogModel>();
		for (const model of models) map.set(model.slug, model);
		bySlug = map;
		return next;
	}

	/** Memory first; hydrate once from `catalog_cache` so restarts route from disk. */
	function hydrate(): CatalogSnapshot | null {
		if (snapshot !== null || hydrated) return snapshot;
		hydrated = true;
		// We own the schema; the row shape is fixed by util/sqlite.ts.
		const row = readCache.get() as CacheRow | null;
		if (row === null) return null;
		try {
			const payload: unknown = JSON.parse(row.payload);
			if (!Array.isArray(payload)) return null;
			return install(normalizeAll(payload), row.fetched_at_ms, row.etag);
		} catch (err) {
			log.warn("catalog cache unreadable; treating as empty", { error: String(err) });
			return null;
		}
	}

	async function doRefresh(): Promise<CatalogSnapshot> {
		const raw = await upstream.fetchModels();
		const models = normalizeAll(raw);
		const fetchedAtMs = Date.now();
		// Persist the RAW payload: normalization improvements apply on the next
		// boot without a network fetch. The client returns no headers, so no etag.
		writeCache.run(JSON.stringify(raw), fetchedAtMs);
		return install(models, fetchedAtMs, null);
	}

	/** Concurrent refreshes share one in-flight fetch. */
	function refreshShared(): Promise<CatalogSnapshot> {
		inflight ??= doRefresh().finally(() => {
			inflight = null;
		});
		return inflight;
	}

	return {
		async get(): Promise<CatalogSnapshot> {
			const cached = hydrate();
			if (cached !== null && Date.now() - cached.fetchedAtMs < cfg.openrouter.catalogTtlMs) return cached;
			try {
				return await refreshShared();
			} catch (err) {
				// A transient OpenRouter blip must never break routing.
				if (cached !== null) {
					log.warn("catalog refresh failed; serving stale snapshot", {
						error: String(err),
						fetchedAtMs: cached.fetchedAtMs,
					});
					return cached;
				}
				throw err;
			}
		},
		refresh(): Promise<CatalogSnapshot> {
			return refreshShared();
		},
		peek(): CatalogSnapshot | null {
			return hydrate();
		},
		find(slug: string): CatalogModel | undefined {
			hydrate();
			return bySlug.get(slug);
		},
	};
}
