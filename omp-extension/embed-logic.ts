/**
 * Pure embed configuration logic, extracted from the omp extension so it can
 * be unit-tested without omp's runtime or a live Bun.serve.
 *
 * The embedded router runs IN the main omp process and binds a free
 * OS-assigned port (`port: 0`). Subagents do NOT bind their own router — they
 * route to the main session's router, whose bound port is published in a
 * single shared file. This avoids the PID-reuse race: subagents are ephemeral
 * worker processes whose PIDs get recycled, so keying a port file by PID means
 * a subagent can read a stale file written by a dead worker that reused its
 * PID. One shared file, written only by the main session, has exactly one
 * authoritative writer.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The provider id registered into omp. Kept stable so a `models.yml` that
 * already pins `baseUrl`/`auth` for the same id is overridden by the
 * extension (extension registration wins at runtime).
 */
export const EMBED_PROVIDER_ID = "auto-model-router";

/**
 * A dummy bearer the extension registers so omp treats the provider as
 * authenticated. The router's `server.apiKey` is unset by default, so it does
 * not enforce auth; the value only needs to satisfy omp's "has credentials"
 * gate.
 */
export const EMBED_DUMMY_API_KEY = "embedded";

/**
 * Filename (in `$AUTO_MODEL_ROUTER_HOME` / `~/.auto-model-router`) of the shared embed port
 * file. Written only by the main session's router; read by every subagent and
 * the toast. A single writer and single file means there is never a stale
 * per-PID file pointing at a recycled process's dead port.
 */
export const EMBED_PORT_FILE = "embed.port";

export interface EmbedModelSpec {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface EmbedConfig {
	port: number;
	host: string;
	baseUrl: string;
	models: EmbedModelSpec[];
	harnessId?: string;
	/**
	 * agentdox project scope sent as `X-Agentdox-Scope`. Selects which
	 * project's shared context is injected into every turn, so switching
	 * models never loses the project's memory/docs/brief.
	 */
	agentdoxScope?: string;
}

/**
 * Derives an agentdox project slug from the omp workspace directory.
 *
 * The workspace basename is the one identifier that is already stable, already
 * per-project, and requires no configuration — the same convention agentdox's
 * own `project_ensure` slugs follow. It WINS over `context.defaultScope`,
 * which is a fallback for workspaces it cannot resolve; see
 * `buildProviderConfig`.
 */
export function deriveAgentdoxScope(cwd: string): string {
	// Both separators: omp reports a Windows cwd with backslashes.
	const cleaned = cwd.replace(/[\\/]+$/, "");
	const base = cleaned.split(/[\\/]/).pop() ?? "";
	return base
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * Resolves the port the embedded router should serve on, in precedence order:
 * an explicit `AUTO_MODEL_ROUTER_PORT`, else the configured `server.port`, else
 * 0 (let the OS pick a free one).
 *
 * A STABLE port is what keeps omp's model resolution honest. omp resolves
 * `modelRoles.default` from `models.yml` during startup — BEFORE extensions
 * load, so before this session can bind and rewrite that file. With an
 * ephemeral port the block names the PREVIOUS session's port, which is dead
 * once that session exits, and every main-agent turn fails with "Unable to
 * connect" while utility calls (resolved later, from the live registration)
 * still work. A deterministic port makes the pre-bind block correct by
 * construction. Sessions sharing that port share one router, which is already
 * how subagents behave.
 *
 * `0` is still honoured when asked for explicitly, and remains the fallback
 * when the desired port is occupied by something that is not our router.
 */
export function resolveEmbedPort(envPort: string | undefined, configuredPort = 0): number {
	if (envPort !== undefined && envPort !== "") {
		const port = Number.parseInt(envPort, 10);
		if (Number.isInteger(port) && port >= 0 && port <= 65_535) return port;
	}
	if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535) return configuredPort;
	return 0;
}

/**
 * Absolute path of the shared embed port file under a router home directory.
 */
export function embedPortPath(homeDir: string): string {
	return join(homeDir, EMBED_PORT_FILE);
}

/**
 * Persists the embedded router's actual bound port so subagents and the toast
 * can follow it. Creates the parent directory when absent.
 */
export function writeEmbedPort(path: string, port: number): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, String(port), "utf8");
}

/**
 * Reads the embedded router's last-known port from the port file, or null when
 * the file is absent/unreadable/malformed.
 */
export function readEmbedPort(path: string): number | null {
	try {
		const raw = readFileSync(path, "utf8").trim();
		const port = Number.parseInt(raw, 10);
		if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
		return null;
	} catch {
		return null;
	}
}

/**
 * Checks the shared router actually answers before a subagent registers it.
 * The port file outlives the process that wrote it, so a stale entry is normal:
 * registering against a dead port would produce a provider whose every turn
 * fails with connection refused. A failed health check means "bind your own".
 */
export async function probeEmbed(port: number, timeoutMs = 1_000): Promise<boolean> {
	try {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), timeoutMs);
		try {
			const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal });
			return res.ok;
		} finally {
			clearTimeout(timer);
		}
	} catch {
		return false;
	}
}

/**
 * Builds the provider config for `pi.registerProvider(EMBED_PROVIDER_ID, …)`
 * given the shared bound port. `models` are the router's own `profiles`, mapped
 * into omp's provider-model shape (cost is USD per million tokens, same unit
 * `renderProviderBlock` uses for `config --write`). A wildcard listen address
 * maps to loopback, since a wildcard is not a connectable target.
 */
export function buildProviderConfig(
	port: number,
	cfg: {
		server: { host: string; harnessId?: string };
		profiles: Array<{ id: string; name: string; contextWindow: number; maxTokens: number }>;
		ledger: { fallbackBlend: { inputPerMtok: number; outputPerMtok: number } };
		context?: { enabled: boolean; defaultScope: string };
	},
	/** omp's workspace directory, used to derive a scope when none is configured. */
	cwd?: string,
): EmbedConfig {
	const host = cfg.server.host === "0.0.0.0" || cfg.server.host === "::" ? "127.0.0.1" : cfg.server.host;
	const round = (v: number): number => Math.round(v * 1e4) / 1e4;
	const input = cfg.ledger.fallbackBlend.inputPerMtok;
	const output = cfg.ledger.fallbackBlend.outputPerMtok;
	const cacheRead = input * 0.1;
	const cacheWrite = input * 1.25;
	const models = cfg.profiles.map((p) => ({
		id: p.id,
		name: p.name,
		contextWindow: p.contextWindow,
		maxTokens: p.maxTokens,
		cost: { input: round(input), output: round(output), cacheRead: round(cacheRead), cacheWrite: round(cacheWrite) },
	}));
	const out: EmbedConfig = {
		port,
		host,
		baseUrl: `http://${host}:${port}/v1`,
		models,
	};
	if (cfg.server.harnessId !== undefined && cfg.server.harnessId !== "") {
		out.harnessId = cfg.server.harnessId;
	}
	if (cfg.context?.enabled === true) {
		// The WORKSPACE wins. `defaultScope` is a scope-agnostic global — one
		// router install serves every project on the machine — so letting it
		// override the per-workspace derivation sends one project's slug for all
		// of them: an ashlands session shipped `X-Agentdox-Scope: omp-router`,
		// which both injected the wrong project's context and filed its turns
		// under the wrong scope. The server treats this field as a fallback too
		// ("the configured default covers harnesses that send none"), so the two
		// sides now agree: most specific signal first.
		const derived = deriveAgentdoxScope(cwd ?? "");
		const scope = derived !== "" ? derived : cfg.context.defaultScope;
		if (scope !== "") out.agentdoxScope = scope;
	}
	return out;
}
