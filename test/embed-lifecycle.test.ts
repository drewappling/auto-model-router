import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext, ProviderRegistration } from "@oh-my-pi/pi-coding-agent";

/**
 * How the embedded router must behave, pinned against the two failures that
 * produced "provider error: Unable to connect" on every real turn while utility
 * calls kept working.
 *
 * 1. THE PORT COMES FROM THIS PROCESS, NOT FROM A FILE. omp resolves
 *    `modelRoles.default` from models.yml during STARTUP — before this extension
 *    loads — and that handle is a snapshot no later registerProvider can
 *    rewrite. So the extension must not persist its ephemeral port into
 *    models.yml (a dead port then becomes authoritative for the NEXT session),
 *    and when a block already exists it adopts the port that block names so the
 *    handle omp built is valid. Measured in the field:
 *      embed ready pid=61872 port=54985 models.yml-advertised=50596
 *
 * 2. THE ROUTER'S LIFETIME IS THE PROCESS. omp emits `session_shutdown` from
 *    session disposal, which includes its provider-refresh / extension-reload
 *    path running in a throwaway host while the real session continues. This
 *    module is cached per process, so a teardown there stopped the LIVE router.
 *
 * One boot shared by every test, deliberately: the module is cached per process
 * in production too, so this is the real shape.
 */

const registrations: { id: string; baseUrl: string }[] = [];
const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => void | Promise<void>)[]>();

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

/** Health-probes the router: asserts the socket's state, never used as a wait. */
async function alive(port: number): Promise<boolean> {
	try {
		const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
		return res.ok;
	} catch {
		return false;
	}
}

const portOfLatestRegistration = (): number =>
	Number.parseInt(/:(\d+)\//.exec(registrations.at(-1)?.baseUrl ?? "")?.[1] ?? "0", 10);

let home = "";
let modelsYmlPath = "";
let advertised = 0;
let modelsYmlBefore = "";

beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "embed-life-"));
	const agentDir = join(home, "agent");
	mkdirSync(agentDir, { recursive: true });
	modelsYmlPath = join(agentDir, "models.yml");

	// A port nothing listens on — the shape a restart leaves behind, since
	// models.yml names the session the user just closed.
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
	advertised = probe.port as number;
	probe.stop(true);

	writeFileSync(
		modelsYmlPath,
		`providers:
    # BEGIN auto-model-router
    auto-model-router:
      baseUrl: http://127.0.0.1:${advertised}/v1
      api: openai-completions
      auth: none
      models:
        - id: auto
          name: Auto (auto-model-router)
    # END auto-model-router
`,
		"utf8",
	);
	modelsYmlBefore = readFileSync(modelsYmlPath, "utf8");

	process.env.AUTO_MODEL_ROUTER_HOME = home;
	process.env.AUTO_MODEL_ROUTER_DB = join(home, "router.db");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.AUTO_MODEL_ROUTER_PORT;

	const mod = (await import("../omp-extension/router-embed.ts")) as { default: (api: ExtensionAPI) => void };
	mod.default(pi);
	await fire("session_start", "session-one");
});

afterAll(async () => {
	// Release the socket the way the extension intends: on a process signal.
	process.emit("SIGTERM");
	// Poll the real condition instead of guessing a duration; each probe yields.
	for (let i = 0; i < 50 && (await alive(portOfLatestRegistration())); i++) {
		/* keep probing until the socket stops answering */
	}
	delete process.env.PI_CODING_AGENT_DIR;
	try {
		rmSync(home, { recursive: true, force: true });
	} catch {
		/* SQLite may still hold the file on Windows; the temp dir is disposable */
	}
});

describe("embedded router: port selection", () => {
	test("adopts the port models.yml advertises, so omp's pre-resolved handle is valid", () => {
		expect(portOfLatestRegistration()).toBe(advertised);
	});

	test("the adopted port actually serves", async () => {
		expect(await alive(advertised)).toBe(true);
	});

	test("does NOT write its port into models.yml", () => {
		// Persisting an ephemeral port makes it authoritative for the NEXT
		// session's startup resolution, which is where the dead handle came from.
		expect(readFileSync(modelsYmlPath, "utf8")).toBe(modelsYmlBefore);
	});

	test("publishes the port for subagents and the toast", () => {
		const portFile = join(home, "embed.port");
		expect(existsSync(portFile)).toBe(true);
		expect(readFileSync(portFile, "utf8").trim()).toBe(String(advertised));
	});
});

describe("embedded router: lifetime", () => {
	test("registers NO session_shutdown teardown", () => {
		// omp fires that from a throwaway host during provider refresh, so a
		// teardown there kills a router the live session is still using.
		expect(handlers.get("session_shutdown") ?? []).toHaveLength(0);
	});

	test("a session_shutdown leaves the router running", async () => {
		await fire("session_shutdown", "session-one");
		expect(await alive(advertised)).toBe(true);
	});

	test("a second session reuses the same port instead of rebinding", async () => {
		// Rebinding would take a different port and orphan every handle omp had
		// already resolved against the first one.
		await fire("session_start", "session-two");
		expect(portOfLatestRegistration()).toBe(advertised);
		expect(await alive(advertised)).toBe(true);
	});

	test("each session still gets its own registration, so per-session tagging survives reuse", () => {
		expect(registrations.length).toBeGreaterThanOrEqual(2);
	});
});
