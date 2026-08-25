/**
 * Borrows a provider credential from omp's own auth store.
 *
 * The point is that there is exactly ONE OpenRouter key on the machine, owned
 * by omp. Once `/login openrouter` has been run there, auto-model-router picks the key
 * up with no config and no second copy to rotate or leak.
 *
 * The store is opened READ-ONLY and never written: omp owns that file, including
 * OAuth refresh. Every failure path returns null rather than throwing, because a
 * missing or evolving credential store must degrade to "no key" and let the
 * caller report it, not crash the router at startup.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CredentialSource = "config" | "env" | "omp-auth-store" | "none";

export interface ResolvedCredential {
	apiKey: string;
	source: CredentialSource;
	/** Human-readable provenance for logs and `/health`. Never contains the secret. */
	detail: string;
}

/** omp's agent directory. `PI_CODING_AGENT_DIR` relocates it wholesale. */
export function ompAgentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (override !== undefined && override !== "") return override;
	return join(homedir(), ".omp", "agent");
}

export function ompAuthStorePath(): string {
	return join(ompAgentDir(), "agent.db");
}

interface CredentialRow {
	credential_type: string;
	data: string;
	updated_at: number;
}

/**
 * Reads a usable API key for `provider` out of omp's auth store.
 *
 * Handles both credential shapes omp persists: `api_key` rows carry
 * `{ key, source }`, OAuth rows carry `{ access, refresh, expires }`. An
 * expired OAuth access token is deliberately rejected — refreshing it is omp's
 * job, and sending a stale bearer upstream would just burn a turn on a 401.
 */
export function readOmpCredential(provider: string, storePath = ompAuthStorePath()): string | null {
	// A remote broker replaces the local SQLite store entirely, so there is
	// nothing to read here and pretending otherwise would be misleading.
	const broker = process.env.OMP_AUTH_BROKER_URL;
	if (broker !== undefined && broker !== "") return null;
	if (!existsSync(storePath)) return null;

	let db: Database | null = null;
	try {
		db = new Database(storePath, { readonly: true });
		const rows = db
			.query(
				`SELECT credential_type, data, updated_at
				 FROM auth_credentials
				 WHERE provider = ? AND disabled_cause IS NULL
				 ORDER BY updated_at DESC`,
			)
			.all(provider) as CredentialRow[];

		for (const row of rows) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.data);
			} catch {
				continue;
			}
			if (typeof parsed !== "object" || parsed === null) continue;

			if (row.credential_type === "api_key" && "key" in parsed && typeof parsed.key === "string" && parsed.key !== "") {
				return parsed.key;
			}
			if (row.credential_type === "oauth" && "access" in parsed && typeof parsed.access === "string" && parsed.access !== "") {
				const expires = "expires" in parsed && typeof parsed.expires === "number" ? parsed.expires : 0;
				if (expires === 0 || expires > Date.now()) return parsed.access;
			}
		}
		return null;
	} catch {
		// Locked, corrupt, or a schema this version does not understand.
		return null;
	} finally {
		db?.close();
	}
}

/**
 * Full precedence chain for the OpenRouter key. Explicit configuration always
 * beats the borrowed credential, so a project can point at a different account
 * without touching omp.
 */
export function resolveOpenRouterKey(configured: string): ResolvedCredential {
	if (configured !== "") {
		const fromEnv = process.env.OPENROUTER_API_KEY;
		const source: CredentialSource = fromEnv !== undefined && fromEnv === configured ? "env" : "config";
		return {
			apiKey: configured,
			source,
			detail: source === "env" ? "OPENROUTER_API_KEY" : "config file",
		};
	}

	const borrowed = readOmpCredential("openrouter");
	if (borrowed !== null) {
		return { apiKey: borrowed, source: "omp-auth-store", detail: `omp auth store (${ompAuthStorePath()})` };
	}

	return {
		apiKey: "",
		source: "none",
		detail: "no key: set OPENROUTER_API_KEY, or run `/login openrouter` inside omp",
	};
}
