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
	// Each interactive session binds its OWN router on an ephemeral port, so
	// sessions stay independent: no shared process to contend over, and no
	// session left broken because another one exited. `server.port` from
	// config.yml is deliberately NOT used here — that port belongs to the
	// standalone `serve` daemon, which may legitimately be running alongside.
	// Set AUTO_MODEL_ROUTER_PORT to pin a fixed port on purpose.
	const requestedPort = resolveEmbedPort(process.env.AUTO_MODEL_ROUTER_PORT);
	const cfg = loadConfig({ overrides: { server: { host: "127.0.0.1", port: requestedPort } } });

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

		// Main interactive session: bind this session's OWN router, then register
		// the provider against the exact bound port. Registration happens only
		// here — never at factory load, where a stale shared port would be
		// captured into omp's model registry and defeat the correct bound URL.
		if (app) return;

		// A fixed port was asked for (env var) and a live router already answers
		// there: share it rather than failing to bind. Ephemeral ports — the
		// default — never take this path, so sessions stay independent.
		if (requestedPort !== 0 && (await probeEmbed(requestedPort))) {
			writeEmbedPort(portFile, requestedPort);
			syncModelsYml(cfg, requestedPort);
			registerRouterProvider(pi, requestedPort, cfg, sessionId);
			pi.setLabel(`auto-model-router embed (shared :${requestedPort})`);
			return;
		}

		// Bind. If a FIXED port was requested and something else holds it, fall
		// back to an ephemeral one rather than leaving this session with no
		// provider at all. An ephemeral request that fails is a real error.
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

		// Publish the port; subagents and the toast read it from here.
		writeEmbedPort(portFile, actualPort);

		// Keep models.yml pointing at this port. Headless runs (`-p`) and
		// subagent processes resolve models from models.yml in a FRESH registry
		// — extension registration does not reach them — so without this they
		// fail with "Model not found" when no interactive session is live
		// (the print-mode gap the external benchmark hit).
		const advertised = modelsYmlPort(readModelsYml());
		const syncAction = syncModelsYml(cfg, actualPort);

		// Register BEFORE any await: everything omp resolves after this point
		// picks up the live URL, so the registration must not sit behind I/O.
		registerRouterProvider(pi, actualPort, cfg, sessionId);
		pi.setLabel(`auto-model-router embed :${actualPort}${syncAction === null ? "" : ` (models.yml ${syncAction})`}`);

		pi.on("session_shutdown", () => {
			void app?.stop().catch(() => {});
			app = null;
		});

		// Diagnostic, not a guess. "provider error: Unable to connect" on real
		// turns while utility calls keep working means omp dialled an address
		// this router does not serve — and that text is Bun's fetch error, which
		// names no URL. Log the facts that distinguish the cases: the port bound,
		// the port models.yml advertised BEFORE the sync above, and whether our
		// own socket answers.
		const selfProbeOk = await probeEmbed(actualPort);
		console.info(
			`[auto-model-router] embed ready: serving :${actualPort}` +
				` | models.yml advertised :${advertised ?? "none"} at startup` +
				` | self-probe ${selfProbeOk ? "ok" : "FAILED"}` +
				` | session ${sessionId}`,
		);
		if (!selfProbeOk) pi.setLabel(`auto-model-router: BOUND :${actualPort} BUT NOT ANSWERING`);
	});
}
