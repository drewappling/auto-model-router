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

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { ompModelsPath, syncModelsYml } from "../src/cli/config-cmd.ts";
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
	modelsYmlPort,
	probeEmbed,
	resolveEmbedPort,
	writeEmbedPort,
} from "./embed-logic.ts";

/** omp's models.yml as text, or "" when it does not exist / cannot be read. */
function readModelsYml(): string {
	try {
		return readFileSync(ompModelsPath(), "utf8");
	} catch {
		return "";
	}
}

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

	// Shared port file, written only by the main session's router.
	const homeRaw = process.env.AUTO_MODEL_ROUTER_HOME ?? join(homedir(), ".auto-model-router");
	const home =
		homeRaw === "~" || homeRaw.startsWith("~/") || homeRaw.startsWith("~\\")
			? join(homedir(), homeRaw.slice(1))
			: homeRaw;
	const portFile = embedPortPath(home);
	// Load first WITHOUT a port override so `server.port` from config.yml is
	// visible, then let it (or the env var) decide the bind port.
	const cfg = loadConfig({ overrides: { server: { host: "127.0.0.1" } } });
	const requestedPort = resolveEmbedPort(process.env.AUTO_MODEL_ROUTER_PORT, cfg.server.port);
	cfg.server.port = requestedPort;

	let app: StartedServer | null = null;

	pi.on("session_start", async (_event, ctx) => {
		// The omp UI session id tags every request so the toast can scope its
		// notifications to that exact session (see router-toast.ts).
		const sessionId = ctx.sessionManager.getSessionId();
		if (!ctx.hasUI) {
			// Subagents and headless (-p) sessions prefer the main session's
			// shared router: one process, one ledger, one place to inspect.
			// The main writes the port file before spawning subagents.
			const shared = readEmbedPort(portFile);
			if (shared !== null && (await probeEmbed(shared))) {
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

		// Main interactive session. The port is deterministic (see
		// resolveEmbedPort), which matters because omp resolves
		// `modelRoles.default` from models.yml BEFORE this extension loads: the
		// URL that block names must be one this session will actually serve.
		if (app) return;

		// Another live session already serving this port? Share it rather than
		// fighting over the socket — subagents already share one router, and the
		// ledger and DB are shared regardless.
		if (requestedPort !== 0 && (await probeEmbed(requestedPort))) {
			writeEmbedPort(portFile, requestedPort);
			syncModelsYml(cfg, requestedPort);
			registerRouterProvider(pi, requestedPort, cfg, sessionId);
			pi.setLabel(`auto-model-router embed (shared :${requestedPort})`);
			return;
		}

		// Bind the desired port; if something that is NOT our router holds it,
		// fall back to an ephemeral port rather than leaving the session with no
		// provider at all. models.yml is rewritten either way, so headless runs
		// and subagents still resolve.
		let started: StartedServer;
		try {
			started = startServer(cfg);
		} catch (err) {
			if (requestedPort === 0) throw err;
			cfg.server.port = 0;
			started = startServer(cfg);
		}
		const actualPort = started.server.port;
		if (actualPort === undefined) return;
		app = started;

		// Publish the shared port; subagents and the toast read it from here.
		writeEmbedPort(portFile, actualPort);

		// What omp resolved `modelRoles.default` against at STARTUP, before this
		// extension loaded. If it names a different port than we serve, this
		// session's main-model handle points at a socket we are not listening on
		// and every real turn fails with "Unable to connect" while utility calls
		// (resolved later, from the registration below) still work. Nothing here
		// can rebuild that handle, so say so plainly instead of leaving the user
		// to diagnose it.
		const advertised = modelsYmlPort(readModelsYml());
		if (advertised !== null && advertised !== actualPort) {
			pi.setLabel(`auto-model-router: RESTART NEEDED — omp resolved :${advertised}, router serves :${actualPort}`);
			console.warn(
				`[auto-model-router] models.yml advertised port ${advertised} at startup but this router serves ${actualPort}. ` +
					`omp resolves the default model before extensions load, so this session's main model still points at ${advertised}. ` +
					`models.yml has been corrected — restart omp once and it will be right.`,
			);
		}

		// Keep models.yml pointing at this port. Headless runs (`-p`) and
		// subagent processes resolve models from models.yml in a FRESH registry
		// — extension registration does not reach them — so without this they
		// fail with "Model not found" when no interactive session is live
		// (the print-mode gap the external benchmark hit).
		const syncAction = syncModelsYml(cfg, actualPort);
		if (syncAction !== null && advertised === actualPort) pi.setLabel(`auto-model-router embed (models.yml ${syncAction})`);
		registerRouterProvider(pi, actualPort, cfg, sessionId);

		pi.on("session_shutdown", () => {
			void app?.stop().catch(() => {});
			app = null;
		});
	});
}
