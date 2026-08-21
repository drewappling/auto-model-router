import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readOmpCredential, resolveOpenRouterKey } from "../src/config/omp-credentials.ts";

/**
 * omp's real `auth_credentials` DDL, copied verbatim from a live
 * `~/.omp/agent/agent.db`. Tests must fail if we drift from the actual schema,
 * so this is not a simplified stand-in.
 */
const SCHEMA = `
CREATE TABLE auth_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  credential_type TEXT NOT NULL,
  data TEXT NOT NULL,
  disabled_cause TEXT DEFAULT NULL,
  identity_key TEXT DEFAULT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
)`;

const dirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
	if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

interface Row {
	provider: string;
	type: string;
	data: unknown;
	disabled?: string;
	updatedAt?: number;
}

function storeWith(rows: Row[]): string {
	const dir = mkdtempSync(join(tmpdir(), "ompr-cred-"));
	dirs.push(dir);
	const path = join(dir, "agent.db");
	const db = new Database(path);
	db.exec(SCHEMA);
	const insert = db.query(
		"INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, updated_at) VALUES (?, ?, ?, ?, ?)",
	);
	for (const r of rows) {
		insert.run(r.provider, r.type, JSON.stringify(r.data), r.disabled ?? null, r.updatedAt ?? Math.floor(Date.now() / 1000));
	}
	db.close();
	return path;
}

afterEach(() => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("readOmpCredential", () => {
	test("reads an api_key credential in omp's stored shape", () => {
		// Matches the real `ollama-cloud` row: {"key": "...", "source": "..."}
		const path = storeWith([{ provider: "openrouter", type: "api_key", data: { key: "sk-or-real", source: "login" } }]);
		expect(readOmpCredential("openrouter", path)).toBe("sk-or-real");
	});

	test("returns null for a provider that is not logged in", () => {
		const path = storeWith([{ provider: "anthropic", type: "oauth", data: { access: "x", expires: Date.now() + 1e6 } }]);
		expect(readOmpCredential("openrouter", path)).toBeNull();
	});

	test("accepts an unexpired oauth access token", () => {
		const path = storeWith([
			{ provider: "openrouter", type: "oauth", data: { access: "tok-live", refresh: "r", expires: Date.now() + 600_000 } },
		]);
		expect(readOmpCredential("openrouter", path)).toBe("tok-live");
	});

	test("rejects an expired oauth token rather than burning a turn on a 401", () => {
		// Refreshing is omp's job; we hold the store read-only.
		const path = storeWith([
			{ provider: "openrouter", type: "oauth", data: { access: "tok-stale", refresh: "r", expires: Date.now() - 1000 } },
		]);
		expect(readOmpCredential("openrouter", path)).toBeNull();
	});

	test("skips a disabled credential", () => {
		const path = storeWith([
			{ provider: "openrouter", type: "api_key", data: { key: "sk-or-dead" }, disabled: "revoked" },
		]);
		expect(readOmpCredential("openrouter", path)).toBeNull();
	});

	test("prefers the most recently updated credential", () => {
		const path = storeWith([
			{ provider: "openrouter", type: "api_key", data: { key: "sk-or-old" }, updatedAt: 1000 },
			{ provider: "openrouter", type: "api_key", data: { key: "sk-or-new" }, updatedAt: 2000 },
		]);
		expect(readOmpCredential("openrouter", path)).toBe("sk-or-new");
	});

	test("survives a missing, unreadable, or unexpected store", () => {
		expect(readOmpCredential("openrouter", join(tmpdir(), "definitely-absent-agent.db"))).toBeNull();
		const dir = mkdtempSync(join(tmpdir(), "ompr-cred-"));
		dirs.push(dir);
		const garbage = join(dir, "agent.db");
		writeFileSync(garbage, "this is definitely not a sqlite database");
		// A corrupt or foreign file must degrade to "no key", never throw.
		expect(() => readOmpCredential("openrouter", garbage)).not.toThrow();
		expect(readOmpCredential("openrouter", garbage)).toBeNull();
	});

	test("skips a row whose data is not valid JSON", () => {
		const dir = mkdtempSync(join(tmpdir(), "ompr-cred-"));
		dirs.push(dir);
		const path = join(dir, "agent.db");
		const db = new Database(path);
		db.exec(SCHEMA);
		db.query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)").run(
			"openrouter",
			"api_key",
			"{not json",
		);
		db.close();
		expect(readOmpCredential("openrouter", path)).toBeNull();
	});

	test("declines to read a local store when a remote auth broker is configured", () => {
		const path = storeWith([{ provider: "openrouter", type: "api_key", data: { key: "sk-or-local" } }]);
		setEnv("OMP_AUTH_BROKER_URL", "https://broker.example");
		// Broker mode replaces the local store; reading it would be a stale lie.
		expect(readOmpCredential("openrouter", path)).toBeNull();
	});
});

describe("resolveOpenRouterKey", () => {
	test("explicit configuration wins over the borrowed credential", () => {
		setEnv("OPENROUTER_API_KEY", undefined);
		const resolved = resolveOpenRouterKey("sk-or-explicit");
		expect(resolved.apiKey).toBe("sk-or-explicit");
		expect(resolved.source).toBe("config");
	});

	test("attributes a key that came from the environment", () => {
		setEnv("OPENROUTER_API_KEY", "sk-or-from-env");
		const resolved = resolveOpenRouterKey("sk-or-from-env");
		expect(resolved.source).toBe("env");
	});

	test("reports an actionable message when nothing is configured", () => {
		setEnv("OPENROUTER_API_KEY", undefined);
		setEnv("PI_CODING_AGENT_DIR", mkdtempSync(join(tmpdir(), "ompr-empty-agent-")));
		dirs.push(process.env.PI_CODING_AGENT_DIR ?? "");
		const resolved = resolveOpenRouterKey("");
		expect(resolved.apiKey).toBe("");
		expect(resolved.source).toBe("none");
		expect(resolved.detail).toContain("/login openrouter");
	});

	test("borrows omp's credential when nothing else is configured", () => {
		setEnv("OPENROUTER_API_KEY", undefined);
		const dir = mkdtempSync(join(tmpdir(), "ompr-agentdir-"));
		dirs.push(dir);
		const db = new Database(join(dir, "agent.db"));
		db.exec(SCHEMA);
		db.query("INSERT INTO auth_credentials (provider, credential_type, data) VALUES (?, ?, ?)").run(
			"openrouter",
			"api_key",
			JSON.stringify({ key: "sk-or-borrowed", source: "login" }),
		);
		db.close();
		setEnv("PI_CODING_AGENT_DIR", dir);
		const resolved = resolveOpenRouterKey("");
		expect(resolved.apiKey).toBe("sk-or-borrowed");
		expect(resolved.source).toBe("omp-auth-store");
	});
});
