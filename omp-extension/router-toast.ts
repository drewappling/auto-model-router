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
 *     - /path/to/omp-router/omp-extension/router-embed.ts
 *     - /path/to/omp-router/omp-extension/router-toast.ts
 *
 * Because the embedded router binds a random OS-assigned port and writes it to
 * the port file, the toast resolves the base URL fresh on EVERY poll: the port
 * file first, then `OMP_ROUTER_URL`, then `OMP_ROUTER_PORT`, then the router's
 * own config.yml. Reading the port file each tick means the toast always polls
 * the port the router actually bound, even though it changes every session.
 *
 * When the router is configured with `server.apiKey`, set OMP_ROUTER_API_KEY so
 * the poll authenticates.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { embedPortPath, readEmbedPort } from "./embed-logic.ts";
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

/** Absolute path of the embed port file under the router home directory. */
function embedPortFile(): string {
	const raw = process.env.OMP_ROUTER_HOME ?? join(homedir(), ".omp-router");
	const home =
		raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? join(homedir(), raw.slice(1)) : raw;
	return embedPortPath(home);
}

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
				// The embedded router binds a free OS-assigned port, so the URL
				// is resolved fresh each tick from the port file the embed
				// extension writes at session_start.
				const embedPort = readEmbedPort(embedPortFile());
				const routerUrl = resolveRouterUrl(
					process.env.OMP_ROUTER_URL,
					readRouterConfig(),
					parseYaml,
					process.env.OMP_ROUTER_PORT,
					embedPort,
				);

				let res: Response;
				try {
					res = await fetch(`${routerUrl}/v1/router/decisions?limit=20`, {
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
