import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectRemote, fetchSetupInfo, MCP_SERVER_NAME, mergeMcpServers } from "../src/cli/connect.ts";
import { refreshAndRewrite } from "../src/cli/refresh.ts";
import { parseRemoteRouter } from "../omp-extension/remote-logic.ts";

const NL = "\n";
const read = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const servers = (p: string): Record<string, unknown> => (read(p).mcpServers as Record<string, unknown>) ?? {};
const auth = (p: string): string => (servers(p)[MCP_SERVER_NAME] as { headers: { Authorization: string } }).headers.Authorization;

describe("mergeMcpServers", () => {
	test("adds the team-context server next to the others and keeps every other key", () => {
		const before = JSON.stringify({ $schema: "https://x/mcp-schema.json", mcpServers: { agentdox: { type: "http", url: "http://localhost:3003/mcp" } }, other: 1 });
		const after = mergeMcpServers(before, "https://team.example/mcp", "amrt_k");
		expect(after).not.toBeNull();
		const doc = JSON.parse(after!) as Record<string, unknown>;
		expect(doc.$schema).toBe("https://x/mcp-schema.json");
		expect(doc.other).toBe(1);
		expect(doc.mcpServers).toEqual({
			agentdox: { type: "http", url: "http://localhost:3003/mcp" },
			[MCP_SERVER_NAME]: { type: "http", url: "https://team.example/mcp", headers: { Authorization: "Bearer amrt_k" } },
		});
		expect(after!.endsWith("\n")).toBe(true);
	});

	test("an empty or missing file becomes a fresh mcpServers document", () => {
		expect(JSON.parse(mergeMcpServers("", "https://t/mcp", "k")!)).toEqual({ mcpServers: { [MCP_SERVER_NAME]: { type: "http", url: "https://t/mcp", headers: { Authorization: "Bearer k" } } } });
		expect(JSON.parse(mergeMcpServers("  \n", "https://t/mcp", "k")!)).toHaveProperty("mcpServers");
	});

	test("is idempotent, removes on null, and leaves a file it cannot parse alone", () => {
		const one = mergeMcpServers("", "https://t/mcp", "k")!;
		expect(mergeMcpServers(one, "https://t/mcp", "k")).toBeNull(); // unchanged
		expect(mergeMcpServers(one, "https://t/mcp", "k2")).not.toBeNull(); // a new key rewrites
		const removed = mergeMcpServers(one, null, "k")!;
		expect(JSON.parse(removed)).toEqual({ mcpServers: {} });
		expect(mergeMcpServers(removed, null, "k")).toBeNull(); // nothing to remove
		expect(mergeMcpServers("{ not json", "https://t/mcp", "k")).toBeNull();
		expect(mergeMcpServers("[1,2]", "https://t/mcp", "k")).toBeNull();
	});
});

describe("connect writes the team MCP endpoint", () => {
	function fixture(): { home: string; agent: string; env: Record<string, string> } {
		const home = mkdtempSync(join(tmpdir(), "amr-mcp-connect-"));
		mkdirSync(join(home, ".claude"), { recursive: true });
		const agent = join(home, ".omp", "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "config.yml"), `extensions: []${NL}`, "utf8");
		const env = { HOME: home, PI_CODING_AGENT_DIR: agent, AUTO_MODEL_ROUTER_HOME: join(home, ".auto-model-router"), HERMES_HOME: join(home, "no-hermes") };
		return { home, agent, env };
	}

	test("into omp mcp.json and Claude Code ~/.claude.json, only for the harnesses it configured", () => {
		const { home, agent, env } = fixture();
		try {
			// Pre-existing servers and unrelated settings survive.
			writeFileSync(join(agent, "mcp.json"), JSON.stringify({ $schema: "s", mcpServers: { agentdox: { type: "http", url: "http://localhost:3003/mcp" } } }, null, 2));
			writeFileSync(join(home, ".claude.json"), JSON.stringify({ claudeAiMcpEverConnected: true, mcpServers: {} }));
			const r = connectRemote({ url: "https://team.example", key: "amrt_k", userId: "u", name: "Ada", profile: false, dryRun: false, only: ["omp", "claude"], env, home, packageDir: "/pkg", mcp: { url: "https://team.example/mcp" }, platform: "linux", pathHas: () => false });
			expect(r.mcp?.length).toBe(2);
			expect(r.configured.some((c) => c.startsWith(`MCP (${MCP_SERVER_NAME} → https://team.example/mcp`))).toBe(true);
			const omp = read(join(agent, "mcp.json"));
			expect(omp.$schema).toBe("s");
			expect(servers(join(agent, "mcp.json"))).toEqual({
				agentdox: { type: "http", url: "http://localhost:3003/mcp" },
				[MCP_SERVER_NAME]: { type: "http", url: "https://team.example/mcp", headers: { Authorization: "Bearer amrt_k" } },
			});
			const claude = read(join(home, ".claude.json"));
			expect(claude.claudeAiMcpEverConnected).toBe(true);
			expect(servers(join(home, ".claude.json"))[MCP_SERVER_NAME]).toEqual({ type: "http", url: "https://team.example/mcp", headers: { Authorization: "Bearer amrt_k" } });

			// A second connect with the same key changes nothing.
			const r2 = connectRemote({ url: "https://team.example", key: "amrt_k", userId: "u", name: "Ada", profile: false, dryRun: false, only: ["omp", "claude"], env, home, packageDir: "/pkg", mcp: { url: "https://team.example/mcp" }, platform: "linux", pathHas: () => false });
			expect(r2.mcp).toEqual([]);

			// Only Claude Code asked for: the omp file is not touched even though it exists.
			rmSync(join(agent, "mcp.json"));
			const r3 = connectRemote({ url: "https://team.example", key: "amrt_k3", userId: "u", name: "Ada", profile: false, dryRun: false, only: ["claude"], env, home, packageDir: "/pkg", mcp: { url: "https://team.example/mcp" }, platform: "linux", pathHas: () => false });
			expect(r3.mcp).toEqual([join(home, ".claude.json")]);
			expect(existsSync(join(agent, "mcp.json"))).toBe(false);
			expect(auth(join(home, ".claude.json"))).toBe("Bearer amrt_k3");

			// A remote that stops serving MCP has the entry removed; the neighbours stay.
			const r4 = connectRemote({ url: "https://team.example", key: "amrt_k3", userId: "u", name: "Ada", profile: false, dryRun: false, only: ["claude"], env, home, packageDir: "/pkg", mcp: { url: null }, platform: "linux", pathHas: () => false });
			expect(r4.mcp).toEqual([join(home, ".claude.json")]);
			expect(servers(join(home, ".claude.json"))).toEqual({});
			expect(read(join(home, ".claude.json")).claudeAiMcpEverConnected).toBe(true);
			expect(r4.configured.some((c) => c.startsWith("MCP ("))).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a dry run reports the files without writing them; no mcp option leaves them alone", () => {
		const { home, agent, env } = fixture();
		try {
			const r = connectRemote({ url: "https://team.example", key: "amrt_k", userId: "u", name: "Ada", profile: false, dryRun: true, only: ["omp"], env, home, packageDir: "/pkg", mcp: { url: "https://team.example/mcp" }, platform: "linux", pathHas: () => false });
			expect(r.mcp).toEqual([join(agent, "mcp.json")]);
			expect(existsSync(join(agent, "mcp.json"))).toBe(false);
			const r2 = connectRemote({ url: "https://team.example", key: "amrt_k", userId: "u", name: "Ada", profile: false, dryRun: false, only: ["omp"], env, home, packageDir: "/pkg", platform: "linux", pathHas: () => false });
			expect(r2.mcp).toBeUndefined();
			expect(existsSync(join(agent, "mcp.json"))).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("refresh rewrites the entry with the new key, asking the remote whether it still serves MCP", async () => {
		const { home, agent, env } = fixture();
		const routerHome = env.AUTO_MODEL_ROUTER_HOME!;
		try {
			connectRemote({ url: "https://team.example", key: "amrt_old", userId: "u_ada", name: "Ada", refreshToken: "amrr_r1", keyExpiresAtMs: 1, refreshExpiresAtMs: 2, profile: false, dryRun: false, only: ["omp"], env, home, packageDir: process.cwd(), mcp: { url: "https://team.example/mcp" }, platform: "linux", pathHas: () => false });
			expect(auth(join(agent, "mcp.json"))).toBe("Bearer amrt_old");
			const seen: string[] = [];
			const fetchImpl = (async (input: string | URL | Request) => {
				const url = String(input);
				seen.push(url);
				if (url.endsWith("/setup/info")) return Response.json({ version: "0.18.0", mcp: true });
				if (url.endsWith("/setup/skills")) return new Response("", { status: 404 });
				return Response.json({ key: "amrt_new", keyExpiresAtMs: 50, refreshToken: "amrr_r2", refreshExpiresAtMs: 90 });
			}) as unknown as typeof fetch;
			const remote = parseRemoteRouter(readFileSync(join(routerHome, "remote.json"), "utf8"))!;
			await refreshAndRewrite({ remote, fetchImpl, home, packageDir: process.cwd(), env, platform: "linux", pathHas: () => false, routerHome });
			expect(seen.some((u) => u === "https://team.example/setup/info")).toBe(true);
			expect(servers(join(agent, "mcp.json"))[MCP_SERVER_NAME]).toEqual({ type: "http", url: "https://team.example/mcp", headers: { Authorization: "Bearer amrt_new" } });
			// The remote no longer serves MCP (a plain router answers 404): the entry goes.
			const plain = (async (input: string | URL | Request) => {
				const url = String(input);
				if (url.endsWith("/setup/info") || url.endsWith("/setup/skills")) return new Response("", { status: 404 });
				return Response.json({ key: "amrt_new2", keyExpiresAtMs: 60, refreshToken: "amrr_r3", refreshExpiresAtMs: 99 });
			}) as unknown as typeof fetch;
			const remote2 = parseRemoteRouter(readFileSync(join(routerHome, "remote.json"), "utf8"))!;
			await refreshAndRewrite({ remote: remote2, fetchImpl: plain, home, packageDir: process.cwd(), env, platform: "linux", pathHas: () => false, routerHome });
			expect(servers(join(agent, "mcp.json"))).toEqual({});
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("fetchSetupInfo", () => {
	test("reads mcp from a team, and answers false for a plain router, a bad body or a dead remote", async () => {
		expect(await fetchSetupInfo("https://t", (async () => Response.json({ mcp: true })) as unknown as typeof fetch)).toEqual({ mcp: true });
		expect(await fetchSetupInfo("https://t", (async () => Response.json({ mcp: "yes" })) as unknown as typeof fetch)).toEqual({ mcp: false });
		expect(await fetchSetupInfo("https://t", (async () => new Response("", { status: 404 })) as unknown as typeof fetch)).toEqual({ mcp: false });
		expect(await fetchSetupInfo("https://t", (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)).toEqual({ mcp: false });
		expect(
			await fetchSetupInfo("https://t", (async () => {
				throw new Error("down");
			}) as unknown as typeof fetch),
		).toEqual({ mcp: false });
	});
});
