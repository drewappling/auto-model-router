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
 * sessions run simultaneously without colliding: each gets its own ephemeral
 * port. The actual bound port is read back off the server, published to the
 * port file (`$OMP_ROUTER_HOME/embed.port`), and used to point omp's provider
 * at the right address.
 *
 * The server lives and dies with the omp session, so there is never an orphan
 * process and never an "is the router running?" failure mode.
 *
 * Install by adding this file's absolute path to omp's `extensions:` list:
 *
 *   # ~/.omp/agent/config.yml
 *   extensions:
 *     - /path/to/omp-router/omp-extension/router-embed.ts
 *     - /path/to/omp-router/omp-extension/router-toast.ts
 *
 * The toast extension reads the same port file so it polls the port this
 * session actually bound. Do NOT run `omp-router serve` and this extension in
 * the same process namespace on the same port — that is a bind conflict.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/load.ts";
import { startServer } from "../src/server/http.ts";
import type { StartedServer } from "../src/server/http.ts";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import {
	buildProviderConfig,
	EMBED_DUMMY_API_KEY,
	EMBED_PROVIDER_ID,
	embedPortPath,
	resolveEmbedPort,
	writeEmbedPort,
} from "./embed-logic.ts";

export default function (pi: ExtensionAPI): void {
	pi.setLabel("omp-router embed");

	// A free ephemeral port unless the user pins one with OMP_ROUTER_PORT.
	const requestedPort = resolveEmbedPort(process.env.OMP_ROUTER_PORT);

	// Resolve the router home so the port file lands where the toast will look.
	const homeRaw = process.env.OMP_ROUTER_HOME ?? join(homedir(), ".omp-router");
	const home =
		homeRaw === "~" || homeRaw.startsWith("~/") || homeRaw.startsWith("~\\")
			? join(homedir(), homeRaw.slice(1))
			: homeRaw;
	const portFile = embedPortPath(home);

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

		// Publish the real port so the toast extension can poll it.
		writeEmbedPort(portFile, actualPort);

		// Point omp's provider at the port we actually bound.
		const providerConfig = buildProviderConfig(actualPort, cfg);
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

		pi.on("session_shutdown", () => {
			void app?.stop().catch(() => {});
			app = null;
		});
	});
}
