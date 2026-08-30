import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildProviderConfig,
	deriveAgentdoxScope,
	EMBED_PORT_FILE,
	EMBED_PROVIDER_ID,
	embedPortPath,
	modelsYmlPort,
	readEmbedPort,
	resolveEmbedPort,
	writeEmbedPort,
	type EmbedConfig,
} from "../omp-extension/embed-logic.ts";

describe("resolveEmbedPort", () => {
	test("returns 0 (let the OS assign a free port) when nothing is configured", () => {
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

	// A stable port is what keeps omp's PRE-extension model resolution correct:
	// it reads models.yml before this extension can bind and rewrite it, so an
	// ephemeral port leaves that block naming the previous session's dead port.
	test("uses the configured server.port when no env override is set", () => {
		expect(resolveEmbedPort(undefined, 8788)).toBe(8788);
		expect(resolveEmbedPort("", 8788)).toBe(8788);
	});

	test("the env var wins over the configured port", () => {
		expect(resolveEmbedPort("8812", 8788)).toBe(8812);
	});

	test("an explicit env 0 wins, so an ephemeral port stays requestable", () => {
		expect(resolveEmbedPort("0", 8788)).toBe(0);
	});

	test("ignores a nonsense configured port rather than binding it", () => {
		expect(resolveEmbedPort(undefined, 0)).toBe(0);
		expect(resolveEmbedPort(undefined, -5)).toBe(0);
		expect(resolveEmbedPort(undefined, 70_000)).toBe(0);
	});
});

describe("modelsYmlPort", () => {
	// This is the port omp resolves modelRoles.default against at STARTUP,
	// before the extension loads. A disagreement with the served port means
	// every main-agent turn in that session fails with "Unable to connect"
	// while utility calls still work, so the extension has to detect it.
	const REAL = `providers:
    # BEGIN auto-model-router
    auto-model-router:
      baseUrl: http://127.0.0.1:58724/v1
      api: openai-completions
      auth: none
      models:
        - id: auto
          name: Auto (auto-model-router)
`;

	test("reads the advertised port out of a real block", () => {
		expect(modelsYmlPort(REAL)).toBe(58724);
	});

	test("returns null when our provider block is absent", () => {
		expect(modelsYmlPort("providers:\n    openrouter:\n      baseUrl: https://openrouter.ai/api/v1\n")).toBeNull();
		expect(modelsYmlPort("")).toBeNull();
	});

	test("is not fooled by another provider's baseUrl appearing first", () => {
		const mixed = `providers:
    llama.cpp:
      baseUrl: http://127.0.0.1:8080/v1
    auto-model-router:
      baseUrl: http://127.0.0.1:8788/v1
`;
		expect(modelsYmlPort(mixed)).toBe(8788);
	});

	test("returns null when the block carries no parseable url", () => {
		expect(modelsYmlPort("providers:\n    auto-model-router:\n      api: openai-completions\n")).toBeNull();
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

describe("agentdox scope", () => {
	test("derives a slug from the workspace basename", () => {
		expect(deriveAgentdoxScope("E:/projects/Ashlands/Ashlands")).toBe("ashlands");
		expect(deriveAgentdoxScope("/home/drew/omp-router")).toBe("omp-router");
		expect(deriveAgentdoxScope("E:\\projects\\My Game\\")).toBe("my-game");
		expect(deriveAgentdoxScope("")).toBe("");
	});

	test("the workspace derivation wins over the scope-agnostic defaultScope", () => {
		// Regression: one router install serves every project on the machine, so a
		// global `defaultScope` overriding the derivation made an ashlands session
		// ship `X-Agentdox-Scope: omp-router` — wrong context injected, turns
		// filed under the wrong project.
		const base = {
			server: { host: "127.0.0.1" },
			profiles: [],
			ledger: { fallbackBlend: { inputPerMtok: 1, outputPerMtok: 1 } },
		};
		const derived = buildProviderConfig(1234, { ...base, context: { enabled: true, defaultScope: "" } }, "/x/ashlands");
		expect(derived.agentdoxScope).toBe("ashlands");
		const both = buildProviderConfig(1234, { ...base, context: { enabled: true, defaultScope: "omp-router" } }, "/x/ashlands");
		expect(both.agentdoxScope).toBe("ashlands");
		// The default only applies when the workspace yields nothing.
		const fallback = buildProviderConfig(1234, { ...base, context: { enabled: true, defaultScope: "pinned" } }, "");
		expect(fallback.agentdoxScope).toBe("pinned");
	});

	test("no scope header when the bridge is off", () => {
		const cfg = {
			server: { host: "127.0.0.1" },
			profiles: [],
			ledger: { fallbackBlend: { inputPerMtok: 1, outputPerMtok: 1 } },
			context: { enabled: false, defaultScope: "ashlands" },
		};
		expect(buildProviderConfig(1234, cfg, "/x/ashlands").agentdoxScope).toBeUndefined();
	});
});
