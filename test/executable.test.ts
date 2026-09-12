import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildExecutable, collectPackageFiles, executableFileName, hostTarget, isExecutableTarget } from "../src/cli/build-executable.ts";
import { connectRemote, exchangeSetupToken } from "../src/cli/connect.ts";
import { EMBEDDED_GLOBAL, embeddedHandle, isCompiled, materializePackage, readEmbeddedPackage } from "../src/cli/embedded.ts";
import { parseRemoteRouter } from "../omp-extension/remote-logic.ts";

const NL = String.fromCharCode(10);

describe("the single-file member install", () => {
	test("the embedded package is the install: CLI, harness integrations, runtime deps; no tests, no caches", async () => {
		const pkg = collectPackageFiles(process.cwd());
		expect(pkg.version).toBe((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version);
		expect(pkg.files["src/index.ts"]).toContain("connect");
		expect(pkg.files["omp-extension/router-embed.ts"]).toBeDefined();
		expect(pkg.files["hermes-plugin/native/__init__.py"] ?? pkg.files[Object.keys(pkg.files).find((k) => k.startsWith("hermes-plugin/")) ?? ""]).toBeDefined();
		expect(pkg.files["node_modules/zod/package.json"]).toBeDefined();
		expect(pkg.files["node_modules/yaml/package.json"]).toBeDefined();
		const names = Object.keys(pkg.files);
		// Every non-test source file, none missing: a dropped one only fails on a member machine, when the extension imports it.
		const onDisk = readdirSync("src", { recursive: true }).map(String).filter((f) => /\.(ts|py|yaml)$/.test(f) && !f.endsWith(".test.ts")).map((f) => `src/${f.replaceAll("\\", "/")}`);
		expect(onDisk.length).toBeGreaterThan(50);
		for (const f of onDisk) expect(names).toContain(f);
		expect(names.some((n) => n.endsWith(".test.ts"))).toBe(false);
		expect(names.some((n) => n.includes("__pycache__") || n.endsWith(".pyc"))).toBe(false);
		expect(names.some((n) => /\.d\.ts$/.test(n) && n.startsWith("node_modules/"))).toBe(false);
	});

	test("targets and file names", async () => {
		expect(isExecutableTarget("linux-x64")).toBe(true);
		expect(isExecutableTarget("linux-x86")).toBe(false);
		expect(executableFileName("windows-x64")).toBe("auto-model-router-windows-x64.exe");
		expect(executableFileName("darwin-arm64")).toBe("auto-model-router-darwin-arm64");
		expect(hostTarget("win32", "x64")).toBe("windows-x64");
		expect(hostTarget("darwin", "arm64")).toBe("darwin-arm64");
		expect(hostTarget("win32", "arm64")).toBeNull();
	});

	test("under bun there is no embedded package", async () => {
		expect(isCompiled()).toBe(false);
		expect(embeddedHandle()).toBeNull();
		expect(await readEmbeddedPackage()).toBeNull();
	});

	test("materializing writes the files once, keyed by content, under the router home", async () => {
		const home = mkdtempSync(join(tmpdir(), "amr-mat-"));
		try {
			const pkg = { version: "9.9.9", files: { "package.json": `{"version":"9.9.9"}${NL}`, "src/index.ts": `console.log(1)${NL}`, "omp-extension/x.ts": "export {}" } };
			const dir = materializePackage(home, pkg);
			expect(dir).toBe(join(home, "package", "9.9.9"));
			expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toBe(`console.log(1)${NL}`);
			// Unchanged: a second call leaves a hand-edited file alone (nothing is rewritten).
			writeFileSync(join(dir, "src", "index.ts"), "edited", "utf8");
			expect(materializePackage(home, pkg)).toBe(dir);
			expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toBe("edited");
			// A rebuilt executable of the same version with different content refreshes it.
			expect(materializePackage(home, { ...pkg, files: { ...pkg.files, "src/index.ts": "v2" } })).toBe(dir);
			expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toBe("v2");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("connect from the executable: it is Claude Code's key helper, goes on PATH, and remote.json names it", async () => {
		const home = mkdtempSync(join(tmpdir(), "amr-exe-connect-"));
		const claude = join(home, ".claude");
		mkdirSync(claude, { recursive: true });
		const rh = join(home, ".auto-model-router");
		const env = { HOME: home, PI_CODING_AGENT_DIR: join(home, "no-omp"), AUTO_MODEL_ROUTER_HOME: rh, HERMES_HOME: join(home, "no-hermes"), SHELL: "/bin/zsh" };
		const exe = join(rh, "bin", "auto-model-router");
		try {
			const r = connectRemote({ url: "https://team.example", key: "amrt_k", userId: "u_ada", name: "Ada", profile: true, dryRun: false, only: ["claude"], env, home, packageDir: join(rh, "package", "1.0.0"), exePath: exe, platform: "linux", pathHas: () => false });
			expect(r.configured.some((c) => c.startsWith("Claude Code ("))).toBe(true);
			const s = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8")) as { apiKeyHelper: string };
			expect(s.apiKeyHelper).toBe(`"${exe.replaceAll("\\", "/")}" token`);
			expect(parseRemoteRouter(readFileSync(join(rh, "remote.json"), "utf8"))?.executable).toBe(exe);
			const rc = readFileSync(join(home, ".zshrc"), "utf8");
			expect(rc).toContain(`export PATH="${join(rh, "bin")}:$PATH"`);
			expect(rc).toContain("export AUTO_MODEL_ROUTER_URL=https://team.example");
			// Re-running keeps one block.
			connectRemote({ url: "https://team.example", key: "amrt_k2", userId: "u_ada", name: "Ada", profile: true, dryRun: false, only: ["claude"], env, home, packageDir: join(rh, "package", "1.0.0"), exePath: exe, platform: "linux", pathHas: () => false });
			expect(readFileSync(join(home, ".zshrc"), "utf8").split("# auto-model-router remote").length).toBe(2);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a setup token is traded for the credential; a refused token says so", async () => {
		const seen: { url: string; body: string }[] = [];
		const ok = (async (url: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(url), body: String(init?.body) });
			return Response.json({ key: "amrt_new", refreshToken: "amrr_new", keyExpiresAtMs: 10, refreshExpiresAtMs: 20, userId: "u_ada", name: "Ada", teamUrl: "https://team.example" });
		}) as unknown as typeof fetch;
		const issued = await exchangeSetupToken("https://team.example", "amrs_t", "laptop", ok);
		expect(issued).toEqual({ key: "amrt_new", refreshToken: "amrr_new", keyExpiresAtMs: 10, refreshExpiresAtMs: 20, userId: "u_ada", name: "Ada" });
		expect(seen[0]?.url).toBe("https://team.example/setup/exchange");
		expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ token: "amrs_t", device: "laptop" });
		const refused = (async () => Response.json({ error: "invalid_token" }, { status: 401 })) as unknown as typeof fetch;
		(await expect(exchangeSetupToken("https://team.example", "amrs_old", "laptop", refused))).rejects.toThrow("refused");
	});

	test("the executable builds for this host and knows its version from the embedded package", async () => {
		const target = hostTarget();
		if (target === null) return;
		const dir = mkdtempSync(join(tmpdir(), "amr-build-"));
		try {
			const out = join(dir, executableFileName(target));
			const r = await buildExecutable({ packageDir: process.cwd(), target, outFile: out });
			if (!r.ok) throw new Error(r.reason);
			expect(existsSync(out)).toBe(true);
			expect(r.bytes).toBeGreaterThan(10_000_000);
			const version = Bun.spawnSync([out, "--version"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
			expect(version).toBe((JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);

	test("the global handle is what marks a compiled process", async () => {
		const g = globalThis as Record<string, unknown>;
		g[EMBEDDED_GLOBAL] = { manifestPath: "/$bunfs/root/manifest.json" };
		try {
			expect(isCompiled()).toBe(true);
			expect(embeddedHandle()?.manifestPath).toBe("/$bunfs/root/manifest.json");
		} finally {
			delete g[EMBEDDED_GLOBAL];
		}
		expect(isCompiled()).toBe(false);
	});
});
