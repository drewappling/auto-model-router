/**
 * omp extension: toast the routed model on every turn.
 *
 * auto-model-router itself is a headless HTTP server — it cannot render anything in
 * omp's TUI. This extension bridges that gap: it polls the router's decision
 * ledger (`GET /v1/router/decisions`) and raises a TUI toast via
 * `ctx.ui.notify(...)` whenever a new model is chosen for a turn.
 *
 * Install by adding this file's absolute path to omp's `extensions:` list:
 *
 *   # ~/.omp/agent/config.yml
 *   extensions:
 *     - /path/to/auto-model-router/omp-extension/router-embed.ts
 *     - /path/to/auto-model-router/omp-extension/router-toast.ts
 *
 * Because the embedded router binds a random OS-assigned port and writes it to
 * the port file, the toast resolves the base URL fresh on EVERY poll: the port
 * file first, then `AUTO_MODEL_ROUTER_URL`, then `AUTO_MODEL_ROUTER_PORT`, then the router's
 * own config.yml. Reading the port file each tick means the toast always polls
 * the port the router actually bound, even though it changes every session.
 *
 * When the router is configured with `server.apiKey`, set AUTO_MODEL_ROUTER_API_KEY so
 * the poll authenticates.
 */



import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { routerAuthHeaders, routerBaseUrl } from "./router-url.ts";
import { newestId, selectToasts, type ToastDecision } from "./toast-logic.ts";

/** Raw router config.yml, or null when there is none to read. */

/** Absolute path of the shared embed port file (main session writes it). */

// This harness's id, matching the X-Omp-Harness header the router records.
// Empty ⇒ toast every harness (single-harness default).
const HARNESS_ID = process.env.OMP_HARNESS_ID ?? "";
const POLL_MS = 2_000;

export default function (pi: ExtensionAPI): void {
	pi.setLabel("auto-model-router toast");

	// The newest ledger entry already toasted. Ledger is `created_at_ms DESC`.
	let lastSeenId: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		// Headless/print/subagent sessions have no UI to toast into; skip the
		// poll loop entirely rather than waking every 2s to do nothing.
		if (!ctx.hasUI) return;

		// This session's omp id. The embed extension tags every request with it
		// (X-Omp-Session), so filtering on it scopes toasts to this session even
		// when several omp sessions share one embedded router's ledger.
		const sessionId = ctx.sessionManager.getSessionId();

		// The poll request's own deadline (3s) exceeds the poll period (2s), so
		// a slow router could let a second tick start while the first is still in
		// flight — both read the same lastSeenId and raise duplicate toasts. An
		// in-flight flag makes each tick a no-op while the previous is outstanding.
		let polling = false;

		const timer = ctx.setInterval(async () => {
			if (polling) return;
			polling = true;
			try {
				// The embedded router binds a free OS-assigned port, so the URL
				// is resolved fresh each tick from the port file the embed
				// extension writes at session_start.
				// Team-client mode resolves to the team endpoint with the member key.
				const routerUrl = routerBaseUrl();

				let res: Response;
				try {
					res = await fetch(`${routerUrl}/v1/router/decisions?limit=20`, {
						headers: routerAuthHeaders(),
						signal: AbortSignal.timeout(3_000),
					});
				} catch {
					return; // router down; nothing to toast, retry next tick
				}
				if (!res.ok) return;

				let body: { entries?: ToastDecision[] };
				try {
					body = (await res.json()) as { entries?: ToastDecision[] };
				} catch {
					return;
				}
				const entries = body.entries;
				if (!Array.isArray(entries) || entries.length === 0) return;

				for (const t of selectToasts(entries, lastSeenId, HARNESS_ID, sessionId)) {
					ctx.ui.notify(t.text, "info");
				}
				lastSeenId = newestId(entries) ?? lastSeenId;
			} catch {
				// isolated by ctx.setInterval; nothing to escalate
			} finally {
				polling = false;
			}
		}, POLL_MS);
		pi.on("session_shutdown", () => ctx.clearTimer(timer));
	});
}
