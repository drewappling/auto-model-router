import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { loadConfig } from "../src/config/load.ts";

const dirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ompr-config-"));
	dirs.push(dir);
	return dir;
}

function setEnv(key: string, value: string | undefined): void {
	if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}

/** Writes a config file and returns its path. */
function writeConfig(body: string): string {
	const dir = tempDir();
	const path = join(dir, "config.yml");
	writeFileSync(path, body, "utf8");
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

describe("loadConfig", () => {
	test("loads defaults with no config file and no API key", () => {
		setEnv("OPENROUTER_API_KEY", undefined);
		setEnv("OMP_ROUTER_HOME", tempDir());
		const cfg = loadConfig({});
		expect(cfg.server.port).toBe(DEFAULT_CONFIG.server.port);
		expect(cfg.openrouter.apiKey).toBe("");
		expect(cfg.profiles.length).toBeGreaterThan(0);
		// A missing key must not be fatal: the catalog and `config` work keyless.
		expect(cfg.tiers.hard.minQuality).toBe(DEFAULT_CONFIG.tiers.hard.minQuality);
	});

	test("resolves the ledger path under the router home", () => {
		const home = tempDir();
		setEnv("OMP_ROUTER_HOME", home);
		const cfg = loadConfig({});
		expect(cfg.ledger.path).toContain(home);
	});

	test("deep-merges nested objects from the config file", () => {
		const path = writeConfig("tiers:\n  hard:\n    minQuality: 88\n");
		const cfg = loadConfig({ path });
		expect(cfg.tiers.hard.minQuality).toBe(88);
		// Sibling keys inside the same nested object survive the merge.
		expect(cfg.tiers.hard.qualityExponent).toBe(DEFAULT_CONFIG.tiers.hard.qualityExponent);
		expect(cfg.tiers.trivial.minQuality).toBe(DEFAULT_CONFIG.tiers.trivial.minQuality);
	});

	test("replaces arrays wholesale rather than merging them", () => {
		// Matches omp's own settings semantics: arrays never union or append.
		expect(DEFAULT_CONFIG.escalation.probeTiers.length).toBeGreaterThan(1);
		const path = writeConfig("escalation:\n  probeTiers:\n    - trivial\n");
		const cfg = loadConfig({ path });
		expect(cfg.escalation.probeTiers).toEqual(["trivial"]);
	});

	test("names the offending path when a value is invalid", () => {
		const path = writeConfig("server:\n  port: not-a-number\n");
		let message = "";
		try {
			loadConfig({ path });
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).not.toBe("");
		expect(message).toContain("port");
	});

	test("environment variables override file values", () => {
		const path = writeConfig("server:\n  port: 9001\n");
		setEnv("OMP_ROUTER_PORT", "9999");
		const cfg = loadConfig({ path });
		expect(cfg.server.port).toBe(9999);
	});

	test("explicit overrides beat the environment", () => {
		setEnv("OMP_ROUTER_PORT", "9999");
		const cfg = loadConfig({ overrides: { server: { host: "127.0.0.1", port: 7777 } } });
		expect(cfg.server.port).toBe(7777);
	});

	test("reads the OpenRouter key from the environment", () => {
		setEnv("OPENROUTER_API_KEY", "sk-or-test-value");
		const cfg = loadConfig({});
		expect(cfg.openrouter.apiKey).toBe("sk-or-test-value");
	});

	test("accepts a config that only overrides one scalar", () => {
		const path = writeConfig("logLevel: debug\n");
		const cfg = loadConfig({ path });
		expect(cfg.logLevel).toBe("debug");
		expect(cfg.escalation.enabled).toBe(DEFAULT_CONFIG.escalation.enabled);
	});

	test("an empty config file is valid and changes nothing", () => {
		const path = writeConfig("");
		const cfg = loadConfig({ path });
		expect(cfg.server.port).toBe(DEFAULT_CONFIG.server.port);
	});
});
