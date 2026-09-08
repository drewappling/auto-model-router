import { describe, expect, test } from "bun:test";
import { applyConfigPatch, assignInPlace, touched } from "../src/config/apply.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { startServer } from "../src/server/http.ts";

/**
 * Live reconfiguration: a running router follows a config change without a
 * restart. The socket stays bound, turns in flight are untouched, and the
 * pieces that used to be captured at construction (upstream clients, the
 * catalogs, the agentdox bridge) are re-pointed instead.
 */

describe("applying config in place", () => {
	test("blocks keep their identity, only leaves change, and the changed paths come back dotted", () => {
		const cfg = structuredClone(DEFAULT_CONFIG);
		const ollamaRef = cfg.ollama; // what a client binds at construction
		const changed = applyConfigPatch(cfg, { ollama: { enabled: true, apiKey: "k" } });
		expect(changed.sort()).toEqual(["ollama.apiKey", "ollama.enabled"]);
		expect(cfg.ollama).toBe(ollamaRef); // the holder sees the new values
		expect(ollamaRef.apiKey).toBe("k");
		// An unchanged value is not reported, so nothing rebuilds for nothing.
		expect(applyConfigPatch(cfg, { ollama: { apiKey: "k" } })).toEqual([]);
	});

	test("a patch touches only what it names; a full apply prunes what the source dropped", () => {
		const target: Record<string, unknown> = { a: { x: 1, y: 2 }, b: 3 };
		expect(assignInPlace(target, { a: { x: 9 } })).toEqual(["a.x"]);
		expect(target).toEqual({ a: { x: 9, y: 2 }, b: 3 });
		expect(assignInPlace(target, { a: { x: 9 } }, "", { prune: true }).sort()).toEqual(["a.y", "b"]);
		expect(target).toEqual({ a: { x: 9 } });
	});

	test("a patch cannot alias live config", () => {
		const cfg = structuredClone(DEFAULT_CONFIG);
		const patch = { filters: { allow: ["a/b"] } };
		applyConfigPatch(cfg, patch);
		patch.filters.allow.push("c/d");
		expect(cfg.filters.allow).toEqual(["a/b"]);
	});

	test("touched matches a block and its keys", () => {
		expect(touched(["ollama.apiKey"], "ollama")).toBe(true);
		expect(touched(["context"], "context")).toBe(true);
		expect(touched(["filters.allow"], "openrouter", "ollama")).toBe(false);
	});
});

describe("a running server reconfigures", () => {
	const base = (): RouterConfig => ({
		...structuredClone(DEFAULT_CONFIG),
		server: { ...DEFAULT_CONFIG.server, host: "127.0.0.1", port: 0, apiKey: "rk" },
		ledger: { ...DEFAULT_CONFIG.ledger, path: ":memory:" },
		// No network at boot: an empty key keeps the catalog fetch keyless and cheap,
		// and this test never dispatches a turn.
		openrouter: { ...DEFAULT_CONFIG.openrouter, apiKey: "" },
	});

	test("provider keys, Ollama and the agentdox bridge all change while the socket stays bound", async () => {
		const cfg = base();
		const started = startServer(cfg);
		const port = started.server.port;
		const H = { authorization: "Bearer rk" };
		try {
			const health1 = (await (await fetch(`http://127.0.0.1:${port}/health`, { headers: H })).json()) as { apiKeyConfigured: boolean; serving: string[]; agentdox: unknown; ollama: unknown };
			expect(health1.apiKeyConfigured).toBe(false);
			expect(health1.serving).toEqual([]);
			expect(health1.agentdox).toBeNull();
			expect(health1.ollama).toBeNull();

			// One call turns on both upstreams and the bridge.
			const r = await started.reconfigure({
				openrouter: { apiKey: "sk-or-live" },
				ollama: { enabled: true, apiKey: "ol-live", baseUrl: "https://ollama.com/v1" },
				context: { enabled: true, baseUrl: "http://127.0.0.1:1/never", token: "t", defaultScope: "demo" },
			});
			expect(r.rejected).toEqual([]);
			expect(r.catalogRefreshing).toBe(true); // started in the background, not awaited
			expect(r.changed).toContain("openrouter.apiKey");
			expect(r.changed).toContain("ollama.enabled");
			expect(r.changed).toContain("context.enabled");
			expect(cfg.openrouter.apiKey).toBe("sk-or-live");

			const health2 = (await (await fetch(`http://127.0.0.1:${port}/health`, { headers: H })).json()) as { apiKeyConfigured: boolean; serving: string[]; agentdox: { url: string; defaultScope: string } | null; ollama: { baseUrl: string } | null };
			expect(started.server.port).toBe(port); // same socket, never rebound
			expect(health2.apiKeyConfigured).toBe(true);
			expect(health2.serving).toContain("openrouter");
			expect(health2.serving).toContain("ollama");
			expect(health2.agentdox).toMatchObject({ url: "http://127.0.0.1:1/never", defaultScope: "demo" });
			expect(health2.ollama).toMatchObject({ baseUrl: "https://ollama.com/v1" });

			// And back off again: the bridge goes inert and Ollama stops serving.
			const off = await started.reconfigure({ ollama: { enabled: false }, context: { enabled: false } });
			expect(off.changed.sort()).toEqual(["context.enabled", "ollama.enabled"]);
			const health3 = (await (await fetch(`http://127.0.0.1:${port}/health`, { headers: H })).json()) as { serving: string[]; agentdox: unknown; ollama: unknown };
			expect(health3.serving).toEqual(["openrouter"]);
			expect(health3.agentdox).toBeNull();
			expect(health3.ollama).toBeNull();
		} finally {
			await started.stop();
		}
	});

	test("the socket and the ledger file are refused rather than half-applied", async () => {
		const cfg = base();
		const started = startServer(cfg);
		const port = started.server.port;
		try {
			const r = await started.reconfigure({ server: { port: 1 }, ledger: { path: "/tmp/other.db", retentionDays: 9 }, filters: { latencyWeight: 0.42 } });
			expect(r.rejected.sort()).toEqual(["ledger.path", "server"]);
			expect(cfg.server.port).toBe(0);
			expect(cfg.ledger.path).toBe(":memory:");
			expect(started.server.port).toBe(port);
			// Everything else in the same call still applied.
			expect(cfg.filters.latencyWeight).toBe(0.42);
			expect(cfg.ledger.retentionDays).toBe(9);
			expect(r.changed).toContain("filters.latencyWeight");
		} finally {
			await started.stop();
		}
	});
});
