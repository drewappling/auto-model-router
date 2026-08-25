import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildProviderConfig,
	EMBED_PORT_FILE,
	EMBED_PROVIDER_ID,
	embedPortPath,
	readEmbedPort,
	resolveEmbedPort,
	writeEmbedPort,
	type EmbedConfig,
} from "../omp-extension/embed-logic.ts";

describe("resolveEmbedPort", () => {
	test("returns 0 (let the OS assign a free port) when AUTO_MODEL_ROUTER_PORT is absent", () => {
		expect(resolveEmbedPort(undefined)).toBe(0);
		expect(resolveEmbedPort("")).toBe(0);
	});

	test("uses an explicit valid env port verbatim", () => {
		expect(resolveEmbedPort("8812")).toBe(8812);
		expect(resolveEmbedPort("0")).toBe(0);
	});

	test("falls back to 0 on junk or out-of-range values", () => {
		expect(resolveEmbedPort("notaport")).toBe(0);
		expect(resolveEmbedPort("-1")).toBe(0);
		expect(resolveEmbedPort("70000")).toBe(0);
	});
});

describe("embed port file", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "omp-embed-"));
	});
	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	test("round-trips the bound port", () => {
		const p = embedPortPath(dir);
		expect(p).toBe(join(dir, EMBED_PORT_FILE));
		writeEmbedPort(p, 45678);
		expect(readEmbedPort(p)).toBe(45678);
	});

	test("returns null for a missing or malformed file", () => {
		expect(readEmbedPort(embedPortPath(join(dir, "absent")))).toBeNull();
		writeEmbedPort(embedPortPath(dir), -5);
		expect(readEmbedPort(embedPortPath(dir))).toBeNull();
		writeEmbedPort(embedPortPath(dir), 70000);
		expect(readEmbedPort(embedPortPath(dir))).toBeNull();
		writeEmbedPort(embedPortPath(dir), 0);
		expect(readEmbedPort(embedPortPath(dir))).toBeNull();
	});
});

describe("buildProviderConfig", () => {
	const base = {
		server: { host: "127.0.0.1" },
		profiles: [
			{ id: "auto", name: "Auto (auto-model-router)", contextWindow: 400_000, maxTokens: 32_000 },
			{ id: "auto-cheap", name: "Auto Cheap (auto-model-router)", contextWindow: 400_000, maxTokens: 32_000 },
		],
		ledger: { fallbackBlend: { inputPerMtok: 0.2, outputPerMtok: 0.8 } },
	};

	test("builds a provider config against the actual bound port", () => {
		const c: EmbedConfig = buildProviderConfig(45678, base);
		expect(c.baseUrl).toBe("http://127.0.0.1:45678/v1");
		expect(c.port).toBe(45678);
		expect(c.host).toBe("127.0.0.1");
		expect(c.harnessId).toBeUndefined();
		expect(c.models).toHaveLength(2);
		expect(c.models[0]).toMatchObject({ id: "auto", contextWindow: 400_000, maxTokens: 32_000 });
	});

	test("converts cost to USD-per-million-token and applies cache multipliers", () => {
		const c: EmbedConfig = buildProviderConfig(45678, base);
		// input 0.2, output 0.8, cacheRead = 0.2*0.1 = 0.02, cacheWrite = 0.2*1.25 = 0.25
		expect(c.models[0]!.cost).toEqual({ input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.25 });
	});

	test("normalizes a wildcard listen host to loopback", () => {
		const c: EmbedConfig = buildProviderConfig(45678, { ...base, server: { host: "0.0.0.0" } });
		expect(c.baseUrl).toBe("http://127.0.0.1:45678/v1");
	});

	test("carries the harness id through when configured", () => {
		const c: EmbedConfig = buildProviderConfig(45678, { ...base, server: { host: "127.0.0.1", harnessId: "prod-a" } });
		expect(c.harnessId).toBe("prod-a");
	});
});

describe("embed constants", () => {
	test("provider id and dummy key stay stable", () => {
		expect(EMBED_PROVIDER_ID).toBe("auto-model-router");
	});
	test("port file name is stable", () => {
		expect(EMBED_PORT_FILE).toBe("embed.port");
	});
});
