import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext, ProviderRegistration } from "@oh-my-pi/pi-coding-agent";

/**
 * The embedded router's lifetime is the PROCESS, not a session.
 *
 * omp emits `session_shutdown` from session DISPOSAL, and disposal includes its
 * provider-refresh / extension-reload path — which runs in a throwaway
 * extension host while the real session keeps going. This module is cached per
 * process, so tearing the router down in that handler stopped the LIVE router.
 * Every later turn then failed with Bun's "Unable to connect", while utility
 * calls resolved after a subsequent rebind still worked: exactly the asymmetry
 * seen in the field, where only `toolCount: 0` dispatches reached the ledger and
 * the port named in `embed.port` answered nothing.
 *
 * One boot shared by every test here, deliberately: the extension module is
 * cached per process in production too, so this is the real shape.
 */

const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => void | Promise<void>)[]>();
const registrations: { id: string; baseUrl: string }[] = [];

const pi: ExtensionAPI = {
	setLabel: () => {},
	on: (event, handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerProvider: (id: string, registration: ProviderRegistration) => {
		registrations.push({ id, baseUrl: registration.baseUrl });
	},
	unregisterProvider: () => {},
	registerCommand: () => {},
};

async function fire(event: string, sessionId: string): Promise<void> {
	const ctx = { hasUI: true, sessionManager: { getSessionId: () => sessionId } } as ExtensionContext;
	for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
}

/** Health-probes the router; used to assert the socket's state, not to wait. */
async function alive(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
		return res.ok;
	} catch {
		return false;
	}
}

let home = "";
let port = 0;

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "embed-life-"));
	process.env.AUTO_MODEL_ROUTER_HOME = home;
	process.env.AUTO_MODEL_ROUTER_DB = join(home, "router.db");
	const mod = (await import("../omp-extension/router-embed.ts")) as { default: (api: ExtensionAPI) => void };
	mod.default(pi);
	await fire("session_start", "session-one");
	port = Number.parseInt(/:(\d+)\//.exec(registrations.at(-1)?.baseUrl ?? "")?.[1] ?? "0", 10);
});

afterAll(async () => {
	// Release the socket the way the extension intends: on process signals.
	process.emit("SIGTERM");
	// Poll the real condition rather than guessing a duration; each fetch
	// attempt yields, so this settles as soon as the socket is actually closed.
	for (let i = 0; i < 50 && (await alive(port)); i++) {
		/* keep probing until the port stops answering */
	}
	// A still-open SQLite handle can hold the file on Windows; the temp dir is
	// disposable either way.
	try {
		rmSync(home, { recursive: true, force: true });
	} catch {
		/* leave it to the OS temp reaper */
	}
});

describe("embedded router lifetime", () => {
	test("binds a router and registers it for the session", () => {
		expect(port).toBeGreaterThan(0);
		expect(registrations.at(-1)?.id).toBe("auto-model-router");
	});

	test("the router answers on the port it registered", async () => {
		expect(await alive(port)).toBe(true);
	});

	test("registers NO session_shutdown teardown", () => {
		// omp fires this from a throwaway host during provider refresh, so a
		// teardown here kills a router the live session is still using.
		expect(handlers.get("session_shutdown") ?? []).toHaveLength(0);
	});

	test("a session_shutdown leaves the router running", async () => {
		await fire("session_shutdown", "session-one");
		expect(await alive(port)).toBe(true);
	});

	test("a second session reuses the same port instead of rebinding", async () => {
		// Rebinding would take a different port and orphan every model handle omp
		// had already resolved against the first one.
		await fire("session_start", "session-two");
		const latest = Number.parseInt(/:(\d+)\//.exec(registrations.at(-1)?.baseUrl ?? "")?.[1] ?? "0", 10);
		expect(latest).toBe(port);
		expect(await alive(port)).toBe(true);
	});

	test("each session still gets its own registration, so per-session tagging survives reuse", () => {
		expect(registrations.length).toBeGreaterThanOrEqual(2);
	});
});
