/**
 * OpenCode plugin: auto-model-router native features.
 *
 * OpenCode reaches the router through an OpenAI-compatible provider block
 * (see README, "OpenCode"). This plugin adds what the provider block cannot:
 *
 * - **Session identity** — `chat.headers` adds `X-Omp-Session`,
 *   `X-Omp-Harness` and, for a session with a parent (a subagent),
 *   `X-Omp-Subagent`, so per-session reports, feedback and the router's
 *   subagent profile work as in omp.
 * - **Routing toast** — when a session goes idle, the model, tier and cost of
 *   its last routed turn are shown as a TUI toast (nothing in `run` mode).
 * - **Tool-result digest** — `tool.execute.after` sends a large read, grep,
 *   glob, bash or webfetch result to the router's `/v1/router/digest` and
 *   hands the model the digest instead. The router decides (policy, session
 *   tier, cost guard). Off unless `digest.enabled` is set in the router config.
 *
 * Install: copy this file to `~/.config/opencode/plugin/auto-model-router.ts`
 * (or `.opencode/plugin/` in a project). OpenCode loads it on start. The
 * router URL is `AUTO_MODEL_ROUTER_URL`, else port `AUTO_MODEL_ROUTER_PORT`
 * (default 8788) on localhost.
 */

import type { Plugin } from "@opencode-ai/plugin";

const PROVIDER_ID = "auto-model-router";
const BASE_URL = process.env.AUTO_MODEL_ROUTER_URL ?? `http://127.0.0.1:${process.env.AUTO_MODEL_ROUTER_PORT ?? "8788"}`;
const HARNESS_ID = process.env.OMP_HARNESS_ID ?? "opencode";
const POLICY_TTL_MS = 60_000;

interface DigestPolicy {
	enabled: boolean;
	minBytes: number;
	maxBytes: number;
	tools: string[];
	toolAliases: Record<string, string>;
}
const DISABLED: DigestPolicy = { enabled: false, minBytes: 0, maxBytes: 0, tools: [], toolAliases: {} };

function parsePolicy(json: unknown): DigestPolicy {
	if (json === null || typeof json !== "object") return DISABLED;
	const p = json as Record<string, unknown>;
	if (p.enabled !== true) return DISABLED;
	return {
		enabled: true,
		minBytes: typeof p.minBytes === "number" ? p.minBytes : 12_000,
		maxBytes: typeof p.maxBytes === "number" ? p.maxBytes : 400_000,
		tools: Array.isArray(p.tools) ? p.tools.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()) : [],
		toolAliases: p.toolAliases !== null && typeof p.toolAliases === "object" ? Object.fromEntries(Object.entries(p.toolAliases as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string")) : {},
	};
}

/** Whether a tool result is worth sending: policy on, eligible tool, size in the window. */
export function shouldDigest(policy: DigestPolicy, tool: string, text: string): boolean {
	if (!policy.enabled) return false;
	const lower = tool.toLowerCase();
	if (!policy.tools.includes(policy.toolAliases[lower] ?? lower)) return false;
	const bytes = Buffer.byteLength(text);
	return bytes >= policy.minBytes && bytes <= policy.maxBytes;
}

/** One toast line for the last routed turn of a session. */
export function toastLine(e: { slug?: string; servedSlug?: string; tier?: string; reportedUsd?: number | null; predictedUsd?: number }): string {
	const slug = e.servedSlug ?? e.slug ?? "?";
	const provider = slug.startsWith("ollama/") ? "ollama" : "openrouter";
	const usd = e.reportedUsd ?? e.predictedUsd ?? 0;
	return `${provider} · ${slug.replace(/^ollama\//, "")} [${e.tier ?? "?"}] · $${usd.toFixed(5)}`;
}

export const AutoModelRouter: Plugin = async ({ client }) => {
	let policy = DISABLED;
	let policyAtMs = 0;
	const parents = new Map<string, string | null>();
	const lastToasted = new Map<string, string>();

	async function refreshPolicy(): Promise<DigestPolicy> {
		if (Date.now() - policyAtMs < POLICY_TTL_MS) return policy;
		policyAtMs = Date.now();
		try {
			const res = await fetch(`${BASE_URL}/v1/router/digest/policy`, { signal: AbortSignal.timeout(2_000) });
			policy = res.ok ? parsePolicy(await res.json()) : DISABLED;
		} catch {
			policy = DISABLED;
		}
		return policy;
	}

	async function parentOf(sessionID: string): Promise<string | null> {
		const known = parents.get(sessionID);
		if (known !== undefined) return known;
		let parent: string | null = null;
		try {
			const res = await client.session.get({ path: { id: sessionID } });
			parent = res.data?.parentID ?? null;
		} catch {
			parent = null;
		}
		parents.set(sessionID, parent);
		return parent;
	}

	async function toast(sessionID: string): Promise<void> {
		try {
			const res = await fetch(`${BASE_URL}/v1/router/decisions?limit=1&session=${encodeURIComponent(sessionID)}`, { signal: AbortSignal.timeout(2_000) });
			if (!res.ok) return;
			const body = (await res.json()) as { entries?: { id: string; slug?: string; servedSlug?: string; tier?: string; reportedUsd?: number | null; predictedUsd?: number }[] };
			const entry = body.entries?.[0];
			if (entry === undefined || lastToasted.get(sessionID) === entry.id) return;
			lastToasted.set(sessionID, entry.id);
			await client.tui.showToast({ body: { title: "auto-model-router", message: toastLine(entry), variant: "info", duration: 4_000 } });
		} catch {
			// No TUI (run mode) or router down: nothing to show.
		}
	}

	return {
		"chat.headers": async (input, output) => {
			if (input.model.providerID !== PROVIDER_ID) return;
			output.headers["X-Omp-Session"] = input.sessionID;
			output.headers["X-Omp-Harness"] = HARNESS_ID;
			if ((await parentOf(input.sessionID)) !== null) output.headers["X-Omp-Subagent"] = "1";
		},
		event: async ({ event }) => {
			if (event.type === "session.created") {
				const info = (event as { properties: { info: { id: string; parentID?: string } } }).properties.info;
				parents.set(info.id, info.parentID ?? null);
			} else if (event.type === "session.idle") {
				await toast((event as { properties: { sessionID: string } }).properties.sessionID);
			}
		},
		"tool.execute.after": async (input, output) => {
			const p = await refreshPolicy();
			if (typeof output.output !== "string" || !shouldDigest(p, input.tool, output.output)) return;
			try {
				const res = await fetch(`${BASE_URL}/v1/router/digest`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ ompSessionId: input.sessionID, harnessId: HARNESS_ID, toolName: input.tool, input: input.args ?? {}, content: output.output, query: "" }),
					signal: AbortSignal.timeout(30_000),
				});
				if (!res.ok) return;
				const r = (await res.json()) as { digested: boolean; text?: string };
				if (r.digested && typeof r.text === "string") output.output = r.text;
			} catch {
				// Router unreachable or slow: the raw result stands.
			}
		},
	};
};

export default AutoModelRouter;
