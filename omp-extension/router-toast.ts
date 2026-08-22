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
 * The router base URL is resolved in this order:
 *   1. `OMP_ROUTER_URL`
 *   2. `server.host`/`server.port` from the router's own
 *      `$OMP_ROUTER_HOME/config.yml` — the same file the router reads, so the
 *      extension can never drift from the port the router actually listens on
 *   3. `http://127.0.0.1:8787` (the built-in default port)
 *
 * Step 2 matters: hardcoding 8787 silently polls whatever else happens to own
 * that port when the router has been moved, and the toasts just never appear.
 *
 * When the router is configured with `server.apiKey`, set OMP_ROUTER_API_KEY so
 * the poll authenticates.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { newestId, resolveRouterUrl, selectToasts, type ToastDecision } from "./toast-logic.ts";

/** Raw router config.yml, or null when there is none to read. */
function readRouterConfig(): string | null {
	const raw = process.env.OMP_ROUTER_HOME ?? join(homedir(), ".omp-router");
	const home =
		raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? join(homedir(), raw.slice(1)) : raw;
	const path = join(home, "config.yml");
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

const ROUTER_URL = resolveRouterUrl(process.env.OMP_ROUTER_URL, readRouterConfig(), parseYaml);
const ROUTER_API_KEY = process.env.OMP_ROUTER_API_KEY;
// This harness's id, matching the X-Omp-Harness header the router records.
// Empty ⇒ toast every harness (single-harness default).
const HARNESS_ID = process.env.OMP_HARNESS_ID ?? "";
const POLL_MS = 2_000;

export default function (pi: ExtensionAPI): void {
	pi.setLabel("omp-router toast");

	// The newest ledger entry already toasted. Ledger is `created_at_ms DESC`.
	let lastSeenId: string | null = null;

	pi.on("session_start", (_event, ctx) => {
		// Headless/print/subagent sessions have no UI to toast into; skip the
		// poll loop entirely rather than waking every 2s to do nothing.
		if (!ctx.hasUI) return;

		// The poll request's own deadline (3s) exceeds the poll period (2s), so
		// a slow router could let a second tick start while the first is still in
		// flight — both read the same lastSeenId and raise duplicate toasts. An
		// in-flight flag makes each tick a no-op while the previous is outstanding.
		let polling = false;

		const timer = ctx.setInterval(async () => {
			if (polling) return;
			polling = true;
			try {
				let res: Response;
				try {
					res = await fetch(`${ROUTER_URL}/v1/router/decisions?limit=20`, {
						headers: ROUTER_API_KEY === undefined ? {} : { authorization: `Bearer ${ROUTER_API_KEY}` },
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

				for (const t of selectToasts(entries, lastSeenId, HARNESS_ID)) {
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
