/**
 * Named upstream entries as they arrive (a file, an env-built patch, a dashboard patch)
 * carry only what the author set; every client reads a complete record, so the optional
 * fields are filled here, at load and after every live apply.
 */

import type { UpstreamEntry } from "./types.ts";

/** Fills an upstream entry's optional fields, so every client reads a complete record. */
export function completeUpstreamEntry(raw: Record<string, unknown>): UpstreamEntry {
	const kind = raw.kind as UpstreamEntry["kind"];
	return {
		id: raw.id as string,
		kind,
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
		baseUrl: raw.baseUrl as string,
		apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
		apiVersion: typeof raw.apiVersion === "string" ? raw.apiVersion : "2024-10-21",
		headers: (raw.headers as Record<string, string> | undefined) ?? {},
		auth: raw.auth === "oauth-bearer" ? "oauth-bearer" : "api-key",
		timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 600_000,
		rateLimitCooldownMs: typeof raw.rateLimitCooldownMs === "number" ? raw.rateLimitCooldownMs : 60_000,
		quotaCooldownMs: typeof raw.quotaCooldownMs === "number" ? raw.quotaCooldownMs : 15 * 60_000,
		costBias: typeof raw.costBias === "number" && raw.costBias > 0 ? raw.costBias : 1,
		models: (raw.models as UpstreamEntry["models"] | undefined) ?? [],
	};
}

/** Replaces the live list's entries with completed ones, in place, when a patch touched them. */
export function completeUpstreams(cfg: { upstreams: UpstreamEntry[] }): void {
	const completed = cfg.upstreams.map((u) => completeUpstreamEntry(u as unknown as Record<string, unknown>));
	cfg.upstreams.splice(0, cfg.upstreams.length, ...completed);
}
