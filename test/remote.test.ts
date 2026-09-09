import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addExtensions, codexBlock, connectRemote, setDotenv, type ConnectOptions } from "../src/cli/connect.ts";
import { parseRemoteRouter, readRemoteRouter, remoteProviderRegistration } from "../omp-extension/remote-logic.ts";
import { existingBlockScope, hasForeignRouterProvider, mergeModelsYml, renderRemoteModelsYml } from "../src/cli/connect.ts";
import { refreshAndRewrite, refreshCredential, RefreshError, resolveRefreshToken, shouldRefresh } from "../src/cli/refresh.ts";
import { loadRefreshToken, pickStore, removeRefreshToken, saveRefreshToken } from "../src/cli/credential-store.ts";
import { hasRefresh, refreshAccountOf } from "../omp-extension/remote-logic.ts";

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
		// Claude Code is configured through its settings file now, so nothing ANTHROPIC_* rides in the environment.
		expect(r1.envLines).toEqual(["AUTO_MODEL_ROUTER_URL=https://team.example", "AUTO_MODEL_ROUTER_API_KEY=amrt_key"]);
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
		expect(rc).toContain("export AUTO_MODEL_ROUTER_URL=https://team.example");
		expect(rc).not.toContain("ANTHROPIC_");
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
			// The refresh token is in the store (the file here: no platform tool on PATH); remote.json only names it.
			expect(before).toMatchObject({ key: "amrt_old", keyExpiresAtMs: 1, device: "laptop", refreshTokenStore: "file", refreshAccount: "u_ada@team.example" });
			expect(before.refreshToken).toBeUndefined();
			expect(readFileSync(join(routerHome, "refresh.token"), "utf8").trim()).toBe("amrr_r1");
			const models0 = readFileSync(join(agent, "models.yml"), "utf8");
			expect(models0).toContain("apiKey: amrt_old");
			expect(existingBlockScope(models0)).toBe("omp-router");
			// Then a refresh, which knows nothing about the scope.
			const fetchImpl = (async () => Response.json({ key: "amrt_new", keyExpiresAtMs: 50, refreshToken: "amrr_r2", refreshExpiresAtMs: 90 })) as unknown as typeof fetch;
			const fresh = await refreshAndRewrite({ remote: parseRemoteRouter(readFileSync(join(routerHome, "remote.json"), "utf8"))!, fetchImpl, home, packageDir: process.cwd(), env, platform: "linux", pathHas: () => false, routerHome });
			expect(fresh.key).toBe("amrt_new");
			const after = JSON.parse(readFileSync(join(routerHome, "remote.json"), "utf8")) as Record<string, unknown>;
			expect(after).toMatchObject({ key: "amrt_new", keyExpiresAtMs: 50, refreshExpiresAtMs: 90, device: "laptop", joinedAtMs: before.joinedAtMs, refreshTokenStore: "file" });
			expect(after.refreshToken).toBeUndefined();
			expect(readFileSync(join(routerHome, "refresh.token"), "utf8").trim()).toBe("amrr_r2");
			const models1 = readFileSync(join(agent, "models.yml"), "utf8");
			expect(models1).toContain("apiKey: amrt_new");
			expect(models1).not.toContain("amrt_old");
			expect(existingBlockScope(models1)).toBe("omp-router"); // kept, not lost
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("the refresh token lives in the OS credential store", () => {
	const NL = String.fromCharCode(10);
	// A fake backend stands in for DPAPI / the keychain / secret-service.
	const vault = new Map<string, string>();
	const backend = { save: (a: string, s: string) => void vault.set(a, s), load: (a: string) => vault.get(a) ?? null, remove: (a: string) => void vault.delete(a) };

	test("the store is picked from the platform and its tools; the file is the fallback everywhere", () => {
		expect(pickStore("win32", (b) => b === "powershell")).toBe("dpapi");
		expect(pickStore("win32", () => false)).toBe("file");
		expect(pickStore("darwin", (b) => b === "security")).toBe("keychain");
		expect(pickStore("linux", (b) => b === "secret-tool")).toBe("secret-service");
		expect(pickStore("linux", () => false)).toBe("file");
		expect(refreshAccountOf("https://team.example:8790/", "u_ada")).toBe("u_ada@team.example:8790");
	});

	test("save/load through a store, and the file fallback keeps the token owner-readable", () => {
		const home = mkdtempSync(join(tmpdir(), "amr-store-"));
		try {
			expect(saveRefreshToken(home, "u@t", "amrr_x", "keychain", { backend })).toBe("keychain");
			expect(loadRefreshToken(home, "u@t", "keychain", { backend })).toBe("amrr_x");
			expect(existsSync(join(home, "refresh.token"))).toBe(false); // nothing on disk
			expect(saveRefreshToken(home, "u@t", "amrr_f", "file")).toBe("file");
			expect(loadRefreshToken(home, "u@t", "file")).toBe("amrr_f");
			removeRefreshToken(home, "u@t", { backend });
			expect(loadRefreshToken(home, "u@t", "keychain", { backend })).toBeNull();
			expect(existsSync(join(home, "refresh.token"))).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("connect files the token in the store and remote.json only names it; refresh reads it back; an older inline token still works", async () => {
		const home = mkdtempSync(join(tmpdir(), "amr-store2-"));
		const agent = join(home, ".omp", "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "config.yml"), "extensions: []" + NL);
		const rh = join(home, ".auto-model-router");
		const env = { HOME: home, PI_CODING_AGENT_DIR: agent, AUTO_MODEL_ROUTER_HOME: rh, HERMES_HOME: join(home, "no-hermes") };
		try {
			const { connectRemote } = await import("../src/cli/connect.ts");
			connectRemote({ url: "https://team.example", key: "amrt_k1", userId: "u_ada", name: "Ada", refreshToken: "amrr_r1", keyExpiresAtMs: 1, refreshExpiresAtMs: 2, device: "laptop", store: "keychain", storeDeps: { backend }, profile: false, dryRun: false, only: ["omp"], env, home, packageDir: process.cwd(), platform: "darwin", pathHas: () => false });
			const written = readFileSync(join(rh, "remote.json"), "utf8");
			expect(written).not.toContain("amrr_r1");
			const remote = parseRemoteRouter(written)!;
			expect(remote).toMatchObject({ refreshTokenStore: "keychain", refreshAccount: "u_ada@team.example" });
			expect(remote.refreshToken).toBeUndefined();
			expect(hasRefresh(remote)).toBe(true);
			expect(resolveRefreshToken(remote, rh, { backend })).toBe("amrr_r1");
			// The refresh trades the stored token and files the new one in the same store.
			const seen: string[] = [];
			const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
				seen.push(String(init?.body));
				return Response.json({ key: "amrt_k2", keyExpiresAtMs: 50, refreshToken: "amrr_r2", refreshExpiresAtMs: 90 });
			}) as unknown as typeof fetch;
			await refreshAndRewrite({ remote, fetchImpl, home, packageDir: process.cwd(), env, platform: "darwin", pathHas: () => false, routerHome: rh, storeDeps: { backend } });
			expect(seen[0]).toBe(JSON.stringify({ refreshToken: "amrr_r1" }));
			expect(vault.get("u_ada@team.example")).toBe("amrr_r2");
			expect(readFileSync(join(rh, "remote.json"), "utf8")).not.toContain("amrr_r2");
			// An older remote.json with the token inline is honoured until its next refresh.
			const legacy = parseRemoteRouter(JSON.stringify({ url: "https://t", key: "k", refreshToken: "amrr_inline" }))!;
			expect(resolveRefreshToken(legacy, rh)).toBe("amrr_inline");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("connect writes Claude Code's settings: base URL in env, a key helper instead of a key, other settings kept", async () => {
		const home = mkdtempSync(join(tmpdir(), "amr-claude-"));
		const claude = join(home, ".claude");
		mkdirSync(claude, { recursive: true });
		writeFileSync(join(claude, "settings.json"), JSON.stringify({ theme: "dark", env: { ANTHROPIC_API_KEY: "sk-old", FOO: "bar" } }, null, 2) + NL);
		const env = { HOME: home, PI_CODING_AGENT_DIR: join(home, "no-omp"), AUTO_MODEL_ROUTER_HOME: join(home, ".auto-model-router"), HERMES_HOME: join(home, "no-hermes") };
		try {
			const { connectRemote } = await import("../src/cli/connect.ts");
			const r = connectRemote({ url: "https://team.example", key: "amrt_k", userId: "u_ada", name: "Ada", profile: false, dryRun: false, only: ["claude"], env, home, packageDir: "/pkg", platform: "linux", pathHas: () => false });
			expect(r.configured.some((c) => c.startsWith("Claude Code ("))).toBe(true);
			const s = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")) as { theme: string; env: Record<string, string>; apiKeyHelper: string };
			expect(s.theme).toBe("dark");
			expect(s.env).toEqual({ FOO: "bar", ANTHROPIC_BASE_URL: "https://team.example" }); // the stale key is gone
			expect(s.apiKeyHelper).toMatch(/^bun run ".*\/pkg\/src\/index\.ts" token$/); // an absolute path, drive letter and all on Windows
			expect(r.envLines.some((l) => l.startsWith("ANTHROPIC_API_KEY="))).toBe(false);
			expect(readdirSync(claude).some((f) => f.startsWith("settings.json.") && f.endsWith(".bak"))).toBe(true); // the previous file was kept
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
