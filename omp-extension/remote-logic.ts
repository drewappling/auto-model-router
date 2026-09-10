/**
 * Remote-router mode for the omp extensions. `auto-model-router connect`
 * writes `<router home>/remote.json`; when it exists the embed extension
 * registers the REMOTE router as omp's provider instead of binding a local
 * one, and the toast, hub and digest extensions talk to it with the key.
 * Nothing is classified or selected locally: the remote router is the router.
 * A shared router on a LAN and the team edition are both remotes.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REMOTE_FILE = "remote.json";
/** The name the first release used; still read so nothing breaks on upgrade. */
const LEGACY_FILE = "team.json";

export interface RemoteRouter {
	/** The remote router, no trailing slash, e.g. https://router.example.com */
	url: string;
	/** The key that router expects (`server.apiKey`, or a team user key). */
	key: string;
	userId: string;
	name: string;
	joinedAtMs: number;
	/**
	 * Present only in a remote.json written before the credential store existed:
	 * the token inline. New files name the store instead (`refreshTokenStore`) and
	 * the token is read from it when a refresh happens (src/cli/refresh.ts).
	 */
	refreshToken?: string;
	/** Which OS store holds the refresh token: dpapi (Windows), keychain (macOS), secret-service (Linux) or file. */
	refreshTokenStore?: "dpapi" | "keychain" | "secret-service" | "file";
	/** The account the store files it under (`<userId>@<remote host>`). */
	refreshAccount?: string;
	keyExpiresAtMs?: number;
	refreshExpiresAtMs?: number;
	/** What the remote calls this machine. */
	device?: string;
	/**
	 * The compiled executable that ran `connect`, when one did. A refresh from
	 * inside omp re-writes every harness config and must point Claude Code's key
	 * helper at it, not at a `bun run` of the extracted source.
	 */
	executable?: string;
}

export function remoteFilePath(routerHome: string): string {
	return join(routerHome, REMOTE_FILE);
}

/** Parses remote.json defensively; anything malformed ⇒ not in remote mode. */
export function parseRemoteRouter(text: string): RemoteRouter | null {
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (typeof raw.url !== "string" || typeof raw.key !== "string" || raw.url === "" || raw.key === "") return null;
		return {
			url: raw.url.replace(/\/+$/, ""),
			key: raw.key,
			userId: typeof raw.userId === "string" ? raw.userId : "",
			name: typeof raw.name === "string" ? raw.name : "",
			joinedAtMs: typeof raw.joinedAtMs === "number" ? raw.joinedAtMs : 0,
			...(typeof raw.refreshToken === "string" && raw.refreshToken !== "" ? { refreshToken: raw.refreshToken } : {}),
			...(raw.refreshTokenStore === "dpapi" || raw.refreshTokenStore === "keychain" || raw.refreshTokenStore === "secret-service" || raw.refreshTokenStore === "file" ? { refreshTokenStore: raw.refreshTokenStore } : {}),
			...(typeof raw.refreshAccount === "string" && raw.refreshAccount !== "" ? { refreshAccount: raw.refreshAccount } : {}),
			...(typeof raw.keyExpiresAtMs === "number" ? { keyExpiresAtMs: raw.keyExpiresAtMs } : {}),
			...(typeof raw.refreshExpiresAtMs === "number" ? { refreshExpiresAtMs: raw.refreshExpiresAtMs } : {}),
			...(typeof raw.device === "string" && raw.device !== "" ? { device: raw.device } : {}),
			...(typeof raw.executable === "string" && raw.executable !== "" ? { executable: raw.executable } : {}),
		};
	} catch {
		return null;
	}
}

/** True when this machine can trade for a new key: a refresh token inline, or a store that holds one. */
export function hasRefresh(remote: RemoteRouter): boolean {
	return (remote.refreshToken !== undefined && remote.refreshToken !== "") || remote.refreshTokenStore !== undefined;
}

/** The account a remote user's refresh token is filed under in the OS store. */
export function refreshAccountOf(url: string, userId: string): string {
	let host = url;
	try {
		host = new URL(url).host;
	} catch {
		/* keep the raw url */
	}
	return `${userId === "" ? "member" : userId}@${host}`;
}

export function readRemoteRouter(routerHome: string): RemoteRouter | null {
	for (const path of [remoteFilePath(routerHome), join(routerHome, LEGACY_FILE)]) {
		if (!existsSync(path)) continue;
		try {
			return parseRemoteRouter(readFileSync(path, "utf8"));
		} catch {
			return null;
		}
	}
	return null;
}

/** The virtual models a remote router serves; costs are the fallback blend so omp can show estimates. */
export const REMOTE_MODELS: readonly { id: string; name: string }[] = [
	{ id: "auto", name: "auto (remote)" },
	{ id: "auto-cheap", name: "auto-cheap (remote)" },
	{ id: "auto-max", name: "auto-max (remote)" },
];

/**
 * omp's provider registration for remote mode: the remote's /v1 with the key,
 * the session and subagent tags, and the virtual models. Costs are USD per
 * million tokens, like the embedded config.
 */
export function remoteProviderRegistration(remote: RemoteRouter, sessionId: string, subagent: boolean, blend: { inputPerMtok: number; outputPerMtok: number }, agentdoxScope = "", agentdoxOrigin = ""): {
	baseUrl: string;
	api: string;
	apiKey: string;
	headers: Record<string, string>;
	models: { id: string; name: string; api: string; reasoning: boolean; input: string[]; contextWindow: number; maxTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }[];
} {
	const headers: Record<string, string> = {};
	if (sessionId !== "") headers["X-Omp-Session"] = sessionId;
	if (subagent) headers["X-Omp-Subagent"] = "1";
	// Which project's shared context this workspace draws on. The bridge lives on the remote
	// router, so this is sent whatever the local config says; the remote decides what to do with
	// it (a team that pins a scope for the group overrides it, and one that pins none follows it).
	if (agentdoxScope !== "") headers["X-Agentdox-Scope"] = agentdoxScope;
	// The repository behind that folder: the same value from every clone, so a remote with a
	// project registry finds the project when two folders share a name or one repo has two.
	if (agentdoxOrigin !== "") headers["X-Agentdox-Origin"] = agentdoxOrigin;
	const round = (v: number): number => Math.round(v * 1e4) / 1e4;
	return {
		baseUrl: `${remote.url}/v1`,
		api: "openai-completions",
		apiKey: remote.key,
		headers,
		models: REMOTE_MODELS.map((m) => ({
			id: m.id,
			name: m.name,
			api: "openai-completions",
			reasoning: false,
			input: ["text", "image"],
			contextWindow: 200_000,
			maxTokens: 32_000,
			cost: { input: round(blend.inputPerMtok), output: round(blend.outputPerMtok), cacheRead: round(blend.inputPerMtok * 0.1), cacheWrite: round(blend.inputPerMtok * 1.25) },
		})),
	};
}
