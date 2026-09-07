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
		usage?: { monthlyUsedFraction?: number | null; activityCostUsd?: number | null; plan?: string | null; fetchedAtMs?: number | null } | null;
		meter?: { usedUsd?: number; creditsUsd?: number; plan?: string | null } | null;
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
		const meter = o.meter !== undefined && o.meter !== null && o.meter.usedUsd !== undefined ? ` ($${o.meter.usedUsd.toFixed(2)} of $${o.meter.creditsUsd ?? "?"})` : "";
		const planName = o.meter?.plan ?? o.usage?.plan ?? null;
		const usage = frac === undefined || frac === null ? "plan usage unknown" : `${planName === null ? "plan" : `${planName} plan`} usage ${(frac * 100).toFixed(1)}%${meter}`;
		const bias = o.costBias === undefined ? "" : ` · cost bias ×${o.costBias.effective ?? o.costBias.configured ?? 1} (until ${((o.costBias.biasUntilUsage ?? 1) * 100).toFixed(0)}%)`;
		const trip = o.lastTrip !== undefined && o.lastTrip !== null ? ` · last trip ${o.lastTrip.kind ?? "?"}${o.lastTrip.atMs ? ` ${mins(nowMs - o.lastTrip.atMs)} ago` : ""}` : "";
		out.push(`ollama cloud: ${o.models ?? 0} models · ${avail} · key ${o.apiKeySource ?? "?"} · ${usage}${bias}${trip}`);
	}
	const a = h.agentdox;
	out.push(a === undefined || a === null ? "agentdox: off" : `agentdox: ${a.url ?? "?"} scope ${a.defaultScope ?? "?"}${a.recordTurns === true ? " · recording turns" : ""}`);
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// /router why, feedback, pin, tier
// ---------------------------------------------------------------------------

/** The decision fields `/router why` renders, as `/v1/router/decisions` returns them. */
export interface WhyEntry {
	id: string;
	createdAtMs: number;
	turn: number;
	slug: string;
	servedSlug: string | null;
	tier: string;
	classificationSource: string;
	confidence: number | null;
	task: string | null;
	reasons: string[];
	classifierReasons: string[] | null;
	reportedUsd: number | null;
	predictedUsd: number;
	usage: { promptTokens: number; cachedTokens: number; completionTokens: number; cachedEstimated?: boolean };
	latencyMs: number;
	ttftMs: number | null;
	attempt: number;
	escalationSignal: string | null;
	feedback?: Array<{ verdict: string; note: string; createdAtMs: number }>;
}

const money = (v: number): string => (v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`);

/** Plain-text explanation of one routed turn. */
export function renderWhy(e: WhyEntry, nowMs = Date.now()): string {
	const served = e.servedSlug ?? e.slug;
	const provider = served.startsWith("ollama/") ? "ollama" : "openrouter";
	const cache = e.usage.promptTokens > 0 ? `${((100 * e.usage.cachedTokens) / e.usage.promptTokens).toFixed(0)}%${e.usage.cachedEstimated === true ? " est." : ""}` : "–";
	const age = Math.max(0, nowMs - e.createdAtMs);
	const ago = age < 60_000 ? `${Math.round(age / 1000)}s ago` : age < 3_600_000 ? `${Math.round(age / 60_000)}m ago` : `${(age / 3_600_000).toFixed(1)}h ago`;
	const out: string[] = [];
	out.push(`turn ${e.turn} · ${ago} · ${provider} · ${served}${e.servedSlug !== null && e.servedSlug !== e.slug ? ` (asked ${e.slug})` : ""} [${e.tier}${e.attempt > 0 ? `, attempt ${e.attempt + 1}` : ""}]`);
	out.push(
		`classified ${e.tier} by ${e.classificationSource}${e.confidence !== null ? ` at ${(e.confidence * 100).toFixed(0)}% confidence` : ""}${e.task !== null ? ` · task ${e.task}` : ""}`,
	);
	out.push(
		`cost ${money(e.reportedUsd ?? e.predictedUsd)}${e.reportedUsd === null ? " (forecast)" : ""} · prompt ${e.usage.promptTokens.toLocaleString("en-US")} tok (cache ${cache}) · completion ${e.usage.completionTokens.toLocaleString("en-US")} tok · ttft ${e.ttftMs === null ? "–" : `${(e.ttftMs / 1000).toFixed(1)}s`} · total ${(e.latencyMs / 1000).toFixed(1)}s`,
	);
	if (e.escalationSignal !== null) out.push(`escalation signal: ${e.escalationSignal}`);
	out.push("", "decision trail:");
	for (const r of e.reasons) out.push(`  - ${r}`);
	if (e.classifierReasons !== null && e.classifierReasons.length > 0) {
		out.push("", "classifier:");
		for (const r of e.classifierReasons) out.push(`  - ${r}`);
	}
	if (e.feedback !== undefined && e.feedback.length > 0) {
		out.push("", "feedback:");
		for (const f of e.feedback) out.push(`  - ${f.verdict}${f.note !== "" ? `: ${f.note}` : ""}`);
	}
	out.push("", `judge it: /router good  or  /router bad [note]`);
	return out.join("\n");
}

export type OverrideRequest = { kind: "pin"; slug: string | null } | { kind: "tier"; tier: string | null; turns: number } | { kind: "show" } | { kind: "clear" } | { kind: "error"; message: string };

const TIERS = ["trivial", "simple", "moderate", "hard"];

/** Parses `/router pin <slug|off>` and `/router tier <tier|off> [turns]`. */
export function parseOverrideArgs(verb: "pin" | "tier", text: string): OverrideRequest {
	const parts = text.trim().split(/\s+/).filter((t) => t !== "");
	const first = parts[0] ?? "";
	if (first === "") return { kind: "show" };
	if (["off", "clear", "none"].includes(first.toLowerCase())) return verb === "pin" ? { kind: "pin", slug: null } : { kind: "tier", tier: null, turns: 0 };
	if (verb === "pin") return { kind: "pin", slug: first };
	const tier = first.toLowerCase();
	if (!TIERS.includes(tier)) return { kind: "error", message: `unknown tier "${first}" (${TIERS.join(" | ")} | off)` };
	const turns = parts[1] === undefined ? 10 : Number.parseInt(parts[1], 10);
	if (!Number.isInteger(turns) || turns < 0) return { kind: "error", message: `turns must be a whole number (0 = until cleared), got "${parts[1]}"` };
	return { kind: "tier", tier, turns };
}

/** One-line description of a live override, for notifications. */
export function describeOverride(o: { slug: string | null; tier: string | null; turnsLeft: number } | null): string {
	if (o === null || (o.slug === null && o.tier === null)) return "no override on this session";
	const parts: string[] = [];
	if (o.slug !== null) parts.push(`pinned to ${o.slug}`);
	if (o.tier !== null) parts.push(`tier forced to ${o.tier}`);
	return `${parts.join(", ")} · ${o.turnsLeft === 0 ? "until cleared" : `${o.turnsLeft} turn${o.turnsLeft === 1 ? "" : "s"} left`}`;
}
