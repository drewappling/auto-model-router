/**
 * omp extension: run auto-model-router IN the omp process.
 *
 * The MAIN omp session embeds the router: it binds a free OS-assigned port,
 * publishes it to the shared `$AUTO_MODEL_ROUTER_HOME/embed.port`, and registers the
 * auto-model-router provider. Subagents do NOT bind their own router — they are
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
 *     - /path/to/auto-model-router/omp-extension/router-embed.ts
 *     - /path/to/auto-model-router/omp-extension/router-toast.ts
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { syncModelsYml } from "../src/cli/config-cmd.ts";
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
	probeEmbed,
	resolveEmbedPort,
	writeEmbedPort,
} from "./embed-logic.ts";

/**
 * Registers the auto-model-router provider (and its virtual models) into omp's model
 * registry at a specific bound port.
 */
function registerRouterProvider(pi: ExtensionAPI, port: number, cfg: RouterConfig, sessionId: string): void {
	// cwd is omp's workspace, which is what the agentdox scope is derived from
	// when none is configured explicitly.
	const providerConfig = buildProviderConfig(port, cfg, process.cwd());
	const headers: Record<string, string> = {};
	if (providerConfig.harnessId !== undefined && providerConfig.harnessId !== "") {
		headers["X-Omp-Harness"] = providerConfig.harnessId;
	}
	// Per-session scoping: lets the toast surface only this session's decisions
	// even when several omp sessions share one embedded router's ledger.
	if (sessionId !== "") headers["X-Omp-Session"] = sessionId;
	// Which agentdox project's shared context this workspace's turns draw on.
	if (providerConfig.agentdoxScope !== undefined && providerConfig.agentdoxScope !== "") {
		headers["X-Agentdox-Scope"] = providerConfig.agentdoxScope;
	}
	pi.registerProvider(EMBED_PROVIDER_ID, {
		baseUrl: providerConfig.baseUrl,
		api: "openai-completions",
		apiKey: EMBED_DUMMY_API_KEY,
		...(Object.keys(headers).length > 0 ? { headers } : {}),
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
	pi.setLabel("auto-model-router embed");

	const requestedPort = resolveEmbedPort(process.env.AUTO_MODEL_ROUTER_PORT);

	// Shared port file, written only by the main session's router.
	const homeRaw = process.env.AUTO_MODEL_ROUTER_HOME ?? join(homedir(), ".auto-model-router");
	const home =
		homeRaw === "~" || homeRaw.startsWith("~/") || homeRaw.startsWith("~\\")
			? join(homedir(), homeRaw.slice(1))
			: homeRaw;
	const portFile = embedPortPath(home);
	const cfg = loadConfig({ overrides: { server: { host: "127.0.0.1", port: requestedPort } } });

	let app: StartedServer | null = null;

	pi.on("session_start", (_event, ctx) => {
		// The omp UI session id tags every request so the toast can scope its
		// notifications to that exact session (see router-toast.ts).
		const sessionId = ctx.sessionManager.getSessionId();
		if (!ctx.hasUI) {
			// Subagents and headless (-p) sessions prefer the main session's
			// shared router: one process, one ledger, one place to inspect.
			// The main writes the port file before spawning subagents.
			const shared = readEmbedPort(portFile);
			if (shared !== null && probeEmbed(shared)) {
				registerRouterProvider(pi, shared, cfg, sessionId);
				return;
			}
			// No live interactive session (headless batch runs, CI, the
			// benchmark harness): fall back to binding a private router so
			// `--model auto-model-router/auto` still resolves. Ephemeral by
			// design — it dies with this process and never writes the shared
			// port file, so it can never hijack another session's subagents.
			const started = startServer(cfg);
			if (started.server.port === undefined) return;
			app = started;
			registerRouterProvider(pi, started.server.port, cfg, sessionId);
			pi.on("session_shutdown", () => {
				void app?.stop().catch(() => {});
				app = null;
			});
			return;
		}

		// Main interactive session: bind the router once, then register the
		// provider against the exact bound port. Registration happens only
		// here — never at factory load, where a stale shared port would be
		// captured into omp's model registry and defeat the correct bound URL.
		if (app) return;
		const started = startServer(cfg);
		const actualPort = started.server.port;
		if (actualPort === undefined) return;
		app = started;

		// Publish the shared port; subagents and the toast read it from here.
		writeEmbedPort(portFile, actualPort);

		// Keep models.yml pointing at this port. Headless runs (`-p`) and
		// subagent processes resolve models from models.yml in a FRESH registry
		// — extension registration does not reach them — so without this they
		// fail with "Model not found" when no interactive session is live
		// (the print-mode gap the external benchmark hit). Registration still
		// wins at runtime, so a live session always overrides a stale block.
		const syncAction = syncModelsYml(cfg, actualPort);
		if (syncAction !== null) pi.setLabel(`auto-model-router embed (models.yml ${syncAction})`);
		registerRouterProvider(pi, actualPort, cfg, sessionId);

		pi.on("session_shutdown", () => {
			void app?.stop().catch(() => {});
			app = null;
		});
	});
}
