import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addExtensions, codexBlock, connectRemote, setDotenv, type ConnectOptions } from "../src/cli/connect.ts";
import { parseRemoteRouter, readRemoteRouter, remoteProviderRegistration } from "../omp-extension/remote-logic.ts";
import { existingBlockScope, hasForeignRouterProvider, mergeModelsYml, renderRemoteModelsYml } from "../src/cli/connect.ts";
import { refreshAndRewrite, refreshCredential, RefreshError, shouldRefresh } from "../src/cli/refresh.ts";

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

describe("short-lived remote credentials", () => {
	const NL = String.fromCharCode(10);
	const remote = { url: "https://team.example", key: "amrt_old", userId: "u_ada", name: "Ada", joinedAtMs: 1, refreshToken: "amrr_r1", keyExpiresAtMs: 0, refreshExpiresAtMs: 0, device: "laptop" };

	test("remote.json round-trips the credential fields, and a permanent key has none", () => {
		const parsed = parseRemoteRouter(JSON.stringify(remote))!;
		expect(parsed).toMatchObject({ refreshToken: "amrr_r1", keyExpiresAtMs: 0, refreshExpiresAtMs: 0, device: "laptop" });
		const permanent = parseRemoteRouter(JSON.stringify({ url: "https://t", key: "k" }))!;
		expect(permanent.refreshToken).toBeUndefined();
		expect(shouldRefresh(permanent)).toBe(false);
	});

	test("a key is refreshed a day ahead of expiry, never without a refresh token", () => {
		const now = 1_000_000_000_000;
		const day = 24 * 3_600_000;
		expect(shouldRefresh({ ...remote, keyExpiresAtMs: now + 3 * day }, now)).toBe(false);
		expect(shouldRefresh({ ...remote, keyExpiresAtMs: now + day - 1 }, now)).toBe(true);
		expect(shouldRefresh({ ...remote, keyExpiresAtMs: now - 1 }, now)).toBe(true); // already dead: still worth a try
		expect(shouldRefresh({ ...remote, keyExpiresAtMs: now - 1, refreshToken: "" }, now)).toBe(false);
	});

	test("refreshCredential trades at /auth/refresh and surfaces the remote's refusal code", async () => {
		const calls: { url: string; body: string }[] = [];
		const ok = (async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), body: String(init?.body) });
			return Response.json({ key: "amrt_new", keyExpiresAtMs: 5, refreshToken: "amrr_r2", refreshExpiresAtMs: 9, device: "laptop" });
		}) as unknown as typeof fetch;
		const fresh = await refreshCredential(remote, ok);
		expect(fresh).toEqual({ key: "amrt_new", keyExpiresAtMs: 5, refreshToken: "amrr_r2", refreshExpiresAtMs: 9, device: "laptop" });
		expect(calls[0]).toEqual({ url: "https://team.example/auth/refresh", body: JSON.stringify({ refreshToken: "amrr_r1" }) });
		const refused = (async () => Response.json({ error: { code: "refresh_reused", message: "already used" } }, { status: 401 })) as unknown as typeof fetch;
		let err: RefreshError | null = null;
		try {
			await refreshCredential(remote, refused);
		} catch (e) {
			err = e as RefreshError;
		}
		expect(err?.code).toBe("refresh_reused");
		expect(err?.message).toBe("already used");
		await expect(refreshCredential({ ...remote, refreshToken: "" }, ok)).rejects.toBeInstanceOf(RefreshError);
	});

	test("refreshAndRewrite re-writes remote.json and the managed models.yml block, keeping its scope and join time", async () => {
		const home = mkdtempSync(join(tmpdir(), "amr-refresh-"));
		const agent = join(home, ".omp", "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "config.yml"), "extensions: []" + NL);
		const routerHome = join(home, ".auto-model-router");
		const env = { HOME: home, PI_CODING_AGENT_DIR: agent, AUTO_MODEL_ROUTER_HOME: routerHome, HERMES_HOME: join(home, "no-hermes") };
		try {
			// First: a connect with a scope and a credential.
			const { connectRemote } = await import("../src/cli/connect.ts");
			connectRemote({ url: "https://team.example", key: "amrt_old", userId: "u_ada", name: "Ada", refreshToken: "amrr_r1", keyExpiresAtMs: 1, refreshExpiresAtMs: 2, device: "laptop", agentdoxScope: "omp-router", profile: false, dryRun: false, only: ["omp"], env, home, packageDir: process.cwd(), platform: "linux", pathHas: () => false });
			const before = JSON.parse(readFileSync(join(routerHome, "remote.json"), "utf8")) as Record<string, unknown>;
			expect(before).toMatchObject({ key: "amrt_old", refreshToken: "amrr_r1", keyExpiresAtMs: 1, device: "laptop" });
			const models0 = readFileSync(join(agent, "models.yml"), "utf8");
			expect(models0).toContain("apiKey: amrt_old");
			expect(existingBlockScope(models0)).toBe("omp-router");
			// Then a refresh, which knows nothing about the scope.
			const fetchImpl = (async () => Response.json({ key: "amrt_new", keyExpiresAtMs: 50, refreshToken: "amrr_r2", refreshExpiresAtMs: 90 })) as unknown as typeof fetch;
			const fresh = await refreshAndRewrite({ remote: parseRemoteRouter(readFileSync(join(routerHome, "remote.json"), "utf8"))!, fetchImpl, home, packageDir: process.cwd(), env, platform: "linux", pathHas: () => false });
			expect(fresh.key).toBe("amrt_new");
			const after = JSON.parse(readFileSync(join(routerHome, "remote.json"), "utf8")) as Record<string, unknown>;
			expect(after).toMatchObject({ key: "amrt_new", refreshToken: "amrr_r2", keyExpiresAtMs: 50, refreshExpiresAtMs: 90, device: "laptop", joinedAtMs: before.joinedAtMs });
			const models1 = readFileSync(join(agent, "models.yml"), "utf8");
			expect(models1).toContain("apiKey: amrt_new");
			expect(models1).not.toContain("amrt_old");
			expect(existingBlockScope(models1)).toBe("omp-router"); // kept, not lost
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
