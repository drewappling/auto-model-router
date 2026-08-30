import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_CONFIG } from "./defaults.ts";
import { configInputSchema } from "./schema.ts";
import { resolveOpenRouterKey, type ResolvedCredential } from "./omp-credentials.ts";
import type { RouterConfig } from "./types.ts";

const LOG_LEVELS: readonly RouterConfig["logLevel"][] = ["silent", "error", "warn", "info", "debug"];

/** Expands a leading `~` (or `~/`) to the user's home directory. */
export function resolveTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
	return p;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Recursive merge with omp's settings semantics: plain objects merge key by
 * key, arrays REPLACE wholesale (they never union or concatenate), and
 * scalars overwrite. `undefined` override values leave the base untouched.
 */
function mergeValue(base: unknown, override: unknown): unknown {
	if (override === undefined) return base;
	if (Array.isArray(override)) return override.slice();
	if (isPlainObject(override) && isPlainObject(base)) {
		const out: Record<string, unknown> = { ...base };
		for (const [k, v] of Object.entries(override)) out[k] = mergeValue(out[k], v);
		return out;
	}
	return override;
}

export function deepMerge(base: RouterConfig, override: unknown): RouterConfig {
	return mergeValue(base, override) as RouterConfig;
}

/**
 * Recursive partial: `loadConfig` merges overrides key by key, so a caller may
 * legitimately supply just `{ server: { host } }`. Typing the parameter as a
 * flat `Partial<RouterConfig>` demanded a COMPLETE `ServerConfig` for that,
 * which made honest call sites (the omp extension, the smoke tools) type
 * errors — invisible ones, since those directories were outside the
 * typechecked project until `tsconfig.all.json`.
 */
export type DeepPartial<T> = T extends readonly unknown[] | Date | RegExp
	? T
	: T extends object
		? { [K in keyof T]?: DeepPartial<T[K]> }
		: T;

/**
 * Resolves the effective configuration:
 *   DEFAULT_CONFIG
 *   <- `$AUTO_MODEL_ROUTER_HOME/config.yml|config.yaml` (or `opts.path`)
 *   <- environment (`OPENROUTER_API_KEY`, `AUTO_MODEL_ROUTER_PORT`,
 *      `AUTO_MODEL_ROUTER_HOST`, `AUTO_MODEL_ROUTER_LOG`, `AUTO_MODEL_ROUTER_DB`)
 *   <- `opts.overrides`
 *
 * A missing OpenRouter API key is NOT an error here: catalog refresh and
 * config work keyless; an embedded router warns at startup and completions
 * fail at dispatch time.
 */
export function loadConfig(opts?: { path?: string; overrides?: DeepPartial<RouterConfig> }): RouterConfig {
	const home = resolveTilde(process.env.AUTO_MODEL_ROUTER_HOME ?? "~/.auto-model-router");

	// Config file, when present.
	const filePath = opts?.path !== undefined
		? resolveTilde(opts.path)
		: [join(home, "config.yml"), join(home, "config.yaml")].find((p) => existsSync(p));

	let fileInput: unknown = {};
	if (filePath !== undefined) {
		const raw: unknown = parseYaml(readFileSync(filePath, "utf8"));
		if (raw !== null && raw !== undefined) {
			const parsed = configInputSchema.safeParse(raw);
			if (!parsed.success) {
				const lines = parsed.error.issues.map(
					(issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
				);
				throw new Error(`Invalid configuration in ${filePath}:\n${lines.join("\n")}`);
			}
			fileInput = parsed.data;
		}
	}

	// structuredClone: merge copies only along override paths, so untouched
	// default branches would otherwise be shared (and mutable) by reference.
	let cfg = deepMerge(structuredClone(DEFAULT_CONFIG), fileInput);

	// Environment overrides.
	const envInput: Record<string, unknown> = {};
	const putSection = (section: string, key: string, value: unknown): void => {
		const s = (envInput[section] ??= {}) as Record<string, unknown>;
		s[key] = value;
	};
	const envApiKey = process.env.OPENROUTER_API_KEY;
	if (envApiKey !== undefined && envApiKey !== "") putSection("openrouter", "apiKey", envApiKey);
	const envAaKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY;
	if (envAaKey !== undefined && envAaKey !== "") putSection("benchmarks", "artificialAnalysisApiKey", envAaKey);
	const envPort = process.env.AUTO_MODEL_ROUTER_PORT;
	if (envPort !== undefined && envPort !== "") {
		const port = Number.parseInt(envPort, 10);
		if (!Number.isInteger(port) || port < 0 || port > 65_535) {
			throw new Error(`AUTO_MODEL_ROUTER_PORT must be an integer between 0 and 65535, got "${envPort}"`);
		}
		putSection("server", "port", port);
	}
	const envHost = process.env.AUTO_MODEL_ROUTER_HOST;
	if (envHost !== undefined && envHost !== "") putSection("server", "host", envHost);
	const envLog = process.env.AUTO_MODEL_ROUTER_LOG;
	if (envLog !== undefined && envLog !== "") {
		if (!(LOG_LEVELS as readonly string[]).includes(envLog)) {
			throw new Error(`AUTO_MODEL_ROUTER_LOG must be one of ${LOG_LEVELS.join(", ")}, got "${envLog}"`);
		}
		envInput.logLevel = envLog;
	}
	const envDb = process.env.AUTO_MODEL_ROUTER_DB;
	if (envDb !== undefined && envDb !== "") putSection("ledger", "path", envDb);

	// agentdox bridge. A URL + token are enough to turn it on: requiring
	// `context.enabled` in a config file as well would make the common case
	// (export two vars, restart) silently do nothing.
	const envDoxUrl = process.env.AGENTDOX_URL;
	const envDoxToken = process.env.AGENTDOX_TOKEN;
	const envDoxScope = process.env.AGENTDOX_SCOPE;
	if (envDoxUrl !== undefined && envDoxUrl !== "") putSection("context", "baseUrl", envDoxUrl);
	if (envDoxToken !== undefined && envDoxToken !== "") putSection("context", "token", envDoxToken);
	if (envDoxScope !== undefined && envDoxScope !== "") putSection("context", "defaultScope", envDoxScope);
	if (envDoxUrl !== undefined && envDoxUrl !== "" && envDoxToken !== undefined && envDoxToken !== "") {
		putSection("context", "enabled", true);
	}
	cfg = deepMerge(cfg, envInput);

	// Explicit programmatic overrides win last.
	if (opts?.overrides !== undefined) cfg = deepMerge(cfg, opts.overrides);

	// The default ledger path is expressed relative to the resolved home.
	if (cfg.ledger.path === "") cfg.ledger.path = join(home, "router.db");
	cfg.ledger.path = resolveTilde(cfg.ledger.path);

	// Last resort for the OpenRouter key: borrow omp's own stored credential, so
	// `/login openrouter` in omp is all the setup this router needs. Explicit
	// config and environment already won above, so this only fills a blank.
	const credential = resolveOpenRouterKey(cfg.openrouter.apiKey);
	cfg.openrouter.apiKey = credential.apiKey;
	apiKeyProvenance.set(cfg, credential);

	return cfg;
}

/**
 * Where a config's OpenRouter key came from, for startup logs and `/health`.
 * Keyed weakly off the config object so the provenance never has to travel
 * through `RouterConfig` itself and risk being serialized next to the secret.
 */
const apiKeyProvenance = new WeakMap<RouterConfig, ResolvedCredential>();

export function apiKeySource(cfg: RouterConfig): ResolvedCredential {
	return (
		apiKeyProvenance.get(cfg) ?? {
			apiKey: cfg.openrouter.apiKey,
			source: cfg.openrouter.apiKey === "" ? "none" : "config",
			detail: cfg.openrouter.apiKey === "" ? "no key configured" : "config",
		}
	);
}
