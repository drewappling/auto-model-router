/**
 * Ollama Cloud catalog: turns Ollama's model listing into `CatalogModel`s the
 * router can rank next to OpenRouter's.
 *
 * Ollama publishes far less per model than OpenRouter does, so each model is
 * assembled from three sources:
 *
 *  1. The listing itself (`GET /api/tags`, on the daemon or on ollama.com):
 *     ids, and on the daemon the context length + capabilities of every cloud
 *     model. ollama.com's listing carries neither, so there `POST /api/show`
 *     (unauthenticated) fills them, cached per id for the life of the process.
 *  2. The price table (`ollama-prices.ts` + `ollama.prices` config), since no
 *     Ollama endpoint publishes rates. Unpriced models are dropped.
 *  3. The OpenRouter twin — the same model under an OpenRouter slug, matched by
 *     normalised name (`glm-5.3-flash` ↔ `z-ai/glm-5.3-flash`) — for the
 *     quality scores that put the model above `trivial`, and as a fallback for
 *     tokenizer, context and capabilities. `ollama.twins` in config pins a
 *     match the normaliser cannot make.
 *
 * Slugs are `ollama/<id as listed>`, so the daemon's `glm-5.3-flash:cloud` and
 * ollama.com's `glm-5.3-flash` are distinct catalog entries with the same
 * price and twin; the dispatch client strips the `ollama/` prefix.
 */

import type { Database } from "bun:sqlite";
import type { OllamaConfig } from "../config/types.ts";
import type { Logger } from "../util/log.ts";
import { normalizeModelKey } from "./benchmark-feeds.ts";
import { bareCloudName, ollamaRateFor, type OllamaRate } from "./ollama-prices.ts";
import type { CatalogModel, CatalogSnapshot, Modality } from "./types.ts";

export const OLLAMA_SLUG_PREFIX = "ollama/";

/** One entry of Ollama's `/api/tags` listing, reduced to what routing needs. */
export interface OllamaListing {
	id: string;
	/** Bare cloud name on ollama.com (`remote_model` on the daemon). */
	remoteModel: string | null;
	/** Present when the daemon proxies this model to ollama.com. */
	isCloud: boolean;
	contextLength: number | null;
	capabilities: string[];
	modifiedAtMs: number;
}

function asRec(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Parses one raw `/api/tags` model record. */
export function parseOllamaListing(raw: unknown, source: "daemon" | "ollama.com"): OllamaListing | null {
	const rec = asRec(raw);
	if (rec === null) return null;
	const id = typeof rec.model === "string" && rec.model !== "" ? rec.model : typeof rec.name === "string" ? rec.name : "";
	if (id === "") return null;
	const details = asRec(rec.details);
	const ctx = details?.context_length;
	const caps = Array.isArray(rec.capabilities) ? rec.capabilities.filter((c): c is string => typeof c === "string") : [];
	const remote = typeof rec.remote_model === "string" && rec.remote_model !== "" ? rec.remote_model : null;
	const modified = typeof rec.modified_at === "string" ? Date.parse(rec.modified_at) : NaN;
	return {
		id,
		remoteModel: remote ?? (source === "ollama.com" ? id : null),
		// On the daemon only proxied entries are cloud models; on ollama.com
		// everything listed is.
		isCloud: source === "ollama.com" || typeof rec.remote_host === "string",
		contextLength: typeof ctx === "number" && Number.isFinite(ctx) && ctx > 0 ? ctx : null,
		capabilities: caps,
		modifiedAtMs: Number.isFinite(modified) ? modified : 0,
	};
}

/** `POST /api/show` reduced to the two fields the listing may lack. */
export function parseOllamaShow(raw: unknown): { contextLength: number | null; capabilities: string[] } {
	const rec = asRec(raw);
	const caps = rec !== null && Array.isArray(rec.capabilities) ? rec.capabilities.filter((c): c is string => typeof c === "string") : [];
	let contextLength: number | null = null;
	const info = rec === null ? null : asRec(rec.model_info);
	if (info !== null) {
		for (const [k, v] of Object.entries(info)) {
			if (k.endsWith(".context_length") && typeof v === "number" && Number.isFinite(v) && v > 0) {
				contextLength = v;
				break;
			}
		}
	}
	return { contextLength, capabilities: caps };
}

/**
 * Normalised match key for an Ollama name. Ollama separates the tag with `:`
 * (`gpt-oss:120b`) where OpenRouter uses `-` (`openai/gpt-oss-120b`), so the
 * tag is folded in before the shared normaliser runs.
 */
export function ollamaTwinKey(name: string): string {
	return normalizeModelKey(bareCloudName(name).replace(/:/g, "-"));
}

/** OpenRouter models indexed by normalised name, first slug wins per key. */
export function twinIndex(openrouter: readonly CatalogModel[]): Map<string, CatalogModel> {
	const out = new Map<string, CatalogModel>();
	for (const m of openrouter) {
		if (m.provider !== "openrouter") continue;
		if (m.slug.startsWith("~") || m.slug.endsWith(":batch") || m.slug.includes(":free")) continue;
		const key = normalizeModelKey(m.slug);
		if (!out.has(key)) out.set(key, m);
	}
	return out;
}

export interface BuildOllamaArgs {
	listings: readonly OllamaListing[];
	openrouter: readonly CatalogModel[];
	cfg: OllamaConfig;
	log?: Logger;
}

/** Builds catalog models from listings + prices + twins. Pure; no I/O. */
export function buildOllamaModels(args: BuildOllamaArgs): CatalogModel[] {
	const { listings, openrouter, cfg, log } = args;
	const twins = twinIndex(openrouter);
	const bySlug = new Map(openrouter.map((m) => [m.slug, m] as const));
	const out: CatalogModel[] = [];
	const skipped: string[] = [];
	for (const l of listings) {
		if (!l.isCloud && !cfg.includeLocal) continue;
		const priceName = l.remoteModel ?? l.id;
		const rate = ollamaRateFor(priceName, cfg.prices);
		if (rate === null) {
			skipped.push(l.id);
			continue;
		}
		// A pin may name the tagged cloud name, its base, or the listed id.
		const bare = bareCloudName(priceName);
		const base = bare.includes(":") ? bare.slice(0, bare.indexOf(":")) : bare;
		const pinned = cfg.twins[bare] ?? cfg.twins[base] ?? cfg.twins[l.id];
		const twin = (pinned !== undefined ? bySlug.get(pinned) : undefined) ?? twins.get(ollamaTwinKey(priceName)) ?? null;
		const contextLength = l.contextLength ?? twin?.contextLength ?? null;
		if (contextLength === null) {
			skipped.push(`${l.id} (no context length)`);
			continue;
		}
		const caps = new Set(l.capabilities);
		const hasCaps = caps.size > 0;
		const modalities: Modality[] = ["text"];
		if (hasCaps ? caps.has("vision") : (twin?.inputModalities.includes("image") ?? false)) modalities.push("image");
		const model: CatalogModel = {
			slug: `${OLLAMA_SLUG_PREFIX}${l.id}`,
			canonicalSlug: `${OLLAMA_SLUG_PREFIX}${priceName}`,
			name: `${l.id} (Ollama Cloud)`,
			provider: "ollama",
			contextLength,
			supportsTools: hasCaps ? caps.has("tools") : (twin?.supportsTools ?? false),
			supportsReasoning: hasCaps ? caps.has("thinking") : (twin?.supportsReasoning ?? false),
			reasoningMandatory: false,
			// Ollama's OpenAI-compatible endpoint documents `tool_choice` as unsupported.
			supportsToolChoice: false,
			inputModalities: modalities,
			price: toPrice(rate.rate),
			priceTiers: [],
			quality: twin === null ? {} : { ...twin.quality },
			tokenizer: twin?.tokenizer ?? "Other",
			isFree: false,
			createdAtMs: l.modifiedAtMs,
			author: "ollama",
		};
		if (twin?.maxCompletionTokens !== undefined) model.maxCompletionTokens = twin.maxCompletionTokens;
		out.push(model);
	}
	if (skipped.length > 0) log?.debug("ollama models skipped (no price or context)", { skipped: skipped.join(", ") });
	return out;
}

function toPrice(rate: OllamaRate): CatalogModel["price"] {
	const price: CatalogModel["price"] = { prompt: rate.input / 1e6, completion: rate.output / 1e6 };
	if (rate.cachedInput !== undefined) price.cacheRead = rate.cachedInput / 1e6;
	return price;
}

/** Minimal fetch surface, injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface OllamaCatalogSource {
	/** Cloud models, refreshed when older than `cfg.catalogTtlMs`; last good set on failure. */
	get(openrouter: readonly CatalogModel[]): Promise<CatalogModel[]>;
	/** Last built set without touching the network. */
	peek(): CatalogModel[];
	/** Forces a re-list on the next `get`. */
	invalidate(): void;
}

/** Whether a base URL points at ollama.com (which needs `/api/show` for metadata). */
export function isOllamaDotCom(baseUrl: string): boolean {
	try {
		return new URL(baseUrl).hostname.toLowerCase().endsWith("ollama.com");
	} catch {
		return false;
	}
}

/** `https://ollama.com/v1` → `https://ollama.com`; the native API lives beside `/v1`. */
export function ollamaApiRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The persisted Ollama model set, or [] when none has been built yet. */
export function loadOllamaCatalogCache(db: Database): { models: CatalogModel[]; fetchedAtMs: number } {
	const row = db.query("SELECT payload, fetched_at_ms FROM ollama_catalog_cache WHERE id = 1").get() as
		| { payload: string; fetched_at_ms: number }
		| null;
	if (row === null) return { models: [], fetchedAtMs: 0 };
	try {
		const parsed = JSON.parse(row.payload) as unknown;
		return { models: Array.isArray(parsed) ? (parsed as CatalogModel[]) : [], fetchedAtMs: row.fetched_at_ms };
	} catch {
		return { models: [], fetchedAtMs: 0 };
	}
}

export function createOllamaCatalog(cfg: OllamaConfig, log: Logger, fetchImpl: FetchLike = fetch, db?: Database): OllamaCatalogSource {
	const root = ollamaApiRoot(cfg.baseUrl);
	const direct = isOllamaDotCom(cfg.baseUrl);
	const headers: Record<string, string> = {};
	if (cfg.apiKey !== "") headers.authorization = `Bearer ${cfg.apiKey}`;
	// Hydrate from disk so a restart peeks a real set before the first listing;
	// listedAtMs stays 0 so the first get() still refreshes.
	let models: CatalogModel[] = db === undefined ? [] : loadOllamaCatalogCache(db).models;
	let listedAtMs = 0;
	const persist = db === undefined
		? null
		: db.query(
				`INSERT INTO ollama_catalog_cache (id, payload, fetched_at_ms) VALUES (1, ?, ?)
				 ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, fetched_at_ms = excluded.fetched_at_ms`,
			);
	let inflight: Promise<CatalogModel[]> | null = null;
	// `/api/show` results are stable per id; fetched once per process.
	const shown = new Map<string, { contextLength: number | null; capabilities: string[] }>();

	async function list(): Promise<OllamaListing[]> {
		const res = await fetchImpl(`${root}/api/tags`, { headers, signal: AbortSignal.timeout(cfg.timeoutMs) });
		if (!res.ok) throw new Error(`ollama /api/tags HTTP ${res.status}`);
		const json = asRec(await res.json());
		const raw = json !== null && Array.isArray(json.models) ? json.models : [];
		const out: OllamaListing[] = [];
		for (const r of raw) {
			const l = parseOllamaListing(r, direct ? "ollama.com" : "daemon");
			if (l !== null) out.push(l);
		}
		// ollama.com's listing has no context/capabilities; ask per model, once.
		if (direct) {
			for (const l of out) {
				if (l.contextLength !== null && l.capabilities.length > 0) continue;
				let s = shown.get(l.id);
				if (s === undefined) {
					try {
						const r = await fetchImpl(`${root}/api/show`, {
							method: "POST",
							headers: { ...headers, "content-type": "application/json" },
							body: JSON.stringify({ model: l.id }),
							signal: AbortSignal.timeout(cfg.timeoutMs),
						});
						s = r.ok ? parseOllamaShow(await r.json()) : { contextLength: null, capabilities: [] };
					} catch {
						s = { contextLength: null, capabilities: [] };
					}
					shown.set(l.id, s);
				}
				if (l.contextLength === null) l.contextLength = s.contextLength;
				if (l.capabilities.length === 0) l.capabilities = s.capabilities;
			}
		}
		return out;
	}

	async function refresh(openrouter: readonly CatalogModel[]): Promise<CatalogModel[]> {
		try {
			const listings = await list();
			const built = buildOllamaModels({ listings, openrouter, cfg, log });
			if (built.length === 0 && models.length > 0) {
				log.warn("ollama listing yielded no priced cloud models; keeping the previous set", { listed: listings.length });
			} else {
				models = built;
				try {
					persist?.run(JSON.stringify(models), Date.now());
				} catch (err) {
					log.debug("ollama catalog persist failed", { error: err instanceof Error ? err.message : String(err) });
				}
			}
			listedAtMs = Date.now();
		} catch (err) {
			log.warn("ollama catalog refresh failed; keeping the previous set", {
				error: err instanceof Error ? err.message : String(err),
				models: models.length,
			});
			// Back off for a full TTL rather than hammering a dead endpoint each turn.
			listedAtMs = Date.now();
		}
		return models;
	}

	return {
		async get(openrouter) {
			if (Date.now() - listedAtMs < cfg.catalogTtlMs) return models;
			inflight ??= refresh(openrouter).finally(() => {
				inflight = null;
			});
			return inflight;
		},
		peek() {
			return models;
		},
		invalidate() {
			listedAtMs = 0;
		},
	};
}

/** True when a catalog slug is an Ollama model. */
export function isOllamaSlug(slug: string): boolean {
	return slug.startsWith(OLLAMA_SLUG_PREFIX);
}

/** The id Ollama expects in the request body. */
export function ollamaModelId(slug: string): string {
	return isOllamaSlug(slug) ? slug.slice(OLLAMA_SLUG_PREFIX.length) : slug;
}

/** Composite snapshot helper: append Ollama models to an OpenRouter snapshot. */
export function mergeSnapshots(openrouter: CatalogSnapshot, ollama: readonly CatalogModel[]): CatalogSnapshot {
	if (ollama.length === 0) return openrouter;
	const merged: CatalogSnapshot = {
		...openrouter,
		models: [...openrouter.models, ...ollama],
		fetchedAtMs: openrouter.fetchedAtMs,
	};
	return merged;
}
