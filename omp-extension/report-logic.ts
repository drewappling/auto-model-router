/**
 * Pure logic behind `/router report` and `/router status`: argument parsing,
 * fetching the report over the router's HTTP API with a direct-ledger
 * fallback, and rendering the health snapshot. Kept free of omp types so it
 * is unit-testable with a fake fetch.
 */

import type { UsageReport } from "../src/cost/report.ts";

export interface ReportRequest {
	windowDays: number;
	/** Empty ⇒ every harness. */
	harnessId: string;
}

/**
 * Parses the free text after `/router report`: an optional window (`7`,
 * `7d`, `24h`, `2w`) and `--all` to drop the harness scope. Anything
 * unrecognised is ignored rather than failing the command.
 */
export function parseReportArgs(text: string, defaultHarness: string, defaultDays = 7): ReportRequest {
	let windowDays = defaultDays;
	let harnessId = defaultHarness;
	for (const tok of text.trim().split(/\s+/).filter((t) => t !== "")) {
		const lower = tok.toLowerCase();
		if (lower === "--all" || lower === "all") {
			harnessId = "";
			continue;
		}
		if (lower.startsWith("--harness=")) {
			harnessId = tok.slice("--harness=".length);
			continue;
		}
		const m = /^(\d+)(d|h|w)?$/.exec(lower);
		if (m === null) continue;
		const n = Number.parseInt(m[1] ?? "0", 10);
		if (!Number.isInteger(n) || n <= 0) continue;
		const unit = m[2] ?? "d";
		windowDays = unit === "h" ? Math.max(1, Math.ceil(n / 24)) : unit === "w" ? n * 7 : n;
	}
	return { windowDays: Math.min(windowDays, 365), harnessId };
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** GETs the report from the running router; throws on any failure. */
export async function fetchReport(
	baseUrl: string,
	req: ReportRequest,
	headers: Record<string, string>,
	fetchImpl: FetchLike = fetch,
	timeoutMs = 5_000,
): Promise<UsageReport> {
	const params = new URLSearchParams({ days: String(req.windowDays) });
	if (req.harnessId !== "") params.set("harness", req.harnessId);
	const res = await fetchImpl(`${baseUrl}/v1/router/report?${params.toString()}`, {
		headers,
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`router returned ${res.status}`);
	return (await res.json()) as UsageReport;
}

/** The subset of `/health` the status view renders. */
export interface HealthSnapshot {
	status?: string;
	apiKeyConfigured?: boolean;
	apiKeySource?: string;
	agentdox?: { url?: string; defaultScope?: string; recordTurns?: boolean } | null;
	ollama?: {
		baseUrl?: string;
		apiKeySource?: string;
		models?: number;
		available?: boolean;
		cooldownUntilMs?: number | null;
		lastTrip?: { kind?: string; atMs?: number; message?: string } | null;
		usage?: { monthlyUsedFraction?: number | null; activityCostUsd?: number | null; fetchedAtMs?: number | null } | null;
		costBias?: { configured?: number; effective?: number; biasUntilUsage?: number };
	} | null;
	catalog?: {
		models?: number;
		ageMs?: number;
		keyScoped?: boolean;
		shrink?: { fromModels?: number; toModels?: number; atMs?: number } | null;
	} | null;
}

const mins = (ms: number): string => (ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);

/** Renders `/health` as a few plain lines for the transcript. */
export function renderStatus(baseUrl: string, h: HealthSnapshot, nowMs = Date.now()): string {
	const out: string[] = [`auto-model-router at ${baseUrl}: ${h.status ?? "unknown"}`];
	out.push(`openrouter: key ${h.apiKeyConfigured === true ? `configured (${h.apiKeySource ?? "?"})` : "MISSING"}`);
	const c = h.catalog;
	if (c !== undefined && c !== null) {
		const shrink = c.shrink !== undefined && c.shrink !== null ? ` · SHRANK ${c.shrink.fromModels ?? "?"} -> ${c.shrink.toModels ?? "?"}` : "";
		out.push(`catalog: ${c.models ?? 0} models · refreshed ${mins(c.ageMs ?? 0)} ago${c.keyScoped === true ? " · key-scoped" : ""}${shrink}`);
	} else {
		out.push("catalog: not fetched yet");
	}
	const o = h.ollama;
	if (o === undefined || o === null) {
		out.push("ollama cloud: disabled");
	} else {
		const avail = o.available === true ? "available" : `COOLING DOWN${o.cooldownUntilMs ? ` until ${new Date(o.cooldownUntilMs).toLocaleTimeString()}` : ""}`;
		const frac = o.usage?.monthlyUsedFraction;
		const usage = frac === undefined || frac === null ? "plan usage unknown" : `plan usage ${(frac * 100).toFixed(0)}%`;
		const bias = o.costBias === undefined ? "" : ` · cost bias ×${o.costBias.effective ?? o.costBias.configured ?? 1} (until ${((o.costBias.biasUntilUsage ?? 1) * 100).toFixed(0)}%)`;
		const trip = o.lastTrip !== undefined && o.lastTrip !== null ? ` · last trip ${o.lastTrip.kind ?? "?"}${o.lastTrip.atMs ? ` ${mins(nowMs - o.lastTrip.atMs)} ago` : ""}` : "";
		out.push(`ollama cloud: ${o.models ?? 0} models · ${avail} · key ${o.apiKeySource ?? "?"} · ${usage}${bias}${trip}`);
	}
	const a = h.agentdox;
	out.push(a === undefined || a === null ? "agentdox: off" : `agentdox: ${a.url ?? "?"} scope ${a.defaultScope ?? "?"}${a.recordTurns === true ? " · recording turns" : ""}`);
	return out.join("\n");
}
