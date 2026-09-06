/**
 * Ollama Cloud per-model token rates, USD per million tokens.
 *
 * Ollama publishes these on https://ollama.com/pricing and nowhere machine-
 * readable: neither `/v1/models` nor `/api/tags` carries a price, so the router
 * ships a snapshot and lets `ollama.prices` in config override or extend it. A
 * model with no rate from either source is dropped from the catalog — routing
 * on an unknown price is how budgets silently blow up (same rule as the
 * OpenRouter `-1` sentinel).
 *
 * Keys are the bare cloud model names as ollama.com lists them. Where Ollama
 * prices a specific tag (`gpt-oss:120b`) the key keeps the tag; otherwise the
 * base name covers every tag (`deepseek-v4-pro:0813` → `deepseek-v4-pro`).
 *
 * Snapshot taken 2026-09-05 from ollama.com/pricing. Cached-input rates are
 * absent for some rows on that page; those models get no cache-read discount
 * rather than an invented one.
 */

export interface OllamaRate {
	/** USD per million uncached prompt tokens. */
	input: number;
	/** USD per million cached prompt tokens. Absent ⇒ no published discount. */
	cachedInput?: number;
	/** USD per million completion tokens. */
	output: number;
}

export const OLLAMA_PRICE_SNAPSHOT_DATE = "2026-09-05";

export const OLLAMA_BUILTIN_PRICES: Readonly<Record<string, OllamaRate>> = {
	"deepseek-v4-flash": { input: 0.22, cachedInput: 0.007, output: 0.66 },
	"deepseek-v4-pro": { input: 0.66, cachedInput: 0.022, output: 1.98 },
	gemma4: { input: 0.14, cachedInput: 0.05, output: 0.4 },
	"glm-5.3": { input: 1.4, cachedInput: 0.26, output: 4.4 },
	"glm-5.3-flash": { input: 0.15, cachedInput: 0.03, output: 0.5 },
	"glm-5.2": { input: 1.4, cachedInput: 0.26, output: 4.4 },
	"glm-5.1": { input: 1.0, cachedInput: 0.2, output: 3.2 },
	"gpt-oss:120b": { input: 0.15, cachedInput: 0.014, output: 0.6 },
	"gpt-oss:20b": { input: 0.07, cachedInput: 0.035, output: 0.3 },
	"kimi-k3": { input: 3.0, cachedInput: 0.3, output: 15.0 },
	"kimi-k2.7-code": { input: 0.95, cachedInput: 0.19, output: 4.0 },
	"kimi-k2.6": { input: 0.95, cachedInput: 0.16, output: 4.0 },
	"minimax-m3": { input: 0.6, cachedInput: 0.12, output: 2.4 },
	"minimax-m2.7": { input: 0.3, cachedInput: 0.06, output: 1.2 },
	"mistral-large-3": { input: 0.5, output: 1.5 },
	"nemotron-3-nano": { input: 0.06, output: 0.24 },
	"nemotron-3-super": { input: 0.015, cachedInput: 0.015, output: 0.6 },
	"nemotron-3-ultra": { input: 0.1, cachedInput: 0.1, output: 3.0 },
	"qwen3.5:397b": { input: 0.6, output: 3.6 },
};

/**
 * The bare cloud name a listing entry is priced under: the daemon's `:cloud`
 * / `-cloud` decoration stripped, lower-cased. `glm-5.3-flash:cloud` and
 * `deepseek-v4-pro:0813-cloud` become `glm-5.3-flash` and
 * `deepseek-v4-pro:0813`, which is exactly how ollama.com lists them.
 */
export function bareCloudName(id: string): string {
	let s = id.trim().toLowerCase();
	if (s.endsWith(":cloud")) s = s.slice(0, -":cloud".length);
	else if (s.endsWith("-cloud")) s = s.slice(0, -"-cloud".length);
	return s;
}

/**
 * Rate for a cloud model: the exact tagged name first (`gpt-oss:120b`), then
 * the base name before the tag (`deepseek-v4-pro:0813` → `deepseek-v4-pro`).
 * `overrides` (from config) win over the built-in snapshot at every step.
 */
export function ollamaRateFor(
	id: string,
	overrides: Readonly<Record<string, OllamaRate>> = {},
): { key: string; rate: OllamaRate } | null {
	const bare = bareCloudName(id);
	const colon = bare.indexOf(":");
	const candidates = colon === -1 ? [bare] : [bare, bare.slice(0, colon)];
	for (const key of candidates) {
		const o = overrides[key];
		if (o !== undefined) return { key, rate: o };
		const b = OLLAMA_BUILTIN_PRICES[key];
		if (b !== undefined) return { key, rate: b };
	}
	return null;
}
