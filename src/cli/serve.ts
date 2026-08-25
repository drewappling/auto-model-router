/**
 * Standalone `serve` command.
 *
 * Runs the router as its own process on a fixed port, independent of any omp
 * session. This is how non-Bun harnesses (Hermes, Claude, any OpenAI-compatible
 * client) connect: they point at `http://127.0.0.1:<port>/v1` and the router
 * routes each turn. The embedded omp extension is the zero-management path;
 * `serve` is the shared, always-on path for other harnesses.
 *
 * The core (`startServer`) is identical in both modes; only the process
 * ownership and port differ.
 */

import { apiKeySource, loadConfig } from "../config/load.ts";
import type { RouterConfig } from "../config/types.ts";
import { startServer } from "../server/http.ts";
import { createLogger } from "../util/log.ts";
import { configOpts, flagInt, flagString, type CliArgs } from "./args.ts";

const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;

export async function serveCommand(args: CliArgs): Promise<void> {
	// Sparse by design: only flags actually given override; deep merge fills the rest.
	const serverOverride: { host?: string; port?: number } = {};
	const port = flagInt(args, "port");
	if (port !== undefined) serverOverride.port = port;
	const host = flagString(args, "host");
	if (host !== undefined) serverOverride.host = host;

	const overrides: { server?: typeof serverOverride; logLevel?: string } = {};
	if (serverOverride.host !== undefined || serverOverride.port !== undefined) overrides.server = serverOverride;
	const logLevel = flagString(args, "log");
	if (logLevel !== undefined) {
		if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
			throw new Error(`--log must be one of ${LOG_LEVELS.join(", ")}, got "${logLevel}"`);
		}
		overrides.logLevel = logLevel;
	}

	const cfg = loadConfig(configOpts(args, overrides as Partial<RouterConfig>));
	const log = createLogger(cfg.logLevel);
	const { server, stop } = startServer(cfg);

	// Report the port the OS actually bound: `port: 0` asks for an ephemeral one.
	const addr = `http://${cfg.server.host}:${server.port}`;
	console.log(`auto-model-router listening on ${addr} (OpenAI-compatible endpoint at ${addr}/v1)`);

	// State the credential provenance up front. Silence here is how you end up
	// debugging 401s that were really "the key was never found".
	const credential = apiKeySource(cfg);
	if (credential.source === "none") {
		console.warn(`WARNING: no OpenRouter key resolved - ${credential.detail}`);
		console.warn("         the catalog will still load, but every completion will fail at dispatch");
	} else {
		console.log(`OpenRouter key: ${credential.detail}`);
	}

	let stopping = false;
	const shutdown = (signal: string): void => {
		if (stopping) return;
		stopping = true;
		log.info("shutting down", { signal });
		void stop().then(() => process.exit(0));
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}
