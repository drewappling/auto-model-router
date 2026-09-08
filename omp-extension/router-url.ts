/**
 * Where the router is listening, resolved fresh on every call.
 *
 * The embedded router binds a free OS-assigned port and writes it to the
 * port file at session start, so nothing can cache the URL: the toast poll,
 * `/router report` and `/router status` all resolve it at the moment of use.
 * Precedence: `AUTO_MODEL_ROUTER_URL`, the embed port file,
 * `AUTO_MODEL_ROUTER_PORT`, then `server.port` in the router's config.yml.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import { embedPortPath, readEmbedPort } from "./embed-logic.ts";
import { readRemoteRouter } from "./remote-logic.ts";
import { resolveRouterUrl } from "./toast-logic.ts";

/** `$AUTO_MODEL_ROUTER_HOME` with `~` expanded, default `~/.auto-model-router`. */
export function routerHome(): string {
	const raw = process.env.AUTO_MODEL_ROUTER_HOME ?? join(homedir(), ".auto-model-router");
	return raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? join(homedir(), raw.slice(1)) : raw;
}

/** Raw router config.yml, or null when there is none to read. */
export function readRouterConfigText(): string | null {
	const path = join(routerHome(), "config.yml");
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Base URL of the router this omp process should talk to. */
export function routerBaseUrl(): string {
	// Remote mode: the router elsewhere is the router.
	const remote = readRemoteRouter(routerHome());
	if (remote !== null) return remote.url;
	return resolveRouterUrl(
		process.env.AUTO_MODEL_ROUTER_URL,
		readRouterConfigText(),
		parseYaml,
		process.env.AUTO_MODEL_ROUTER_PORT,
		readEmbedPort(embedPortPath(routerHome())),
	);
}

/** Authorization header for a router configured with `server.apiKey`. */
export function routerAuthHeaders(): Record<string, string> {
	const remote = readRemoteRouter(routerHome());
	if (remote !== null) return { authorization: `Bearer ${remote.key}` };
	const key = process.env.AUTO_MODEL_ROUTER_API_KEY;
	return key === undefined || key === "" ? {} : { authorization: `Bearer ${key}` };
}
