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

import { appendFileSync, readFileSync } from "node:fs";
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
 * Appends one line to `$AUTO_MODEL_ROUTER_HOME/embed.log`.
 *
 * A FILE, deliberately: `console.*` from an extension does not reach omp's
 * session log, so the first attempt at this diagnostic left no trace anywhere
 * and the port lifecycle had to be reconstructed from netstat and mtimes. Best
 * effort — a logging failure must never break a session.
 */
function writeEmbedLog(line: string): void {
	try {
		appendFileSync(join(routerHome(), "embed.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
	} catch {
		// Unwritable home: the router still works, we just lose the breadcrumb.
	}
}

/**
 * Stops the router when the PROCESS ends — never when a session does.
 * Idempotent: registered once, however many sessions this process hosts.
 */
let exitHooked = false;
function trackProcessExit(): void {
	if (exitHooked) return;
	exitHooked = true;
	// `exit` cannot await, and does not need to: the OS reclaims the socket.
	// The signal hooks exist so a Ctrl-C releases the port promptly.
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			void app?.stop().catch(() => {});
		});
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

/**
 * The router bound by THIS PROCESS, and the port it serves.
 *
 * Module scope on purpose: Bun caches the module per process, so when omp loads
 * the extension into a second host (its provider-refresh / reload path does
 * exactly that) these stay visible. A second host then REUSES this router
 * instead of binding another port and orphaning every model handle omp already
 * resolved against the first one.
 */
let app: StartedServer | null = null;
let boundPort: number | null = null;

/** `$AUTO_MODEL_ROUTER_HOME`, tilde-expanded, defaulting to ~/.auto-model-router. */
function routerHome(): string {
	const raw = process.env.AUTO_MODEL_ROUTER_HOME ?? join(homedir(), ".auto-model-router");
	return raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? join(homedir(), raw.slice(1)) : raw;
}

export default function (pi: ExtensionAPI): void {
	pi.setLabel("auto-model-router embed");

	// Shared port file, written only by the main session's router.
	const portFile = embedPortPath(routerHome());
	// Each interactive session binds its OWN router on an ephemeral port, so
	// sessions stay independent: no shared process to contend over, and no
	// session left broken because another one exited. `server.port` from
	// config.yml is deliberately NOT used here — that port belongs to the
	// standalone `serve` daemon, which may legitimately be running alongside.
	// Set AUTO_MODEL_ROUTER_PORT to pin a fixed port on purpose.
	const requestedPort = resolveEmbedPort(process.env.AUTO_MODEL_ROUTER_PORT);
	const cfg = loadConfig({ overrides: { server: { host: "127.0.0.1", port: requestedPort } } });

	pi.on("session_start", async (_event, ctx) => {
		// The omp UI session id tags every request so the toast can scope its
		// notifications to that exact session (see router-toast.ts).
		const sessionId = ctx.sessionManager.getSessionId();

		// This module is cached per PROCESS, so `app` and `boundPort` are
		// process-global even when omp loads the extension into more than one
		// host. A router already bound in this process is therefore reusable:
		// re-register it for the new session id and return. Never rebind — a
		// second bind would take a different port and orphan every model handle
		// omp already resolved against the first one.
		if (app !== null && boundPort !== null) {
			registerRouterProvider(pi, boundPort, cfg, sessionId);
			return;
		}

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
			boundPort = started.server.port;
			registerRouterProvider(pi, boundPort, cfg, sessionId);
			return;
		}

		// Main interactive session: bind this session's OWN router, then register
		// the provider against the exact bound port. Registration happens only
		// here — never at factory load, where a stale shared port would be
		// captured into omp's model registry and defeat the correct bound URL.

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
		boundPort = actualPort;

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

		// NO `session_shutdown` teardown. That event is emitted from session
		// DISPOSAL — including omp's provider-refresh / extension-reload path,
		// which runs in a throwaway extension host while the real session keeps
		// going. Because this module is cached per process, such a handler stops
		// the LIVE router: every subsequent turn then fails with Bun's
		// "Unable to connect", while utility calls that resolve after a later
		// rebind still work — the exact asymmetry observed in the field. The
		// router's lifetime is the PROCESS, and the OS reclaims the socket when
		// the process exits.
		trackProcessExit();

		writeEmbedLog(
			`embed ready pid=${process.pid} port=${actualPort}` +
				` models.yml-advertised=${advertised ?? "none"}` +
				` sync=${syncAction ?? "current"}` +
				` self-probe=${(await probeEmbed(actualPort)) ? "ok" : "FAILED"}` +
				` session=${sessionId}`,
		);
	});
}
