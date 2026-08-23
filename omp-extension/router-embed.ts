/**
 * omp extension: run omp-router IN the omp process.
 *
 * The MAIN omp session embeds the router: it binds a free OS-assigned port,
 * publishes it to the shared `$OMP_ROUTER_HOME/embed.port`, and registers the
 * omp-router provider. Subagents do NOT bind their own router — they are
 * ephemeral worker processes whose PIDs get recycled, so a per-PID port file
 * is a race. Instead every subagent registers the same shared provider and
 * routes to the main session's single router.
 *
 * The discriminator is `ctx.hasUI`: the main interactive session has a UI,
 * subagents do not.
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

/**
 * Registers the omp-router provider (and its virtual models) into omp's model
 * registry at a specific bound port.
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

	const requestedPort = resolveEmbedPort(process.env.OMP_ROUTER_PORT);

	// Shared port file, written only by the main session's router.
	const homeRaw = process.env.OMP_ROUTER_HOME ?? join(homedir(), ".omp-router");
	const home =
		homeRaw === "~" || homeRaw.startsWith("~/") || homeRaw.startsWith("~\\")
			? join(homedir(), homeRaw.slice(1))
			: homeRaw;
	const portFile = embedPortPath(home);

	// Subagents route to the main's router: at factory load, register the
	// provider against the shared port so a fresh subagent registry can reach
	// it. If the shared file isn't ready yet, defer to session_start (the main
	// will have written it by then). Never register an invalid port 0.
	const loadCfg = loadConfig({ overrides: { server: { host: "127.0.0.1", port: requestedPort } } });
	const sharedPort = readEmbedPort(portFile);
	if (sharedPort !== null) registerRouterProvider(pi, sharedPort, loadCfg);

	let app: StartedServer | null = null;

	pi.on("session_start", (_event, ctx) => {
		// Subagents do not bind their own router; they route to the main's.
		// Register the shared port (in case the factory-load read was stale or
		// the file was not yet written) and return.
		if (!ctx.hasUI) {
			const port = readEmbedPort(portFile);
			if (port !== null) registerRouterProvider(pi, port, loadCfg);
			return;
		}

		// Main interactive session: bind the router once.
		if (app) return;
		const cfg = loadConfig({
			overrides: {
				server: { host: "127.0.0.1", port: requestedPort },
			},
		});
		const started = startServer(cfg);
		const actualPort = started.server.port;
		if (actualPort === undefined) return;
		app = started;

		// Publish the shared port; subagents and the toast read it from here.
		writeEmbedPort(portFile, actualPort);
		registerRouterProvider(pi, actualPort, cfg);

		pi.on("session_shutdown", () => {
			void app?.stop().catch(() => {});
			app = null;
		});
	});
}
