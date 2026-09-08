import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addExtensions, codexBlock, connectRemote, setDotenv, type ConnectOptions } from "../src/cli/connect.ts";
import { parseRemoteRouter, readRemoteRouter, remoteProviderRegistration } from "../omp-extension/remote-logic.ts";
import { hasForeignRouterProvider, mergeModelsYml, renderRemoteModelsYml } from "../src/cli/connect.ts";

/**
 * Remote mode: remote.json puts the omp extensions on a router elsewhere,
 * and `connect` configures every harness it finds without touching anything
 * it does not recognise.
 */

describe("remote-logic", () => {
	test("remote.json is parsed defensively and turned into omp's provider registration", () => {
		expect(parseRemoteRouter("nope")).toBeNull();
		expect(parseRemoteRouter(JSON.stringify({ url: "https://t/", key: "" }))).toBeNull();
		const t = parseRemoteRouter(JSON.stringify({ url: "https://team.example/", key: "amrt_k", userId: "u_1", name: "Ada" }))!;
		expect(t.url).toBe("https://team.example");
		const reg = remoteProviderRegistration(t, "sess-1", true, { inputPerMtok: 1, outputPerMtok: 4 });
		expect(reg).toMatchObject({ baseUrl: "https://team.example/v1", api: "openai-completions", apiKey: "amrt_k", headers: { "X-Omp-Session": "sess-1", "X-Omp-Subagent": "1" } });
		expect(reg.models.map((m) => m.id)).toEqual(["auto", "auto-cheap", "auto-max"]);
		expect(reg.models[0]!.cost).toEqual({ input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1.25 });
		// The workspace's project travels with the turn, so one remote router serves every repo on
		// the machine with the right context; the remote may still override it.
		expect(reg.headers["X-Agentdox-Scope"]).toBeUndefined();
		expect(remoteProviderRegistration(t, "", false, { inputPerMtok: 1, outputPerMtok: 4 }, "omp-router").headers).toEqual({ "X-Agentdox-Scope": "omp-router" });
		const dir = mkdtempSync(join(tmpdir(), "amr-remote-"));
		expect(readRemoteRouter(dir)).toBeNull();
		writeFileSync(join(dir, "remote.json"), JSON.stringify({ url: "https://t", key: "k" }));
		expect(readRemoteRouter(dir)?.key).toBe("k");
		rmSync(join(dir, "remote.json"));
		writeFileSync(join(dir, "team.json"), JSON.stringify({ url: "https://legacy", key: "k2" })); // the first release's name still works
		expect(readRemoteRouter(dir)?.url).toBe("https://legacy");
		rmSync(dir, { recursive: true, force: true });
	});

	test("text edits keep files byte-identical apart from the lines they add", () => {
		expect(addExtensions("", ["/a.ts"])).toBe("extensions:\n  - /a.ts\n");
		expect(addExtensions("foo: 1\nextensions:\n  - /x.ts\nbar: 2\n", ["/x.ts", "/a.ts"])).toBe("foo: 1\nextensions:\n  - /a.ts\n  - /x.ts\nbar: 2\n");
		expect(addExtensions("foo: 1\r\n", ["/a.ts"])).toBe("foo: 1\r\nextensions:\r\n  - /a.ts\r\n");
		expect(setDotenv("A=1\nB=2\n", { B: "3", C: "4" })).toBe("A=1\nB=3\nC=4\n");
		expect(setDotenv("", { A: "1" })).toBe("A=1\n");
		expect(codexBlock("https://t")).toContain('base_url = "https://t/v1"');
	});
});

describe("connect", () => {
	function scenario(extra: Partial<ConnectOptions> = {}): { home: string; o: ConnectOptions } {
		const home = mkdtempSync(join(tmpdir(), "amr-connect-"));
		const agent = join(home, ".omp", "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "config.yml"), "extensions:\n  - E:/other/ext.ts\nsetupVersion: 2\n");
		mkdirSync(join(home, ".hermes"), { recursive: true });
		writeFileSync(join(home, ".hermes", ".env"), "OPENAI_API_KEY=x\n");
		mkdirSync(join(home, ".codex"), { recursive: true });
		writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-5"\n');
		const o: ConnectOptions = { url: "https://team.example", key: "amrt_key", userId: "u_ada", name: "Ada", profile: false, dryRun: false, only: [], env: { HOME: home, HERMES_HOME: join(home, ".hermes"), PI_CODING_AGENT_DIR: agent, AUTO_MODEL_ROUTER_HOME: join(home, ".auto-model-router") }, home, packageDir: process.cwd(), platform: "linux", pathHas: (b) => b === "claude" || b === "aider", ...extra };
		return { home, o };
	}

	test("writes remote.json and configures omp, Hermes, Codex, Aider and Claude Code idempotently", () => {
		const { home, o } = scenario();
		const r1 = connectRemote(o);
		expect(existsSync(r1.remoteFile)).toBe(true);
		expect(JSON.parse(readFileSync(r1.remoteFile, "utf8"))).toMatchObject({ url: "https://team.example", key: "amrt_key", userId: "u_ada", name: "Ada" });
		const ompCfg = readFileSync(join(home, ".omp", "agent", "config.yml"), "utf8");
		expect(ompCfg).toContain("extensions:\n  - ");
		expect(ompCfg).toContain("omp-extension/router-embed.ts");
		expect(ompCfg).toContain("E:/other/ext.ts");
		expect(ompCfg).toContain("setupVersion: 2");
		expect(existsSync(join(home, ".hermes", "plugins", "model-providers", "auto-model-router", "__init__.py"))).toBe(true);
		expect(existsSync(join(home, ".hermes", "plugins", "auto-model-router", "plugin.yaml"))).toBe(true);
		expect(readFileSync(join(home, ".hermes", ".env"), "utf8")).toBe("OPENAI_API_KEY=x\nAUTO_MODEL_ROUTER_URL=https://team.example\nAUTO_MODEL_ROUTER_API_KEY=amrt_key\n");
		expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[model_providers.auto-model-router]");
		expect(readFileSync(join(home, ".aider.conf.yml"), "utf8")).toContain("openai-api-base: https://team.example/v1");
		expect(r1.configured.join("\n")).toMatch(/omp[\s\S]*Hermes[\s\S]*Codex[\s\S]*Aider[\s\S]*Claude Code/);
		expect(r1.envLines).toEqual(["AUTO_MODEL_ROUTER_URL=https://team.example", "AUTO_MODEL_ROUTER_API_KEY=amrt_key", "ANTHROPIC_BASE_URL=https://team.example", "ANTHROPIC_API_KEY=amrt_key"]);
		// Running again changes nothing.
		const snapshot = [ompCfg, readFileSync(join(home, ".codex", "config.toml"), "utf8"), readFileSync(join(home, ".aider.conf.yml"), "utf8")];
		connectRemote(o);
		expect([readFileSync(join(home, ".omp", "agent", "config.yml"), "utf8"), readFileSync(join(home, ".codex", "config.toml"), "utf8"), readFileSync(join(home, ".aider.conf.yml"), "utf8")]).toEqual(snapshot);
		rmSync(home, { recursive: true, force: true });
	});

	test("--harness restricts, --dry-run writes nothing, --profile appends once to the shell rc", () => {
		const { home, o } = scenario({ only: ["omp"], dryRun: true });
		const r = connectRemote(o);
		expect(existsSync(r.remoteFile)).toBe(false);
		expect(r.configured.some((c) => c.startsWith("omp"))).toBe(true);
		expect(r.skipped.some((s) => s.startsWith("Hermes"))).toBe(true);
		expect(existsSync(join(home, ".hermes", "plugins"))).toBe(false);
		const { home: h2, o: o2 } = scenario({ profile: true, env: { SHELL: "/bin/zsh" } });
		o2.env = { ...o.env, HOME: h2, HERMES_HOME: join(h2, ".hermes"), PI_CODING_AGENT_DIR: join(h2, ".omp", "agent"), AUTO_MODEL_ROUTER_HOME: join(h2, ".auto-model-router"), SHELL: "/bin/zsh" };
		connectRemote(o2);
		connectRemote(o2);
		const rc = readFileSync(join(h2, ".zshrc"), "utf8");
		expect(rc.split("# auto-model-router remote").length).toBe(2);
		expect(rc).toContain("export ANTHROPIC_BASE_URL=https://team.example");
		rmSync(home, { recursive: true, force: true });
		rmSync(h2, { recursive: true, force: true });
	});
});

describe("omp models.yml for a remote router", () => {
	const BLEND = { inputPerMtok: 1.1, outputPerMtok: 4.4 };
	const NL = String.fromCharCode(10);
	const yaml = (...lines: string[]): string => lines.join(NL) + NL;

	test("the block names the remote, the key and the three virtual models; a scope is opt-in", () => {
		const block = renderRemoteModelsYml("https://team.example/", "amrt_k", BLEND);
		expect(block).toContain("baseUrl: https://team.example/v1");
		expect(block).toContain("apiKey: amrt_k");
		expect(block).toContain("- id: auto");
		expect(block).toContain("- id: auto-cheap");
		expect(block).toContain("- id: auto-max");
		expect(block).toContain("cost: { input: 1.1, output: 4.4, cacheRead: 0.11, cacheWrite: 1.375 }");
		// Machine-wide file: no scope unless the caller asks for one.
		expect(block).not.toContain("X-Agentdox-Scope");
		expect(renderRemoteModelsYml("https://team.example", "k", BLEND, "omp-router")).toContain("X-Agentdox-Scope: omp-router");
	});

	test("merging keeps other providers, replaces our own block, and is idempotent", () => {
		const block = renderRemoteModelsYml("https://team.example", "k1", BLEND);
		const empty = mergeModelsYml("", block);
		expect(empty.startsWith("providers:")).toBe(true);
		expect(mergeModelsYml(empty, block)).toBe(empty);

		const existing = yaml("providers:", "  openai:", "    apiKey: sk-x");
		const merged = mergeModelsYml(existing, block);
		expect(merged).toContain("openai:");
		expect(merged).toContain("baseUrl: https://team.example/v1");

		// A later connect with a new key replaces the block in place, not a second copy.
		const rekeyed = mergeModelsYml(merged, renderRemoteModelsYml("https://team.example", "k2", BLEND));
		expect(rekeyed).toContain("apiKey: k2");
		expect(rekeyed).not.toContain("apiKey: k1");
		expect(rekeyed.match(/auto-model-router:/g)).toHaveLength(1);
		expect(rekeyed).toContain("openai:");
	});

	test("a hand-written provider of the same name is left alone", () => {
		expect(hasForeignRouterProvider(yaml("providers:", "  auto-model-router:", "    baseUrl: http://127.0.0.1:1/v1"))).toBe(true);
		expect(hasForeignRouterProvider(mergeModelsYml("", renderRemoteModelsYml("https://t", "k", BLEND)))).toBe(false);
		expect(hasForeignRouterProvider(yaml("providers:", "  openai: {}"))).toBe(false);
	});
});
