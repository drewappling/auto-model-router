import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	buildProviderConfig,
	deriveAgentdoxScope,
	deriveWorkspaceOrigin,
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
	test("returns 0 (let the OS assign a free port) when nothing is configured", async () => {
		expect(resolveEmbedPort(undefined)).toBe(0);
		expect(resolveEmbedPort("")).toBe(0);
	});

	test("uses an explicit valid env port verbatim", async () => {
		expect(resolveEmbedPort("8812")).toBe(8812);
		expect(resolveEmbedPort("0")).toBe(0);
	});

	test("falls back to 0 on junk or out-of-range values", async () => {
		expect(resolveEmbedPort("notaport")).toBe(0);
		expect(resolveEmbedPort("-1")).toBe(0);
		expect(resolveEmbedPort("70000")).toBe(0);
	});

	// A stable port is what keeps omp's PRE-extension model resolution correct:
	// it reads models.yml before this extension can bind and rewrite it, so an
	// ephemeral port leaves that block naming the previous session's dead port.
	test("uses the configured server.port when no env override is set", async () => {
		expect(resolveEmbedPort(undefined, 8788)).toBe(8788);
		expect(resolveEmbedPort("", 8788)).toBe(8788);
	});

	test("the env var wins over the configured port", async () => {
		expect(resolveEmbedPort("8812", 8788)).toBe(8812);
	});

	test("an explicit env 0 wins, so an ephemeral port stays requestable", async () => {
		expect(resolveEmbedPort("0", 8788)).toBe(0);
	});

	test("ignores a nonsense configured port rather than binding it", async () => {
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

	test("reads the advertised port out of a real block", async () => {
		expect(modelsYmlPort(REAL)).toBe(58724);
	});

	test("returns null when our provider block is absent", async () => {
		expect(modelsYmlPort("providers:\n    openrouter:\n      baseUrl: https://openrouter.ai/api/v1\n")).toBeNull();
		expect(modelsYmlPort("")).toBeNull();
	});

	test("is not fooled by another provider's baseUrl appearing first", async () => {
		const mixed = `providers:
    llama.cpp:
      baseUrl: http://127.0.0.1:8080/v1
    auto-model-router:
      baseUrl: http://127.0.0.1:8788/v1
`;
		expect(modelsYmlPort(mixed)).toBe(8788);
	});

	test("returns null when the block carries no parseable url", async () => {
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

	test("round-trips the bound port", async () => {
		const p = embedPortPath(dir);
		expect(p).toBe(join(dir, EMBED_PORT_FILE));
		writeEmbedPort(p, 45678);
		expect(readEmbedPort(p)).toBe(45678);
	});

	test("returns null for a missing or malformed file", async () => {
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

	test("builds a provider config against the actual bound port", async () => {
		const c: EmbedConfig = buildProviderConfig(45678, base);
		expect(c.baseUrl).toBe("http://127.0.0.1:45678/v1");
		expect(c.port).toBe(45678);
		expect(c.host).toBe("127.0.0.1");
		expect(c.harnessId).toBeUndefined();
		expect(c.models).toHaveLength(2);
		expect(c.models[0]).toMatchObject({ id: "auto", contextWindow: 400_000, maxTokens: 32_000 });
	});

	test("converts cost to USD-per-million-token and applies cache multipliers", async () => {
		const c: EmbedConfig = buildProviderConfig(45678, base);
		// input 0.2, output 0.8, cacheRead = 0.2*0.1 = 0.02, cacheWrite = 0.2*1.25 = 0.25
		expect(c.models[0]!.cost).toEqual({ input: 0.2, output: 0.8, cacheRead: 0.02, cacheWrite: 0.25 });
	});

	test("normalizes a wildcard listen host to loopback", async () => {
		const c: EmbedConfig = buildProviderConfig(45678, { ...base, server: { host: "0.0.0.0" } });
		expect(c.baseUrl).toBe("http://127.0.0.1:45678/v1");
	});

	test("carries the harness id through when configured", async () => {
		const c: EmbedConfig = buildProviderConfig(45678, { ...base, server: { host: "127.0.0.1", harnessId: "prod-a" } });
		expect(c.harnessId).toBe("prod-a");
	});
});

describe("embed constants", () => {
	test("provider id and dummy key stay stable", async () => {
		expect(EMBED_PROVIDER_ID).toBe("auto-model-router");
	});
	test("port file name is stable", async () => {
		expect(EMBED_PORT_FILE).toBe("embed.port");
	});
});

describe("agentdox scope", () => {
	test("derives a slug from the workspace basename", async () => {
		expect(deriveAgentdoxScope("E:/projects/Ashlands/Ashlands")).toBe("ashlands");
		expect(deriveAgentdoxScope("/home/drew/omp-router")).toBe("omp-router");
		expect(deriveAgentdoxScope("E:\\projects\\My Game\\")).toBe("my-game");
		expect(deriveAgentdoxScope("")).toBe("");
	});

	test("the workspace derivation wins over the scope-agnostic defaultScope", async () => {
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

	test("no scope header when the bridge is off", async () => {
		const cfg = {
			server: { host: "127.0.0.1" },
			profiles: [],
			ledger: { fallbackBlend: { inputPerMtok: 1, outputPerMtok: 1 } },
			context: { enabled: false, defaultScope: "ashlands" },
		};
		expect(buildProviderConfig(1234, cfg, "/x/ashlands").agentdoxScope).toBeUndefined();
	});
});

describe("workspace origin", () => {
	const CONFIG = ['[core]', '\trepositoryformatversion = 0', '[remote "origin"]', '\turl = https://github.com/DrewAppling/omp-router.git', '\tfetch = +refs/heads/*:refs/remotes/origin/*', '[branch "main"]', '\tremote = origin', ''].join("\n");
	let root: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "amr-origin-"));
	});
	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test("a plain repository: the remote from .git/config, also from a subdirectory", async () => {
		const repo = join(root, "repo");
		mkdirSync(join(repo, ".git"), { recursive: true });
		writeFileSync(join(repo, ".git", "config"), CONFIG);
		mkdirSync(join(repo, "src", "deep"), { recursive: true });
		expect(deriveWorkspaceOrigin(repo)).toBe("github.com/drewappling/omp-router");
		expect(deriveWorkspaceOrigin(join(repo, "src", "deep"))).toBe("github.com/drewappling/omp-router");
		// The scope is still the folder, untouched by any of this.
		expect(deriveAgentdoxScope(repo)).toBe("repo");
	});

	test("a worktree: .git is a file naming the git dir, whose shared config is one hop further", async () => {
		// The main checkout holds the config; the worktree's own dir only points at it.
		const main = join(root, "main");
		mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
		writeFileSync(join(main, ".git", "config"), CONFIG.replace("github.com/DrewAppling/omp-router.git", "gitlab.example.com:2222/team/api/").replace("https://", "ssh://git@"));
		writeFileSync(join(main, ".git", "worktrees", "wt", "commondir"), "../..\n");
		const wt = join(root, "wt");
		mkdirSync(wt, { recursive: true });
		writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
		expect(deriveWorkspaceOrigin(wt)).toBe("gitlab.example.com/team/api");
		// A submodule-style pointer: the named dir has its own config, relative to the .git file.
		const sub = join(root, "sub");
		mkdirSync(join(sub, "modules", "lib"), { recursive: true });
		mkdirSync(join(sub, "lib"), { recursive: true });
		writeFileSync(join(sub, "modules", "lib", "config"), CONFIG.replace("DrewAppling/omp-router", "org/lib"));
		writeFileSync(join(sub, "lib", ".git"), "gitdir: ../modules/lib\n");
		expect(deriveWorkspaceOrigin(join(sub, "lib"))).toBe("github.com/org/lib");
	});

	test("no remote, a local remote, no repository, or nothing at all: no fingerprint, never a throw", async () => {
		const bare = join(root, "bare");
		mkdirSync(join(bare, ".git"), { recursive: true });
		writeFileSync(join(bare, ".git", "config"), "[core]\n\tbare = false\n");
		expect(deriveWorkspaceOrigin(bare)).toBe("");
		const local = join(root, "local");
		mkdirSync(join(local, ".git"), { recursive: true });
		writeFileSync(join(local, ".git", "config"), '[remote "origin"]\n\turl = /srv/git/local.git\n');
		expect(deriveWorkspaceOrigin(local)).toBe("");
		// A `.git` file that leads nowhere is the boundary: the walk stops there.
		const dangling = join(root, "repo", "dangling");
		mkdirSync(dangling, { recursive: true });
		writeFileSync(join(dangling, ".git"), "gitdir: /nowhere/at/all\n");
		expect(deriveWorkspaceOrigin(dangling)).toBe("");
		expect(deriveWorkspaceOrigin(join(root, "not-a-repo", "missing"))).toBe("");
		expect(deriveWorkspaceOrigin("")).toBe("");
		expect(
			deriveWorkspaceOrigin("/anywhere", () => {
				throw new Error("disk on fire");
			}),
		).toBe("");
	});

	test("the first url under [remote \"origin\"] wins; other remotes do not count", () => {
		const read = () => '[remote "upstream"]\n\turl = https://github.com/other/thing.git\n[remote "origin"]\n\turl = git@github.com:me/thing.git\n\turl = https://github.com/me/second.git\n';
		expect(deriveWorkspaceOrigin("/x/repo", read)).toBe("github.com/me/thing");
		expect(deriveWorkspaceOrigin("/x/repo", () => '[remote "upstream"]\n\turl = https://github.com/other/thing.git\n')).toBe("");
	});

	test("buildProviderConfig carries the origin beside the scope, only where the scope goes", async () => {
		const base = {
			server: { host: "127.0.0.1" },
			profiles: [],
			ledger: { fallbackBlend: { inputPerMtok: 1, outputPerMtok: 1 } },
		};
		const on = buildProviderConfig(1234, { ...base, context: { enabled: true, defaultScope: "" } }, "/x/ashlands", "github.com/me/ashlands");
		expect(on.agentdoxScope).toBe("ashlands");
		expect(on.agentdoxOrigin).toBe("github.com/me/ashlands");
		expect(buildProviderConfig(1234, { ...base, context: { enabled: true, defaultScope: "" } }, "/x/ashlands", "").agentdoxOrigin).toBeUndefined();
		expect(buildProviderConfig(1234, { ...base, context: { enabled: true, defaultScope: "" } }, "/x/ashlands").agentdoxOrigin).toBeUndefined();
		expect(buildProviderConfig(1234, { ...base, context: { enabled: false, defaultScope: "" } }, "/x/ashlands", "github.com/me/ashlands").agentdoxOrigin).toBeUndefined();
	});
});
