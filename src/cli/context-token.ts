/**
 * The team edition's **context token** — the credential the `team-context` MCP
 * server holds.
 *
 * An MCP client substitutes its configuration ONCE, at startup. A member access
 * key is short-lived (the team edition rotates it roughly every 72 hours), so a
 * `team-context` entry carrying the access key dies mid-session every few days
 * with a 401 that reads to the member as "re-authorise". The team edition
 * therefore mints a second credential, `amrctx_…`, that lasts a year and can do
 * exactly one thing: read and write that member's shared project context. It is
 * refused on turns, on the admin API, on the portal and on SCIM.
 *
 * This module is the router's side of that:
 *
 *   - `/setup/info` says `mcpAuth: "context-token"` when the team mints them.
 *     A team edition that predates them says `"member-key"` or nothing at all,
 *     and then everything below is skipped and the MCP entry keeps the access
 *     key exactly as before.
 *   - `/setup/exchange` hands one over beside the credential, so onboarding
 *     costs no extra round trip.
 *   - `POST /me/context-tokens {name}` mints one with the member key, for the
 *     paths that have no exchange: `connect --key`, and a refresh whose token
 *     is missing or close to expiry. The team binds it to the CALLING device,
 *     so revoking the machine revokes the token with it.
 *
 * The token is a long-lived secret and goes where the refresh token goes: the
 * OS credential store, in its own slot (see credential-store.ts). remote.json
 * records only which store holds it, its expiry and its id.
 */

import { contextAccountOf, loadContextToken, type StoreDeps } from "./credential-store.ts";
import { refreshAccountOf, type RemoteRouter } from "../../omp-extension/remote-logic.ts";

/** What `/setup/info` says belongs in the MCP entry. Absent ⇒ `member-key`: an older team edition is unaffected. */
export type McpAuth = "context-token" | "member-key";

/** A context token and what is known about it. */
export interface ContextToken {
	value: string;
	expiresAtMs?: number;
	id?: string;
}

/**
 * How close to expiry a context token is renewed. A year long and renewed with
 * a month to spare: a machine that connects once a month never carries a dead
 * one, and a machine used daily still renews only twelve times a year.
 */
export const CONTEXT_TOKEN_RENEW_AHEAD_MS = 30 * 24 * 3_600_000;

/** The token this machine already holds, read out of the store remote.json names. */
export function storedContextToken(remote: RemoteRouter, routerHome: string, storeDeps: StoreDeps = {}): ContextToken | null {
	if (remote.contextTokenStore === undefined) return null;
	const account = remote.contextAccount ?? contextAccountOf(remote.refreshAccount ?? refreshAccountOf(remote.url, remote.userId));
	const value = loadContextToken(routerHome, account, remote.contextTokenStore, storeDeps);
	if (value === null || value === "") return null;
	return {
		value,
		...(remote.contextTokenExpiresAtMs === undefined ? {} : { expiresAtMs: remote.contextTokenExpiresAtMs }),
		...(remote.contextTokenId === undefined ? {} : { id: remote.contextTokenId }),
	};
}

/** True when a held token should be replaced: no expiry recorded, or inside the renewal window. */
export function dueForRenewal(token: ContextToken | null, nowMs = Date.now()): boolean {
	if (token === null || token.value === "") return true;
	// An expiry we never learned is an expiry we cannot trust; minting records one, so this converges.
	if (token.expiresAtMs === undefined) return true;
	return token.expiresAtMs - nowMs <= CONTEXT_TOKEN_RENEW_AHEAD_MS;
}

/**
 * Mints one with the member key. Returns null on anything unexpected — an older
 * team edition answers 404, a deployment that does not issue them answers 503 —
 * and the caller then falls back to what it holds, or to the access key.
 */
export async function mintContextToken(url: string, key: string, name: string, fetchImpl: typeof fetch = fetch): Promise<ContextToken | null> {
	try {
		const res = await fetchImpl(`${url}/me/context-tokens`, {
			method: "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			body: JSON.stringify({ name }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) return null;
		const body = (await res.json().catch(() => null)) as { token?: unknown; id?: unknown; expiresAtMs?: unknown } | null;
		if (body === null || typeof body.token !== "string" || body.token === "") return null;
		return {
			value: body.token,
			...(typeof body.expiresAtMs === "number" ? { expiresAtMs: body.expiresAtMs } : {}),
			...(typeof body.id === "string" && body.id !== "" ? { id: body.id } : {}),
		};
	} catch {
		return null;
	}
}

export interface EnsureContextTokenOptions {
	url: string;
	/** A member key good right now: the one just issued, or just refreshed. */
	key: string;
	mcpAuth: McpAuth;
	routerHome: string;
	/** What this machine already recorded, when it has connected before. */
	remote?: RemoteRouter | null;
	/** One the setup exchange just handed over; it wins, and nothing is minted. */
	issued?: ContextToken | undefined;
	/** What the team should call it — the device name, so the member recognises it in the portal. */
	name: string;
	/** False on a dry run: report what is held, but never mint — a rehearsal must not leave a credential behind at the team. */
	mint?: boolean;
	fetchImpl?: typeof fetch;
	storeDeps?: StoreDeps;
	nowMs?: number;
}

/**
 * The token the MCP entry should carry, or null to keep using the access key.
 *
 * Never mints when one that is held is still far from expiry: that is the whole
 * point — a refresh every three days must leave the MCP configuration alone.
 */
export async function ensureContextToken(o: EnsureContextTokenOptions): Promise<ContextToken | null> {
	if (o.mcpAuth !== "context-token") return null;
	if (o.issued !== undefined && o.issued.value !== "") return o.issued;
	const held = o.remote === undefined || o.remote === null ? null : storedContextToken(o.remote, o.routerHome, o.storeDeps ?? {});
	if (!dueForRenewal(held, o.nowMs ?? Date.now())) return held;
	if (o.mint === false) return held;
	const minted = await mintContextToken(o.url, o.key, o.name, o.fetchImpl ?? fetch);
	// A mint that fails leaves what we hold in place: a token good for another day
	// beats none, and none beats breaking a member's context tools over a hiccup.
	return minted ?? held;
}
