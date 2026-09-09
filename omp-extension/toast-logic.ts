/**
 * Pure toast selection logic, extracted from the omp extension so it can be
 * unit-tested without omp's runtime.
 *
 * The router ledger is ordered `created_at_ms DESC` (newest first). The toast
 * must:
 *   - only toast entries newer than the last one already seen;
 *   - skip `wasted` entries (escalation book-keeping — the abandoned probe
 *     attempt that was superseded and never served the client);
 *   - surface the attempt that actually served, oldest→newest.
 */

/**
 * The router's default listen port. Only used when nothing else identifies the
 * router, and deliberately NOT the last word: hardcoding it means polling
 * whatever else owns that port once the router has been moved, in which case
 * toasts simply never appear and nothing explains why.
 */
export const DEFAULT_ROUTER_URL = "http://127.0.0.1:8788";

/**
 * Resolves the router base URL from, in precedence order:
 *   1. an explicit `AUTO_MODEL_ROUTER_URL` override;
 *   2. the embedded router's port file (`embedPort`, when it holds a valid
 *      port) — the embed extension binds a free OS-assigned port and writes it
 *      to the port file, so the toast must poll that actual address;
 *   3. an explicit `AUTO_MODEL_ROUTER_PORT` (`envPort`);
 *   4. the `server` block of the router's own config;
 *   5. `DEFAULT_ROUTER_URL`.
 *
 * `configText` is the raw config.yml contents, or null when absent/unreadable.
 * `parseYaml` is injected so this stays dependency-free and testable.
 */
export function resolveRouterUrl(
	envUrl: string | undefined,
	configText: string | null,
	parseYaml: (text: string) => unknown,
	envPort?: string,
	embedPort?: number | null,
): string {
	if (envUrl !== undefined && envUrl !== "") return envUrl;

	let port: number | undefined;
	if (embedPort !== undefined && embedPort !== null) {
		port = embedPort;
	} else if (envPort !== undefined && envPort !== "") {
		const parsedPort = Number.parseInt(envPort, 10);
		if (Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65_535) port = parsedPort;
	}
	const envWins = port !== undefined;

	if (configText === null) return envWins ? `http://127.0.0.1:${port}` : DEFAULT_ROUTER_URL;

	let parsed: unknown;
	try {
		parsed = parseYaml(configText);
	} catch {
		return envWins ? `http://127.0.0.1:${port}` : DEFAULT_ROUTER_URL;
	}
	if (typeof parsed !== "object" || parsed === null) return envWins ? `http://127.0.0.1:${port}` : DEFAULT_ROUTER_URL;
	const server: unknown = (parsed as Record<string, unknown>).server;
	if (typeof server !== "object" || server === null) return envWins ? `http://127.0.0.1:${port}` : DEFAULT_ROUTER_URL;

	const rec = server as Record<string, unknown>;
	const resolvedPort = envWins
		? port!
		: typeof rec.port === "number" && Number.isInteger(rec.port) && rec.port > 0
			? rec.port
			: 8788;
	const rawHost = typeof rec.host === "string" && rec.host !== "" ? rec.host : "127.0.0.1";
	// A wildcard listen address is not a connectable target.
	const host = rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
	return `http://${host}:${resolvedPort}`;
}

/** Subset of a ledger entry (see src/cost/types.ts LedgerEntry). */
export interface ToastDecision {
	id: string;
	slug: string;
	servedSlug: string | null;
	tier: string;
	reportedUsd: number | null;
	wasted: boolean;
	/** Harness id from the request header; empty for the default harness. */
	harnessId: string;
	/**
	 * omp UI session id from the `X-Omp-Session` header; empty for the no-header
	 * default. Lets the toast scope to a single interactive session.
	 */
	ompSessionId?: string;
	/** The router's own decision trail, already written for people. */
	reasons?: string[];
	/** Classifier inputs; only a few are worth surfacing. */
	features?: { promptTokens?: number; toolCount?: number; turnDepth?: number; isToolResultContinuation?: boolean } | null;
	/** Attempt index within the turn; >0 means this served after an escalation. */
	attempt?: number;
	/** Prompt tokens compaction removed before dispatch. */
	promptTokensSaved?: number;
	/** What the router expected this to cost, before the upstream reported. */
	predictedUsd?: number;
	latencyMs?: number;
	ttftMs?: number | null;
	task?: string | null;
	classificationSource?: string;
}

export interface ToastMessage {
	model: string;
	tier: string;
	costUsd: number | null;
	/** Human-readable line for `ctx.ui.notify`. */
	text: string;
}

/**
 * Provider and model for display. Catalog slugs namespace providers by
 * prefix: `ollama/<id>` is Ollama Cloud, anything else is OpenRouter (whose
 * slugs keep their vendor segment, e.g. `z-ai/glm-5.3-flash`). The Ollama
 * prefix is dropped from the displayed model since the provider label
 * already says it.
 */
export function providerOf(slug: string): { provider: string; model: string } {
	if (slug.startsWith("ollama/")) return { provider: "ollama", model: slug.slice("ollama/".length) };
	return { provider: "openrouter", model: slug };
}

/**
 * Which parts of the decision trail earn a line in a toast.
 *
 * The router writes many reasons per turn; a toast has room for two. These
 * patterns are ordered by how much they change what the reader would do:
 * a failover or a policy pin explains a surprising model outright, a hold or a
 * rescue explains why the obvious cheaper pick was skipped, and the rest is
 * ordinary ranking that the tier already conveys.
 */
const REASON_PRIORITY: readonly RegExp[] = [
	/failover|escalat/i,
	/policy|pin(ned)?|allow|deny/i,
	/held|sticky|hysteresis|switch margin/i,
	/budget raised|reasons before it answers/i,
	// The RESCUE wording only: "cheapest above the quality floor" is ordinary
	// ranking, and matching a bare "floor" would push it above real surprises.
	/tier rescue|relaxed|adaptive (floor|ceiling)/i,
	/cache|warm/i,
	/compact/i,
	/explor/i,
];

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Up to `limit` reasons, most explanatory first, each trimmed for one line. */
export function whyReasons(reasons: readonly string[] | undefined, limit = 2): string[] {
	if (reasons === undefined || reasons.length === 0) return [];
	const picked: string[] = [];
	const seen = new Set<number>();
	for (const re of REASON_PRIORITY) {
		for (let i = 0; i < reasons.length && picked.length < limit; i++) {
			const r = reasons[i];
			if (r === undefined || seen.has(i) || !re.test(r)) continue;
			seen.add(i);
			picked.push(clip(r.replace(/\s+/g, " ").trim(), 90));
		}
		if (picked.length >= limit) break;
	}
	// Nothing matched a pattern: the first reason is the ranking rationale itself.
	if (picked.length === 0 && reasons[0] !== undefined) picked.push(clip(reasons[0].replace(/\s+/g, " ").trim(), 90));
	return picked;
}

const tokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

/** The turn's shape in a few words: what the model was actually handed. */
export function factsOf(d: ToastDecision): string[] {
	const out: string[] = [];
	const f = d.features ?? undefined;
	if (f?.promptTokens !== undefined && f.promptTokens > 0) out.push(`${tokens(f.promptTokens)} prompt`);
	if (d.promptTokensSaved !== undefined && d.promptTokensSaved > 0) out.push(`${tokens(d.promptTokensSaved)} compacted`);
	if (f?.toolCount !== undefined && f.toolCount > 0) out.push(`${f.toolCount} tools`);
	if (f?.isToolResultContinuation === true) out.push("tool continuation");
	if (d.attempt !== undefined && d.attempt > 0) out.push(`attempt ${d.attempt + 1}`);
	if (d.task !== undefined && d.task !== null && d.task !== "" && d.task !== "coding") out.push(d.task);
	if (d.ttftMs !== undefined && d.ttftMs !== null && d.ttftMs > 0) out.push(`${(d.ttftMs / 1000).toFixed(1)}s to first token`);
	else if (d.latencyMs !== undefined && d.latencyMs > 0) out.push(`${(d.latencyMs / 1000).toFixed(1)}s`);
	return out;
}

/** `$0.00042`, or the prediction when the upstream reported nothing. */
function costOf(d: ToastDecision): string {
	if (d.reportedUsd !== null && d.reportedUsd !== undefined) return `$${d.reportedUsd.toFixed(5)}`;
	if (d.predictedUsd !== undefined && d.predictedUsd > 0) return `~$${d.predictedUsd.toFixed(5)}`;
	return "";
}

/**
 * The toast body. `verbose` (the default) adds the decision trail and the
 * turn's shape under the headline; `compact` is the original single line, for
 * anyone who wants the model name and nothing else.
 */
export function toToastText(d: ToastDecision, verbose = true): string {
	const { provider, model } = providerOf(d.servedSlug ?? d.slug);
	const cost = costOf(d);
	const head = `${provider} \u00b7 ${model} [${d.tier}]${cost === "" ? "" : ` \u00b7 ${cost}`}`;
	if (!verbose) return head;
	const lines = [head];
	const why = whyReasons(d.reasons);
	for (const [i, r] of why.entries()) lines.push(`${i === 0 ? "why: " : "     "}${r}`);
	const facts = factsOf(d);
	if (facts.length > 0) lines.push(facts.join(" \u00b7 "));
	return lines.join("\n");
}

/**
 * Given the newest-first ledger window and the last-toasted entry id, return
 * the new toasts to raise, oldest→newest. Pass `lastSeenId === null` on the
 * first tick to toast nothing (avoids a burst on startup).
 *
 * When `harnessId` is non-empty, only entries from that harness are toasted,
 * so multiple harnesses sharing one router don't spam each other's toasts.
 */
export function selectToasts(
	entries: ToastDecision[],
	lastSeenId: string | null,
	harnessId = "",
	ompSessionId = "",
	verbose = true,
): ToastMessage[] {
	if (lastSeenId === null) return [];
	// `entries` is newest-first. Entries strictly newer than lastSeenId are the
	// contiguous prefix before it. `-1` (id rolled out of the window) → treat
	// every entry as new.
	const idx = entries.findIndex((e) => e.id === lastSeenId);
	const newer = idx === -1 ? entries : entries.slice(0, idx);
	const out: ToastMessage[] = [];
	for (let i = newer.length - 1; i >= 0; i--) {
		const d = newer[i];
		if (d === undefined) continue;
		if (d.wasted) continue;
		if (harnessId !== "" && d.harnessId !== harnessId) continue;
		if (ompSessionId !== "" && d.ompSessionId !== ompSessionId) continue;
		out.push({ model: d.servedSlug ?? d.slug, tier: d.tier, costUsd: d.reportedUsd, text: toToastText(d, verbose) });
	}
	return out;
}

/** The newest entry id in a newest-first list, for advancing `lastSeenId`. */
export function newestId(entries: ToastDecision[]): string | null {
	const first = entries[0];
	return first === undefined ? null : first.id;
}
