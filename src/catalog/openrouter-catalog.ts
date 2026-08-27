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
import { applyFeedScores, refreshFeedScores } from "./benchmark-feeds.ts";

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
	key_scoped: number;
}

function normalizeAll(raw: unknown[]): CatalogModel[] {
	const models: CatalogModel[] = [];
	for (const record of raw) {
		const model = normalizeCatalogModel(record);
		if (model !== null) models.push(model);
	}
	return models;
}

/**
 * Joins the AA `benchmarks` block from the public catalog onto key-scoped
 * records.
 *
 * `GET /models/user` is authoritative for AVAILABILITY under the key's
 * guardrails, but its payload omits `benchmarks` entirely — every record comes
 * back unscored. An unscored model satisfies no quality floor above zero, so
 * with only the key-scoped payload every tier except `trivial` (floor 0) is
 * permanently empty and all traffic collapses onto the cheapest models. Join
 * the public scores back on by `id`, falling back to `canonical_slug` so alias
 * entries (`~vendor/model-latest`) inherit their target's scores.
 *
 * Returns the number of records that gained scores.
 */
export function joinBenchmarks(keyScoped: unknown[], publicRaw: unknown[]): number {
	const byId = new Map<string, unknown>();
	for (const record of publicRaw) {
		const rec = asRecord(record);
		if (rec === null) continue;
		const benchmarks = rec.benchmarks;
		if (benchmarks === undefined || benchmarks === null) continue;
		if (typeof rec.id === "string") byId.set(rec.id, benchmarks);
		// Only fill a canonical_slug key when nothing claimed it, so a real id
		// always beats an alias target.
		if (typeof rec.canonical_slug === "string" && !byId.has(rec.canonical_slug)) {
			byId.set(rec.canonical_slug, benchmarks);
		}
	}

	let joined = 0;
	for (const record of keyScoped) {
		const rec = asRecord(record);
		if (rec === null) continue;
		if (rec.benchmarks !== undefined && rec.benchmarks !== null) continue;
		const id = typeof rec.id === "string" ? rec.id : null;
		const canonical = typeof rec.canonical_slug === "string" ? rec.canonical_slug : null;
		// An alias id keeps a leading `~`; strip it before the canonical lookup.
		const stripped = id !== null && id.startsWith("~") ? id.slice(1) : null;
		const benchmarks =
			(id !== null ? byId.get(id) : undefined) ??
			(canonical !== null ? byId.get(canonical) : undefined) ??
			(stripped !== null ? byId.get(stripped) : undefined);
		if (benchmarks === undefined) continue;
		rec.benchmarks = benchmarks;
		joined += 1;
	}
	return joined;
}

export function createCatalog(cfg: RouterConfig, upstream: UpstreamClient, db: Database): CatalogSource {
	const log = createLogger(cfg.logLevel);
	let snapshot: CatalogSnapshot | null = null;
	let bySlug = new Map<string, CatalogModel>();
	let hydrated = false;
	let inflight: Promise<CatalogSnapshot> | null = null;
	const readCache = db.query("SELECT payload, fetched_at_ms, etag, key_scoped FROM catalog_cache WHERE id = 1");
	const writeCache = db.query(
		`INSERT INTO catalog_cache (id, payload, fetched_at_ms, etag, key_scoped) VALUES (1, ?, ?, NULL, ?)
		 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at_ms = excluded.fetched_at_ms, etag = NULL, key_scoped = excluded.key_scoped`,
	);

	function install(
		models: CatalogModel[],
		fetchedAtMs: number,
		etag: string | null,
		keyScoped = false,
	): CatalogSnapshot {
		const next: CatalogSnapshot = { models, fetchedAtMs, keyScoped };
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
			// A key-scoped payload written before benchmarks were joined on has no
			// scores at all, which silently empties every tier above `trivial`.
			// Treat that as a stale cache and force a network refresh rather than
			// booting into the broken state for a whole refresh interval.
			if (row.key_scoped === 1 && payload.length > 0) {
				const anyScored = payload.some((record) => {
					const rec = asRecord(record);
					return rec !== null && rec.benchmarks !== undefined && rec.benchmarks !== null;
				});
				if (!anyScored) {
					log.warn("cached key-scoped catalog carries no benchmarks; refetching to restore tier floors");
					return null;
				}
			}
			// Provenance is persisted, not inferred from the current key: a payload
			// written by a keyless run or the public fallback must not be advertised
			// as key-scoped.
			return install(normalizeAll(payload), row.fetched_at_ms, row.etag, row.key_scoped === 1);
		} catch (err) {
			log.warn("catalog cache unreadable; treating as empty", { error: String(err) });
			return null;
		}
	}

	async function doRefresh(): Promise<CatalogSnapshot> {
		let raw: unknown[];
		let keyScoped = false;

		if (cfg.openrouter.apiKey !== "") {
			try {
				raw = await upstream.fetchModelsForUser();
				keyScoped = true;
				log.debug("fetched key-scoped model catalog", { models: raw.length });
			} catch (err) {
				// 401/403: auth failed on this key. Re-throw so callers do NOT silently
				// fall back to public catalog models that this key cannot run.
				if (err instanceof Error && "status" in err && (err.status === 401 || err.status === 403)) {
					log.error("key-scoped catalog fetch unauthorized; rejecting refresh", {
						status: err.status,
						message: err.message,
					});
					throw err;
				}
				log.warn("key-scoped catalog fetch failed; falling back to public /models", {
					error: err instanceof Error ? err.message : String(err),
				});
				raw = await upstream.fetchModels();
			}
		} else {
			raw = await upstream.fetchModels();
		}

		// The key-scoped payload carries no `benchmarks`, which would leave every
		// model unscored and every tier above `trivial` empty. Fetch the public
		// catalog purely for scores and join them on. Best-effort: if the public
		// fetch fails we route over an unscored catalog (degraded but working)
		// rather than failing a refresh that already has the availability list.
		if (keyScoped) {
			try {
				const publicRaw = await upstream.fetchModels();
				const joined = joinBenchmarks(raw, publicRaw);
				log.debug("joined public benchmarks onto key-scoped catalog", {
					models: raw.length,
					scored: joined,
				});
				if (joined === 0) {
					log.warn("no key-scoped model matched a public benchmark record; tiers above trivial will be empty", {
						models: raw.length,
					});
				}
			} catch (err) {
				log.warn("public benchmark fetch failed; catalog stays unscored", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		// Backfill quality scores OpenRouter never published (GLM, MiniMax, and
		// smaller vendors), from the external benchmark feeds. Best-effort: a feed
		// failure leaves the catalog on published scores. The feeds are cached on
		// their own slow cadence, so this is cheap on the minute-scale refresh.
		if (cfg.benchmarks.enabled) {
			try {
				const feeds = await refreshFeedScores(cfg, db, { log });
				const filled = applyFeedScores(raw, feeds);
				if (filled.modelsFilled > 0) {
					log.info("backfilled missing benchmarks from external feeds", {
						models: filled.modelsFilled,
						coding: filled.axes.coding,
						intelligence: filled.axes.intelligence,
						agentic: filled.axes.agentic,
						aa: filled.sources.artificial_analysis,
						benchlm: filled.sources.benchlm,
					});
				}
			} catch (err) {
				log.warn("benchmark backfill failed; catalog keeps published scores", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}

		const models = normalizeAll(raw);
		// A guardrail can narrow the key-scoped list to zero usable models (or a
		// transient upstream blip can return an empty payload). Treat that as a
		// failed refresh: keep the previous snapshot rather than replacing a good
		// one with an empty set that 500s every turn. `refresh()` has no stale
		// fallback of its own, so return the snapshot directly here.
		if (models.length === 0 && snapshot !== null) {
			log.warn("catalog refresh returned no usable models; keeping the previous snapshot");
			return snapshot;
		}
		const fetchedAtMs = Date.now();
		// Persist the RAW payload: normalization improvements apply on the next
		// boot without a network fetch. The client returns no headers, so no etag.
		// Only persist the public fallback when keyless: a key-scoped run that fell
		// back to public must not overwrite the key-scoped snapshot on disk, or a
		// restart would route over the un-scoped catalog for up to catalogTtlMs.
		if (cfg.openrouter.apiKey === "" || keyScoped) {
			writeCache.run(JSON.stringify(raw), fetchedAtMs, keyScoped ? 1 : 0);
		}
		return install(models, fetchedAtMs, null, keyScoped);
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
