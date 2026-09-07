/**
 * omp extension: condense large tool results with a cheap model before an
 * expensive one reads them.
 *
 * Tool results are the bulk of every prompt, and a prompt is ~96% of spend.
 * When a read, grep, glob or bash result is large and this session's
 * current model sits at or above the router's `digest.fromTier`, the raw
 * text goes to the router's `/v1/router/digest`, a simple-tier model
 * rewrites it to what the task needs, and the digest replaces the tool
 * result. The digest starts with a marker saying how to get the full output
 * back (re-run the tool, or read a line range), so nothing is lost.
 *
 * The router decides (policy, session tier, cost guard); this extension only
 * ships text that passes the cheap client-side checks. Off unless
 * `digest.enabled` is set in the router config.
 *
 * Install beside router-embed.ts:
 *
 *   # ~/.omp/agent/config.yml
 *   extensions:
 *     - /path/to/auto-model-router/omp-extension/router-embed.ts
 *     - /path/to/auto-model-router/omp-extension/router-digest.ts
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { DISABLED_POLICY, digestToast, parsePolicy, shouldSend, textOf, type DigestPolicy } from "./digest-logic.ts";
import { routerAuthHeaders, routerBaseUrl } from "./router-url.ts";

const HARNESS_ID = process.env.OMP_HARNESS_ID ?? "";
/** Re-read the policy this often, so a config change lands without a restart. */
const POLICY_TTL_MS = 60_000;

export default function (pi: ExtensionAPI): void {
	pi.setLabel("auto-model-router digest");

	let policy: DigestPolicy = DISABLED_POLICY;
	let policyAtMs = 0;
	let lastUserText = "";

	async function refreshPolicy(): Promise<void> {
		if (Date.now() - policyAtMs < POLICY_TTL_MS) return;
		policyAtMs = Date.now();
		try {
			const res = await fetch(`${routerBaseUrl()}/v1/router/digest/policy`, { headers: routerAuthHeaders(), signal: AbortSignal.timeout(2_000) });
			policy = res.ok ? parsePolicy(await res.json()) : DISABLED_POLICY;
		} catch {
			policy = DISABLED_POLICY;
		}
	}

	pi.on("session_start", async () => {
		policyAtMs = 0;
		await refreshPolicy();
	});

	// The user's latest ask steers what the digest keeps.
	pi.on("input", (event) => {
		const e = event as { text?: string };
		if (typeof e.text === "string" && e.text.trim() !== "") lastUserText = e.text.trim().slice(0, 400);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const e = event as { toolName: string; input: Record<string, unknown>; content: Array<{ type: string; text?: string }>; isError: boolean };
		await refreshPolicy();
		const { text, hasImage } = textOf(e.content);
		if (!shouldSend(policy, e.toolName, e.isError, text, hasImage)) return undefined;
		try {
			const res = await fetch(`${routerBaseUrl()}/v1/router/digest`, {
				method: "POST",
				headers: { ...routerAuthHeaders(), "content-type": "application/json" },
				body: JSON.stringify({
					ompSessionId: ctx.sessionManager.getSessionId(),
					harnessId: HARNESS_ID,
					toolName: e.toolName,
					input: e.input,
					content: text,
					query: lastUserText,
				}),
				signal: AbortSignal.timeout(30_000),
			});
			if (!res.ok) return undefined;
			const r = (await res.json()) as { digested: boolean; text?: string; model?: string; usd?: number; inputBytes?: number; outputChars?: number };
			if (!r.digested || typeof r.text !== "string") return undefined;
			if (ctx.hasUI) ctx.ui.notify(digestToast(e.toolName, r.inputBytes ?? 0, r.outputChars ?? 0, r.model ?? "?", r.usd ?? 0), "info");
			return { content: [{ type: "text", text: r.text }] };
		} catch {
			// Router unreachable or slow: the raw result stands.
			return undefined;
		}
	});
}
