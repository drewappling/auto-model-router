/**
 * omp extension: run omp-router IN the omp process.
 *
 * This is the primary way to run the router. Instead of a separate
 * `omp-router serve` process that can die and leave omp unable to connect, the
 * router starts as part of the omp session: it registers itself as an
 * `omp-router` provider (so omp can select its `auto` models) and binds
 * `Bun.serve` in-process on a free OS-assigned port.
 *
 * Binding on a free port (via `port: 0`) is what lets several local omp
 * processes run simultaneously without colliding: each gets its own ephemeral
 * port. The actual bound port is read back off the server, published to a
 * PID-scoped port file (`$OMP_ROUTER_HOME/embed.<pid>.port`), and used to
 * point omp's provider at the right address. Scoping by PID avoids a
 * cross-process race: every omp process (main session or subagent) embeds its
 * OWN router, so the port file is keyed to the process that bound it.
 *
 * The server lives and dies with the omp process, so there is never an orphan
 * process and never an "is the router running?" failure mode.
 *
 * The provider is registered AT FACTORY LOAD so subagents and async tasks —
 * which build a fresh model registry and load this extension via
 * `preloadedExtensionPaths` — still get the omp-router provider and its dummy
 * key even before `session_start` fires. `session_start` re-registers with the
 * exact bound port.
 *
 * Install by adding this file's absolute path to omp's `extensions:` list:
 *
 *   # ~/.omp/agent/config.yml
 *   extensions:
 *     - /path/to/omp-router/omp-extension/router-embed.ts
 *     - /path/to/omp-router/omp-extension/router-toast.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/load.ts";
import { startServer } from "../src/server/http.ts";
import type { StartedServer } from "../src/server/http.ts";
import type { RouterConfig } from "../src/config/types.ts";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import {
	buildProviderConfig,
	EMBED_DUMMY_API_KEY,
	EMBED_PROVIDER_ID,
	embedPortPath,
	readEmbedPort,
	resolveEmbedPort,
	writeEmbedPort,
} from "./embed-logic.ts";

/** The PID of the process running this extension (main session or subagent). */
const MY_PID = process.pid;

/**
 * Registers the omp-router provider (and its virtual models) into omp's model
 * registry at a specific bound port. Shared by the factory-load registration
 * and the session_start re-registration.
 */
function registerRouterProvider(pi: ExtensionAPI, port: number, cfg: RouterConfig): void {
	const providerConfig = buildProviderConfig(port, cfg);
	pi.registerProvider(EMBED_PROVIDER_ID, {
		baseUrl: providerConfig.baseUrl,
		api: "openai-completions",
		apiKey: EMBED_DUMMY_API_KEY,
		...(providerConfig.harnessId !== undefined && providerConfig.harnessId !== ""
			? { headers: { "X-Omp-Harness": providerConfig.harnessId } }
			: {}),
		models: providerConfig.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: "openai-completions",
			reasoning: false,
			input: ["text", "image"],
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			cost: {
				input: m.cost.input,
				output: m.cost.output,
				cacheRead: m.cost.cacheRead,
				cacheWrite: m.cost.cacheWrite,
			},
		})),
	});
}

export default function (pi: ExtensionAPI): void {
	pi.setLabel("omp-router embed");

	// A free ephemeral port unless the user pins one with OMP_ROUTER_PORT.
	const requestedPort = resolveEmbedPort(process.env.OMP_ROUTER_PORT);

	// Resolve the router home so the PID-scoped port file lands where the toast
	// will look.
	const homeRaw = process.env.OMP_ROUTER_HOME ?? join(homedir(), ".omp-router");
	const home =
		homeRaw === "~" || homeRaw.startsWith("~/") || homeRaw.startsWith("~\\")
			? join(homedir(), homeRaw.slice(1))
			: homeRaw;
	const portFile = embedPortPath(home, MY_PID);

	// Register the provider AT FACTORY LOAD so subagents that build a fresh
	// model registry and load this extension get the omp-router provider + key
	// even before their session_start. BUT only when a port is actually known:
	// `requestedPort` defaults to 0 (let the OS pick), and the PID port file is
	// written by session_start — so on a fresh process neither exists yet, and
	// registering with port 0 would point omp at http://127.0.0.1:0/v1, an
	// invalid URL that fails every dispatch. Register at load only when the
	// PID file already holds this process's bound port; otherwise session_start
	// is the one that binds and registers, and nothing forwards an invalid port.
	const loadCfg = loadConfig({ overrides: { server: { host: "127.0.0.1", port: requestedPort } } });
	const knownPort = readEmbedPort(portFile) ?? (requestedPort > 0 ? requestedPort : null);
	if (knownPort !== null) registerRouterProvider(pi, knownPort, loadCfg);

	let app: StartedServer | null = null;

	pi.on("session_start", (_event, _ctx) => {
		if (app) return;

		// Bind on the OS-assigned port (0 = let the kernel pick a free one).
		const cfg = loadConfig({
			overrides: {
				server: { host: "127.0.0.1", port: requestedPort },
			},
		});
		const started = startServer(cfg);
		// Bun reports the actual bound port on the server after a 0-port bind.
		const actualPort = started.server.port;
		if (actualPort === undefined) return;
		app = started;

		// Publish this process's port so the toast polls the right one.
		writeEmbedPort(portFile, actualPort);

		// Re-register with the exact bound port, overwriting the load-time
		// registration that used the (possibly stale) requested port.
		registerRouterProvider(pi, actualPort, cfg);

		pi.on("session_shutdown", () => {
			void app?.stop().catch(() => {});
			app = null;
		});
	});
}
