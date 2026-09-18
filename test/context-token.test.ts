import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectRemote, MCP_SERVER_NAME } from "../src/cli/connect.ts";
import { refreshAndRewrite } from "../src/cli/refresh.ts";
import { CONTEXT_TOKEN_RENEW_AHEAD_MS, dueForRenewal, ensureContextToken, mintContextToken, storedContextToken } from "../src/cli/context-token.ts";
import { contextAccountOf, loadContextToken, loadRefreshToken, saveContextToken, saveRefreshToken } from "../src/cli/credential-store.ts";
import { parseRemoteRouter } from "../omp-extension/remote-logic.ts";

const NL = String.fromCharCode(10);
const DAY = 24 * 3_600_000;
const read = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
const servers = (p: string): Record<string, unknown> => (read(p).mcpServers as Record<string, unknown>) ?? {};
const auth = (p: string): string | undefined => (servers(p)[MCP_SERVER_NAME] as { headers?: { Authorization?: string } } | undefined)?.headers?.Authorization;

/** An omp+router home wired the way `connect` expects to find one. */
function fixture(prefix: string): { home: string; agent: string; rh: string; env: Record<string, string> } {
	const home = mkdtempSync(join(tmpdir(), prefix));
	const agent = join(home, ".omp", "agent");
	mkdirSync(agent, { recursive: true });
	writeFileSync(join(agent, "config.yml"), `extensions: []${NL}`, "utf8");
	const rh = join(home, ".auto-model-router");
	return { home, agent, rh, env: { HOME: home, PI_CODING_AGENT_DIR: agent, AUTO_MODEL_ROUTER_HOME: rh, HERMES_HOME: join(home, "no-hermes") } };
}

/** A fake OS credential store; one map, keyed by account, so both slots land in it. */
function vault(): { map: Map<string, string>; backend: { save(a: string, s: string): void; load(a: string): string | null; remove(a: string): void } } {
	const map = new Map<string, string>();
	return { map, backend: { save: (a, s) => void map.set(a, s), load: (a) => map.get(a) ?? null, remove: (a) => void map.delete(a) } };
}

describe("when a context token is due for renewal", () => {
	test("none, an unknown expiry, or inside the 30-day window; a year out is left alone", async () => {
		const now = Date.now();
		expect(CONTEXT_TOKEN_RENEW_AHEAD_MS).toBe(30 * DAY);
		expect(dueForRenewal(null, now)).toBe(true);
		expect(dueForRenewal({ value: "" }, now)).toBe(true);
		// An expiry nobody recorded cannot be trusted; minting records one, so this converges.
		expect(dueForRenewal({ value: "amrctx_x" }, now)).toBe(true);
		expect(dueForRenewal({ value: "amrctx_x", expiresAtMs: now + 10 * DAY }, now)).toBe(true);
		expect(dueForRenewal({ value: "amrctx_x", expiresAtMs: now - DAY }, now)).toBe(true);
		expect(dueForRenewal({ value: "amrctx_x", expiresAtMs: now + 31 * DAY }, now)).toBe(false);
		expect(dueForRenewal({ value: "amrctx_x", expiresAtMs: now + 365 * DAY }, now)).toBe(false);
	});
});

describe("minting a context token", () => {
	test("posts the device name with the member key and reads the token back", async () => {
		const seen: { url: string; auth: string | null; body: string }[] = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), auth: (init?.headers as Record<string, string>).authorization ?? null, body: String(init?.body) });
			return Response.json({ token: "amrctx_new", id: "ctx_1", expiresAtMs: 99, deviceId: "dev_1" }, { status: 201 });
		}) as unknown as typeof fetch;
		expect(await mintContextToken("https://team.example", "amrt_key", "laptop", fetchImpl)).toEqual({ value: "amrctx_new", expiresAtMs: 99, id: "ctx_1" });
		expect(seen[0]).toEqual({ url: "https://team.example/me/context-tokens", auth: "Bearer amrt_key", body: JSON.stringify({ name: "laptop" }) });
	});

	test("an older team (404), a deployment that issues none (503), a junk body or a dead remote all answer null", async () => {
		const status = (code: number): typeof fetch => (async () => new Response("", { status: code })) as unknown as typeof fetch;
		expect(await mintContextToken("https://t", "k", "n", status(404))).toBeNull();
		expect(await mintContextToken("https://t", "k", "n", status(503))).toBeNull();
		expect(await mintContextToken("https://t", "k", "n", (async () => Response.json({ token: 7 })) as unknown as typeof fetch)).toBeNull();
		expect(await mintContextToken("https://t", "k", "n", (async () => new Response("<html>")) as unknown as typeof fetch)).toBeNull();
		expect(
			await mintContextToken("https://t", "k", "n", (async () => {
				throw new Error("down");
			}) as unknown as typeof fetch),
		).toBeNull();
	});
});

describe("ensureContextToken", () => {
	const never = (async () => {
		throw new Error("should not have been called");
	}) as unknown as typeof fetch;
	const mints = (value: string): typeof fetch => (async () => Response.json({ token: value, id: `id_${value}`, expiresAtMs: Date.now() + 365 * DAY })) as unknown as typeof fetch;

	test("an older team edition (member-key) mints nothing and keeps the access key", async () => {
		expect(await ensureContextToken({ url: "https://t", key: "amrt_k", mcpAuth: "member-key", routerHome: "/nowhere", name: "laptop", fetchImpl: never })).toBeNull();
	});

	test("a token the exchange already handed over wins, with no second round trip", async () => {
		const issued = { value: "amrctx_exchange", expiresAtMs: 1, id: "ctx_e" };
		expect(await ensureContextToken({ url: "https://t", key: "amrt_k", mcpAuth: "context-token", routerHome: "/nowhere", name: "laptop", issued, fetchImpl: never })).toEqual(issued);
	});

	test("a held token far from expiry is reused untouched; one inside the window is renewed", async () => {
		const { backend, map } = vault();
		const rh = "/nowhere";
		const remote = parseRemoteRouter(
			JSON.stringify({ url: "https://t", key: "amrt_k", userId: "u_ada", refreshTokenStore: "keychain", refreshAccount: "u_ada@t", contextTokenStore: "keychain", contextAccount: "u_ada@t#context", contextTokenExpiresAtMs: Date.now() + 200 * DAY, contextTokenId: "ctx_old" }),
		)!;
		map.set("u_ada@t#context", "amrctx_held");
		const opts = { url: "https://t", key: "amrt_k", mcpAuth: "context-token" as const, routerHome: rh, remote, name: "laptop", storeDeps: { backend } };
		expect(await ensureContextToken({ ...opts, fetchImpl: never })).toEqual({ value: "amrctx_held", expiresAtMs: remote.contextTokenExpiresAtMs!, id: "ctx_old" });
		// Move the expiry inside the renewal window and the same call mints instead.
		const soon = { ...remote, contextTokenExpiresAtMs: Date.now() + 10 * DAY };
		const renewed = await ensureContextToken({ ...opts, remote: soon, fetchImpl: mints("amrctx_fresh") });
		expect(renewed?.value).toBe("amrctx_fresh");
	});

	test("a mint that fails leaves the held token in place rather than breaking the tools", async () => {
		const { backend, map } = vault();
		map.set("u_ada@t#context", "amrctx_held");
		const remote = parseRemoteRouter(JSON.stringify({ url: "https://t", key: "amrt_k", userId: "u_ada", contextTokenStore: "keychain", contextAccount: "u_ada@t#context", contextTokenExpiresAtMs: Date.now() + DAY }))!;
		const dead = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
		expect((await ensureContextToken({ url: "https://t", key: "k", mcpAuth: "context-token", routerHome: "/nowhere", remote, name: "laptop", storeDeps: { backend }, fetchImpl: dead }))?.value).toBe("amrctx_held");
		// And with nothing held there is nothing to fall back to: the caller keeps the access key.
		map.clear();
		expect(await ensureContextToken({ url: "https://t", key: "k", mcpAuth: "context-token", routerHome: "/nowhere", remote, name: "laptop", storeDeps: { backend }, fetchImpl: dead })).toBeNull();
	});
});

describe("the context token lives beside the refresh token, never in a plain file when a store works", () => {
	test("its own slot: two secrets, two accounts, two fallback files, neither clobbering the other", async () => {
		const home = mkdtempSync(join(tmpdir(), "amr-ctx-store-"));
		const { backend } = vault();
		try {
			expect(contextAccountOf("u_ada@team.example")).toBe("u_ada@team.example#context");
			expect(saveRefreshToken(home, "u@t", "amrr_x", "keychain", { backend })).toBe("keychain");
			expect(saveContextToken(home, "u@t#context", "amrctx_x", "keychain", { backend })).toBe("keychain");
			expect(loadRefreshToken(home, "u@t", "keychain", { backend })).toBe("amrr_x");
			expect(loadContextToken(home, "u@t#context", "keychain", { backend })).toBe("amrctx_x");
			// Nothing on disk while a store takes them.
			expect(existsSync(join(home, "refresh.token"))).toBe(false);
			expect(existsSync(join(home, "context.token"))).toBe(false);
			// The file fallback keeps them apart.
			expect(saveRefreshToken(home, "u@t", "amrr_f", "file")).toBe("file");
			expect(saveContextToken(home, "u@t#context", "amrctx_f", "file")).toBe("file");
			expect(readFileSync(join(home, "refresh.token"), "utf8").trim()).toBe("amrr_f");
			expect(readFileSync(join(home, "context.token"), "utf8").trim()).toBe("amrctx_f");
			expect(loadRefreshToken(home, "u@t", "file")).toBe("amrr_f");
			expect(loadContextToken(home, "u@t#context", "file")).toBe("amrctx_f");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("connect files it in the store the refresh token uses; remote.json only names it", async () => {
		const { home, agent, rh, env } = fixture("amr-ctx-connect-");
		const { backend, map } = vault();
		try {
			connectRemote({
				url: "https://team.example",
				key: "amrt_k1",
				userId: "u_ada",
				name: "Ada",
				refreshToken: "amrr_r1",
				keyExpiresAtMs: 1,
				refreshExpiresAtMs: 2,
				device: "laptop",
				store: "keychain",
				storeDeps: { backend },
				profile: false,
				dryRun: false,
				only: ["omp"],
				env,
				home,
				packageDir: process.cwd(),
				mcp: { url: "https://team.example/mcp", token: "amrctx_t1", tokenExpiresAtMs: 4_000, tokenId: "ctx_1" },
				platform: "darwin",
				pathHas: () => false,
			});
			const written = readFileSync(join(rh, "remote.json"), "utf8");
			expect(written).not.toContain("amrctx_t1");
			expect(existsSync(join(rh, "context.token"))).toBe(false);
			const remote = parseRemoteRouter(written)!;
			expect(remote).toMatchObject({ contextTokenStore: "keychain", contextAccount: "u_ada@team.example#context", contextTokenExpiresAtMs: 4_000, contextTokenId: "ctx_1" });
			expect(map.get("u_ada@team.example#context")).toBe("amrctx_t1");
			expect(map.get("u_ada@team.example")).toBe("amrr_r1");
			expect(storedContextToken(remote, rh, { backend })).toEqual({ value: "amrctx_t1", expiresAtMs: 4_000, id: "ctx_1" });
			// The MCP entry carries the context token, NOT the 72-hour access key.
			expect(auth(join(agent, "mcp.json"))).toBe("Bearer amrctx_t1");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("a key refresh leaves the MCP entry alone", () => {
	/** A team edition that mints context tokens; `mcpAuth` is what tells connect so. */
	function teamFetch(opts: { key: string; mint?: { token: string; id: string; expiresAtMs: number } }): { fetchImpl: typeof fetch; seen: string[] } {
		const seen: string[] = [];
		const fetchImpl = (async (input: string | URL | Request) => {
			const url = String(input);
			seen.push(url);
			if (url.endsWith("/setup/info")) return Response.json({ version: "0.39.0", mcp: true, mcpAuth: "context-token" });
			if (url.endsWith("/setup/skills")) return new Response("", { status: 404 });
			if (url.endsWith("/me/context-tokens")) return opts.mint === undefined ? new Response("", { status: 503 }) : Response.json(opts.mint, { status: 201 });
			return Response.json({ key: opts.key, keyExpiresAtMs: 50, refreshToken: "amrr_r2", refreshExpiresAtMs: 90 });
		}) as unknown as typeof fetch;
		return { fetchImpl, seen };
	}

	function connected(env: Record<string, string>, home: string, backend: { save(a: string, s: string): void; load(a: string): string | null; remove(a: string): void }, expiresAtMs: number): void {
		connectRemote({
			url: "https://team.example",
			key: "amrt_old",
			userId: "u_ada",
			name: "Ada",
			refreshToken: "amrr_r1",
			keyExpiresAtMs: 1,
			refreshExpiresAtMs: 2,
			device: "laptop",
			store: "keychain",
			storeDeps: { backend },
			profile: false,
			dryRun: false,
			only: ["omp"],
			env,
			home,
			packageDir: process.cwd(),
			mcp: { url: "https://team.example/mcp", token: "amrctx_t1", tokenExpiresAtMs: expiresAtMs, tokenId: "ctx_1" },
			platform: "darwin",
			pathHas: () => false,
		});
	}

	test("the new access key goes everywhere but the team-context server, which keeps its token", async () => {
		const { home, agent, rh, env } = fixture("amr-ctx-refresh-");
		const { backend, map } = vault();
		try {
			connected(env, home, backend, Date.now() + 300 * DAY);
			expect(auth(join(agent, "mcp.json"))).toBe("Bearer amrctx_t1");
			const { fetchImpl, seen } = teamFetch({ key: "amrt_new" });
			const remote = parseRemoteRouter(readFileSync(join(rh, "remote.json"), "utf8"))!;
			await refreshAndRewrite({ remote, fetchImpl, home, packageDir: process.cwd(), env, platform: "darwin", pathHas: () => false, routerHome: rh, storeDeps: { backend } });
			// Nothing was minted: the held token is nowhere near expiry.
			expect(seen.some((u) => u.endsWith("/me/context-tokens"))).toBe(false);
			expect(auth(join(agent, "mcp.json"))).toBe("Bearer amrctx_t1");
			expect(map.get("u_ada@team.example#context")).toBe("amrctx_t1");
			// ... while the access key really did rotate everywhere else.
			const after = parseRemoteRouter(readFileSync(join(rh, "remote.json"), "utf8"))!;
			expect(after.key).toBe("amrt_new");
			expect(after.contextTokenId).toBe("ctx_1");
			expect(readFileSync(join(env.PI_CODING_AGENT_DIR!, "models.yml"), "utf8")).toContain("amrt_new");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a token inside the renewal window is re-minted with the freshly refreshed key and re-filed", async () => {
		const { home, agent, rh, env } = fixture("amr-ctx-renew-");
		const { backend, map } = vault();
		try {
			connected(env, home, backend, Date.now() + 10 * DAY);
			const expiresAtMs = Date.now() + 365 * DAY;
			const { fetchImpl, seen } = teamFetch({ key: "amrt_new", mint: { token: "amrctx_t2", id: "ctx_2", expiresAtMs } });
			const remote = parseRemoteRouter(readFileSync(join(rh, "remote.json"), "utf8"))!;
			await refreshAndRewrite({ remote, fetchImpl, home, packageDir: process.cwd(), env, platform: "darwin", pathHas: () => false, routerHome: rh, storeDeps: { backend } });
			expect(seen.filter((u) => u.endsWith("/me/context-tokens")).length).toBe(1);
			expect(auth(join(agent, "mcp.json"))).toBe("Bearer amrctx_t2");
			expect(map.get("u_ada@team.example#context")).toBe("amrctx_t2");
			const after = parseRemoteRouter(readFileSync(join(rh, "remote.json"), "utf8"))!;
			expect(after).toMatchObject({ contextTokenId: "ctx_2", contextTokenExpiresAtMs: expiresAtMs, contextTokenStore: "keychain" });
			expect(readFileSync(join(rh, "remote.json"), "utf8")).not.toContain("amrctx_t2");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("an older team edition is untouched: no mcpAuth, no mint, and the entry takes the new access key", async () => {
		const { home, agent, rh, env } = fixture("amr-ctx-legacy-");
		const { backend } = vault();
		try {
			// No token at connect time — the team never offered one.
			connectRemote({ url: "https://team.example", key: "amrt_old", userId: "u_ada", name: "Ada", refreshToken: "amrr_r1", keyExpiresAtMs: 1, refreshExpiresAtMs: 2, store: "keychain", storeDeps: { backend }, profile: false, dryRun: false, only: ["omp"], env, home, packageDir: process.cwd(), mcp: { url: "https://team.example/mcp" }, platform: "darwin", pathHas: () => false });
			expect(auth(join(agent, "mcp.json"))).toBe("Bearer amrt_old");
			expect(parseRemoteRouter(readFileSync(join(rh, "remote.json"), "utf8"))!.contextTokenStore).toBeUndefined();
			const seen: string[] = [];
			const fetchImpl = (async (input: string | URL | Request) => {
				const url = String(input);
				seen.push(url);
				if (url.endsWith("/setup/info")) return Response.json({ version: "0.18.0", mcp: true }); // no mcpAuth
				if (url.endsWith("/setup/skills")) return new Response("", { status: 404 });
				return Response.json({ key: "amrt_new", keyExpiresAtMs: 50, refreshToken: "amrr_r2", refreshExpiresAtMs: 90 });
			}) as unknown as typeof fetch;
			const remote = parseRemoteRouter(readFileSync(join(rh, "remote.json"), "utf8"))!;
			await refreshAndRewrite({ remote, fetchImpl, home, packageDir: process.cwd(), env, platform: "darwin", pathHas: () => false, routerHome: rh, storeDeps: { backend } });
			expect(seen.some((u) => u.endsWith("/me/context-tokens"))).toBe(false);
			expect(auth(join(agent, "mcp.json"))).toBe("Bearer amrt_new");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a connect that learns nothing about context tokens keeps what remote.json already recorded", async () => {
		const { home, rh, env } = fixture("amr-ctx-carry-");
		const { backend } = vault();
		try {
			connected(env, home, backend, 4_000);
			// A later connect with no mcp token at all (a /setup/info that did not answer) must not
			// orphan the token the credential store is still holding for another year.
			connectRemote({ url: "https://team.example", key: "amrt_k2", userId: "u_ada", name: "Ada", refreshToken: "amrr_r1", store: "keychain", storeDeps: { backend }, profile: false, dryRun: false, only: ["omp"], env, home, packageDir: process.cwd(), platform: "darwin", pathHas: () => false });
			expect(parseRemoteRouter(readFileSync(join(rh, "remote.json"), "utf8"))!).toMatchObject({ contextTokenStore: "keychain", contextAccount: "u_ada@team.example#context", contextTokenId: "ctx_1" });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
