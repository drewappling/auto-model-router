/**
 * The router's model catalog as data, with a policy's verdict per model: what
 * `GET /v1/router/catalog` answers. A team front door renders it for its
 * governance views ("which models can this group reach, and why not the
 * rest"), so admission is decided by the SAME matcher and in the SAME order
 * as `buildCandidates` — the built-in denials, then allow, deny, free and
 * tool support — over the filters `applyRequestPolicy` produced, and a pin
 * takes effect only when the pinned model itself survives them, exactly as
 * `select` treats a forced slug. Tiers are per turn and take no part.
 */

import type { CatalogModel, Modality, QualityScores } from "../catalog/types.ts";
import type { FilterConfig } from "../config/types.ts";
import { builtInDenial, globToRe } from "../router/candidates.ts";

export interface CatalogViewModel {
	slug: string;
	canonicalSlug: string;
	name: string;
	/** The upstream that serves it: `openrouter`, `ollama`, or a named upstream's id. */
	provider: string;
	/**
	 * The slug's namespace before the first `/` (`anthropic`). For a named
	 * upstream's `<id>/<model>` the vendor is the model id's own namespace when
	 * it carries one (`vllm/meta-llama/x` ⇒ `meta-llama`), else the upstream id.
	 */
	vendor: string;
	contextLength: number;
	maxCompletionTokens?: number;
	supportsTools: boolean;
	supportsReasoning: boolean;
	reasoningMandatory: boolean;
	inputModalities: Modality[];
	/** USD per MILLION tokens, the catalog's own units. */
	price: { prompt: number; completion: number; cacheRead?: number; cacheWrite?: number };
	quality: QualityScores;
	isFree: boolean;
	/** Present only when a policy was asked about. */
	admitted?: boolean;
	/** Present only when not admitted: which filter kept the model out. */
	reason?: string;
}

export interface CatalogView {
	/** When the catalog was last fetched; 0 before the first fetch. */
	fetchedAtMs: number;
	/** Sorted by slug. */
	models: CatalogViewModel[];
}

/** The filters a turn routes under: the configured ones, or those `applyRequestPolicy` merged a policy into. */
export type AdmissionFilters = Pick<FilterConfig, "allow" | "deny" | "includeFree" | "requireToolSupport">;

export interface CatalogViewArgs {
	models: readonly CatalogModel[];
	fetchedAtMs: number;
	/** When given, every model carries `admitted` and, if out, `reason`. */
	verdict?: { filters: AdmissionFilters; pin?: string };
	/** Why a provider cannot take a turn now, or null when it can. */
	unserved: (provider: string) => string | null;
}

/** Per-token catalog prices as USD per million, rounded so `0.22` does not come out as `0.22000000000000003`. */
function perMillion(usdPerToken: number): number {
	return Math.round(usdPerToken * 1e6 * 1e6) / 1e6;
}

export function vendorOf(model: Pick<CatalogModel, "slug" | "provider">): string {
	const slash = model.slug.indexOf("/");
	const head = slash === -1 ? model.slug : model.slug.slice(0, slash);
	if (model.provider === "openrouter" || model.provider === "ollama" || head !== model.provider) return head;
	const rest = model.slug.slice(slash + 1);
	const inner = rest.indexOf("/");
	return inner === -1 ? model.provider : rest.slice(0, inner);
}

/**
 * Why the filters keep a model out, or null when it passes. The order is
 * `buildCandidates`' so the first reason is the one a turn would record.
 */
function filterReason(model: CatalogModel, filters: AdmissionFilters, allowRes: readonly RegExp[], denyRes: readonly RegExp[]): string | null {
	const builtIn = builtInDenial(model);
	if (builtIn !== null) return builtIn;
	if (allowRes.length > 0 && !allowRes.some((re) => re.test(model.slug))) return "not in the allow list";
	const denied = denyRes.findIndex((re) => re.test(model.slug));
	if (denied !== -1) return `denied by ${filters.deny[denied]}`;
	if (model.isFree && !filters.includeFree) return "free models excluded (filters.includeFree)";
	if (filters.requireToolSupport && !model.supportsTools) return "no tool support (filters.requireToolSupport)";
	return null;
}

export function catalogView(args: CatalogViewArgs): CatalogView {
	const sorted = [...args.models].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	const verdict = args.verdict;
	const allowRes = verdict === undefined ? [] : verdict.filters.allow.map(globToRe);
	const denyRes = verdict === undefined ? [] : verdict.filters.deny.map(globToRe);
	// One reason per slug before the pin is considered: the pin only bites when
	// the pinned model itself is in, as `select` ignores a pin the filters drop.
	const reasons = new Map<string, string | null>();
	if (verdict !== undefined) for (const m of sorted) reasons.set(m.slug, args.unserved(m.provider) ?? filterReason(m, verdict.filters, allowRes, denyRes));
	const pin = verdict?.pin !== undefined && reasons.get(verdict.pin) === null ? verdict.pin : undefined;
	const models = sorted.map((m): CatalogViewModel => {
		const price: CatalogViewModel["price"] = { prompt: perMillion(m.price.prompt), completion: perMillion(m.price.completion) };
		if (m.price.cacheRead !== undefined) price.cacheRead = perMillion(m.price.cacheRead);
		if (m.price.cacheWrite !== undefined) price.cacheWrite = perMillion(m.price.cacheWrite);
		const out: CatalogViewModel = {
			slug: m.slug,
			canonicalSlug: m.canonicalSlug,
			name: m.name,
			provider: m.provider,
			vendor: vendorOf(m),
			contextLength: m.contextLength,
			...(m.maxCompletionTokens === undefined ? {} : { maxCompletionTokens: m.maxCompletionTokens }),
			supportsTools: m.supportsTools,
			supportsReasoning: m.supportsReasoning,
			reasoningMandatory: m.reasoningMandatory,
			inputModalities: [...m.inputModalities],
			price,
			quality: { ...m.quality },
			isFree: m.isFree,
		};
		if (verdict !== undefined) {
			const reason = reasons.get(m.slug) ?? (pin !== undefined && m.slug !== pin ? `pinned to ${pin}` : null);
			out.admitted = reason === null;
			if (reason !== null) out.reason = reason;
		}
		return out;
	});
	return { fetchedAtMs: args.fetchedAtMs, models };
}
