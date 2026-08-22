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
 *   1. an explicit `OMP_ROUTER_URL` override;
 *   2. the embedded router's port file (`embedPort`, when it holds a valid
 *      port) — the embed extension binds a free OS-assigned port and writes it
 *      to the port file, so the toast must poll that actual address;
 *   3. an explicit `OMP_ROUTER_PORT` (`envPort`);
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
}

export interface ToastMessage {
	model: string;
	tier: string;
	costUsd: number | null;
	/** Human-readable line for `ctx.ui.notify`. */
	text: string;
}

export function toToastText(d: ToastDecision): string {
	const model = d.servedSlug ?? d.slug;
	const cost = d.reportedUsd === null ? "" : ` \u00b7 $${d.reportedUsd.toFixed(5)}`;
	return `${model} [${d.tier}]${cost}`;
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
		out.push({ model: d.servedSlug ?? d.slug, tier: d.tier, costUsd: d.reportedUsd, text: toToastText(d) });
	}
	return out;
}

/** The newest entry id in a newest-first list, for advancing `lastSeenId`. */
export function newestId(entries: ToastDecision[]): string | null {
	const first = entries[0];
	return first === undefined ? null : first.id;
}
