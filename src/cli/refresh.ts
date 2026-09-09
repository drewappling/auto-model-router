/**
 * Short-lived remote credentials.
 *
 * A remote router (the team edition) may hand a machine an access key that
 * expires plus a refresh token that trades for the next one. `remote.json`
 * carries all of it; `auto-model-router refresh` trades early and re-writes
 * every harness config `connect` wrote, and `auto-model-router token` prints a
 * key that is good right now (refreshing first when needed), which is what a
 * harness that can run a command for its key — Claude Code's `apiKeyHelper` —
 * wants. The omp extension refreshes on its own at session start.
 *
 * A refresh a day early costs nothing: the remote keeps the old key valid until
 * its own expiry, so a session still holding it is never cut.
 */

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRemoteRouter, type RemoteRouter } from "../../omp-extension/remote-logic.ts";
import { routerHome } from "../../omp-extension/router-url.ts";
import type { CliArgs } from "./args.ts";
import { connectRemote } from "./connect.ts";

/** How close to expiry a key is refreshed. Wide, so a machine used once a day never sees a dead key. */
export const REFRESH_AHEAD_MS = 24 * 3_600_000;

export interface RefreshedCredential {
	key: string;
	keyExpiresAtMs: number;
	refreshToken: string;
	refreshExpiresAtMs: number;
	device?: string;
}

/** True when the credential can and should be traded now: it has a refresh token and its key is near or past expiry. */
export function shouldRefresh(remote: RemoteRouter, nowMs = Date.now()): boolean {
	if (remote.refreshToken === undefined || remote.refreshToken === "") return false;
	if (remote.keyExpiresAtMs === undefined) return false;
	return remote.keyExpiresAtMs - nowMs <= REFRESH_AHEAD_MS;
}

export class RefreshError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RefreshError";
	}
}

/** Trades the refresh token at the remote for the next credential. */
export async function refreshCredential(remote: RemoteRouter, fetchImpl: typeof fetch = fetch): Promise<RefreshedCredential> {
	if (remote.refreshToken === undefined || remote.refreshToken === "") throw new RefreshError("no_refresh_token", "this machine holds no refresh token; onboard it again with a setup token");
	const res = await fetchImpl(`${remote.url}/auth/refresh`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ refreshToken: remote.refreshToken }),
		signal: AbortSignal.timeout(15_000),
	});
	const body = (await res.json().catch(() => null)) as { key?: unknown; keyExpiresAtMs?: unknown; refreshToken?: unknown; refreshExpiresAtMs?: unknown; device?: unknown; error?: { code?: string; message?: string } } | null;
	if (!res.ok || body === null || typeof body.key !== "string" || typeof body.refreshToken !== "string") {
		throw new RefreshError(body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? `the remote answered ${res.status} to the refresh`);
	}
	return {
		key: body.key,
		keyExpiresAtMs: typeof body.keyExpiresAtMs === "number" ? body.keyExpiresAtMs : Date.now(),
		refreshToken: body.refreshToken,
		refreshExpiresAtMs: typeof body.refreshExpiresAtMs === "number" ? body.refreshExpiresAtMs : Date.now(),
		...(typeof body.device === "string" ? { device: body.device } : {}),
	};
}

/**
 * Refreshes and re-writes every place the key lives: remote.json and the
 * harness configs `connect` manages. Returns the fresh credential. `home` and
 * `packageDir` are injectable for tests.
 */
export async function refreshAndRewrite(opts: { remote: RemoteRouter; fetchImpl?: typeof fetch; home?: string; packageDir?: string; env?: Record<string, string | undefined>; platform?: string; pathHas?: (bin: string) => boolean }): Promise<RefreshedCredential> {
	const fresh = await refreshCredential(opts.remote, opts.fetchImpl ?? fetch);
	const home = opts.home ?? (process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : homedir());
	const packageDir = opts.packageDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	connectRemote({
		url: opts.remote.url,
		key: fresh.key,
		userId: opts.remote.userId,
		name: opts.remote.name,
		refreshToken: fresh.refreshToken,
		keyExpiresAtMs: fresh.keyExpiresAtMs,
		refreshExpiresAtMs: fresh.refreshExpiresAtMs,
		device: fresh.device ?? opts.remote.device ?? "",
		profile: false,
		dryRun: false,
		only: [],
		env: opts.env ?? process.env,
		home,
		packageDir,
		platform: opts.platform ?? process.platform,
		pathHas: opts.pathHas ?? ((bin) => Bun.which(bin) !== null),
		// undefined keeps whatever scope the managed models.yml block already carries.
	});
	return fresh;
}

/** `auto-model-router refresh [--force]` */
export async function refreshCommand(args: CliArgs): Promise<void> {
	const remote = readRemoteRouter(routerHome());
	if (remote === null) throw new Error(`no remote router configured (${routerHome()}/remote.json); run connect first`);
	if (!args.flags.has("force") && !shouldRefresh(remote)) {
		const left = remote.keyExpiresAtMs === undefined ? "no expiry" : `${Math.max(0, Math.round((remote.keyExpiresAtMs - Date.now()) / 3_600_000))}h left`;
		console.log(`the access key does not need refreshing yet (${left}); --force refreshes anyway`);
		return;
	}
	const fresh = await refreshAndRewrite({ remote });
	console.log(`refreshed: the new access key lasts until ${new Date(fresh.keyExpiresAtMs).toISOString()}; every harness config was re-written`);
}

/**
 * `auto-model-router token`: a key that is good right now, on stdout and
 * nothing else — the shape a harness's key-helper command expects. Refreshes
 * first when the key is near expiry.
 */
export async function tokenCommand(args: CliArgs): Promise<void> {
	const remote = readRemoteRouter(routerHome());
	if (remote === null) throw new Error(`no remote router configured (${routerHome()}/remote.json); run connect first`);
	if (!args.flags.has("no-refresh") && shouldRefresh(remote)) {
		try {
			const fresh = await refreshAndRewrite({ remote });
			process.stdout.write(`${fresh.key}\n`);
			return;
		} catch (err) {
			// A key that is still valid beats no key: fall through and print what we hold.
			if (remote.keyExpiresAtMs !== undefined && remote.keyExpiresAtMs <= Date.now()) throw err;
			console.error(`warning: refresh failed (${err instanceof Error ? err.message : String(err)}); printing the current key`);
		}
	}
	process.stdout.write(`${remote.key}\n`);
}

