/**
 * omp extension: toast the routed model on every turn.
 *
 * omp-router itself is a headless HTTP server — it cannot render anything in
 * omp's TUI. This extension bridges that gap: it polls the router's decision
 * ledger (`GET /v1/router/decisions`) and raises a TUI toast via
 * `ctx.ui.notify(...)` whenever a new model is chosen for a turn.
 *
 * Install by adding this file's absolute path to omp's `extensions:` list:
 *
 *   # ~/.omp/agent/config.yml
 *   extensions:
 *     - /path/to/omp-router/omp-extension/router-toast.ts
 *
 * The router base URL can be overridden with the OMP_ROUTER_URL env var;
 * it defaults to http://127.0.0.1:8788.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { newestId, selectToasts, toToastText, type ToastDecision } from "./toast-logic.ts";

const ROUTER_URL = process.env.OMP_ROUTER_URL ?? "http://127.0.0.1:8788";
const POLL_MS = 2_000;

export default function (pi: ExtensionAPI): void {
	pi.setLabel("omp-router toast");

	// The newest ledger entry already toasted. Ledger is `created_at_ms DESC`.
	let lastSeenId: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		const timer = ctx.setInterval(async () => {
			try {
				if (!ctx.hasUI) return;

				let res: Response;
				try {
					res = await fetch(`${ROUTER_URL}/v1/router/decisions?limit=20`, {
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

				for (const t of selectToasts(entries, lastSeenId)) {
					ctx.ui.notify(t.text, "info");
				}
				lastSeenId = newestId(entries) ?? lastSeenId;
			} catch {
				// isolated by ctx.setInterval; nothing to escalate
			}
		}, POLL_MS);
		pi.on("session_shutdown", () => ctx.clearTimer(timer));
	});
}
