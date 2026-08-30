/**
 * Verifies the embed port contract that omp's model resolution depends on.
 *
 * omp resolves `modelRoles.default` from `models.yml` during startup — BEFORE
 * extensions load, so before the router can bind and rewrite that file. With an
 * ephemeral port the block therefore names the PREVIOUS session's port, which
 * is dead once that session exits: every main-agent turn fails with "Unable to
 * connect" while utility calls (resolved later, from the live registration)
 * still work. This asserts the properties that make that impossible:
 *
 *  1. The bind port is deterministic across restarts (configured port wins).
 *  2. A second session finds the first one healthy, so it can REUSE it.
 *  3. A port held by something that is not our router is not mistaken for one,
 *     and binding falls back instead of leaving the session with no provider.
 *
 * Run: bun tools/verify-embed-port.ts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { probeEmbed, resolveEmbedPort } from "../omp-extension/embed-logic.ts";
import { loadConfig } from "../src/config/load.ts";
import { startServer, type StartedServer } from "../src/server/http.ts";
import type { RouterConfig } from "../src/config/types.ts";

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok || detail === undefined ? "" : `\n        ${JSON.stringify(detail)}`}`);
	if (!ok) failures++;
};

const home = mkdtempSync(join(tmpdir(), "verify-embed-port-"));
function baseCfg(): RouterConfig {
	const cfg = loadConfig({ overrides: { server: { host: "127.0.0.1" } } });
	cfg.ledger.path = join(home, "router.db");
	cfg.logLevel = "error";
	cfg.benchmarks.enabled = false;
	cfg.context.enabled = false;
	return cfg;
}

// 1. Determinism: two independent startups must choose the same port.
const cfg1 = baseCfg();
const configured = cfg1.server.port;
const portA = resolveEmbedPort(undefined, configured);
const portB = resolveEmbedPort(undefined, baseCfg().server.port);
check("bind port is deterministic across restarts", portA === portB && portA !== 0, { portA, portB });
check("deterministic port comes from config.yml server.port", portA === configured, { portA, configured });
check("an explicit env port still wins", resolveEmbedPort("8812", configured) === 8812);
check("an explicit env 0 still requests an ephemeral port", resolveEmbedPort("0", configured) === 0);

// 2. First session binds it; a second must see it healthy (=> reuse, no bind war).
//    Uses a DISCOVERED free port, not the machine's configured one: a real
//    router may already be serving 8788 here, and this check must be hermetic.
const scout = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("scout") });
const freePort = scout.port as number;
scout.stop(true);
cfg1.server.port = freePort;

let first: StartedServer | null = null;
try {
	first = startServer(cfg1);
} catch (err) {
	check("first session can bind its chosen port", false, String(err));
}

if (first !== null) {
	check("first session bound the port it asked for", first.server.port === freePort, { bound: first.server.port, wanted: freePort });
	check("router answers /health there (so a peer session reuses it)", await probeEmbed(freePort), { port: freePort });

	// 3. A non-router occupant must not be mistaken for our router.
	const squatter = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("not a router", { status: 404 }) });
	const squatted = squatter.port as number;
	check("a non-router occupant fails the health probe", (await probeEmbed(squatted)) === false, { port: squatted });

	// ...and binding over it must still leave the session with a usable router.
	const cfgFallback = baseCfg();
	cfgFallback.server.port = squatted;
	let fell: StartedServer | null = null;
	try {
		fell = startServer(cfgFallback);
		check("bind on an occupied port yields a different, usable port", fell.server.port !== squatted, { got: fell.server.port });
	} catch {
		cfgFallback.server.port = 0;
		fell = startServer(cfgFallback);
		check("falls back to an ephemeral port when the desired one is taken", fell.server.port !== undefined && fell.server.port !== squatted, {
			got: fell.server.port,
		});
	}
	if (fell !== null) await fell.stop();
	squatter.stop(true);
	await first.stop();
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
