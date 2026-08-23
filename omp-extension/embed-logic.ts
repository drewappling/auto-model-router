/**
 * Pure embed configuration logic, extracted from the omp extension so it can
 * be unit-tested without omp's runtime or a live Bun.serve.
 *
 * The embedded router runs IN the omp process and binds a free OS-assigned
 * port (`port: 0`), so several omp sessions can run simultaneously without
 * ever colliding on a fixed port. The actual bound port is surfaced two ways:
 *   1. the embed extension reads it back off `Bun.serve` and points omp's
 *      provider at it, and
 *   2. it is written to a well-known file so the toast extension can discover
 *      it too — the toast cannot precompute a random port, so it reads the
 *      file on every poll.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The provider id registered into omp. Kept stable so a `models.yml` that
 * already pins `baseUrl`/`auth` for the same id is overridden by the
 * extension (extension registration wins at runtime).
 */
export const EMBED_PROVIDER_ID = "omp-router";

/**
 * A dummy bearer the extension registers so omp treats the provider as
 * authenticated. The router's `server.apiKey` is unset by default, so it does
 * not enforce auth; the value only needs to satisfy omp's "has credentials"
 * gate.
 */
export const EMBED_DUMMY_API_KEY = "embedded";

/**
 * Filename prefix (in `$OMP_ROUTER_HOME` / `~/.omp-router`) of the PID-scoped
 * embed port file. The full name is `embed.<pid>.port` (see embedPortPath).
 */
export const EMBED_PORT_FILE = "embed";

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
}

/**
 * Resolves the desired bind port: an explicit `OMP_ROUTER_PORT` when set and
 * valid, else `0` so Bun assigns a free ephemeral port (the "random port" that
 * lets multiple local omp sessions coexist without colliding). Returning 0
 * means "let the OS pick"; the caller must read the actual port back off the
 * started server.
 */
export function resolveEmbedPort(envPort: string | undefined): number {
	if (envPort !== undefined && envPort !== "") {
		const port = Number.parseInt(envPort, 10);
		if (Number.isInteger(port) && port >= 0 && port <= 65_535) return port;
	}
	return 0;
}

/**
 * Absolute path of the PID-scoped embed port file under a router home
 * directory. Each omp process — the main session and every subagent — embeds
 * its OWN router on its OWN random port, so a single shared `embed.port` is a
 * cross-process race: whichever process writes last wins, and every other
 * process reads a port that is not its own. Scoping by PID means each process
 * (and its toast) reads exactly the port its own router bound.
 */
export function embedPortPath(homeDir: string, pid: number): string {
	return join(homeDir, EMBED_PORT_FILE + "." + pid);
}

/**
 * Persists the embedded router's actual bound port so the toast extension can
 * follow it. Creates the parent directory when absent.
 */
export function writeEmbedPort(path: string, port: number): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, String(port), "utf8");
}

/**
 * Reads the embedded router's last-known port from the port file, or null when
 * the file is absent/unreadable/malformed. This is the value the toast must
 * poll, since a random port cannot be guessed.
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
 * Builds the provider config for `pi.registerProvider(EMBED_PROVIDER_ID, …)`
 * given the ACTUAL bound port (which may differ from the requested one when
 * the OS assigned an ephemeral port). `models` are the router's own `profiles`,
 * mapped into omp's provider-model shape (cost is USD per million tokens, same
 * unit `renderProviderBlock` uses for `config --write`). A wildcard listen
 * address maps to loopback, since a wildcard is not a connectable target.
 */
export function buildProviderConfig(
	port: number,
	cfg: {
		server: { host: string; harnessId?: string };
		profiles: Array<{ id: string; name: string; contextWindow: number; maxTokens: number }>;
		ledger: { fallbackBlend: { inputPerMtok: number; outputPerMtok: number } };
	},
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
	return out;
}
