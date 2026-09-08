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
}

export function remoteFilePath(routerHome: string): string {
	return join(routerHome, REMOTE_FILE);
}

/** Parses remote.json defensively; anything malformed ⇒ not in remote mode. */
export function parseRemoteRouter(text: string): RemoteRouter | null {
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (typeof raw.url !== "string" || typeof raw.key !== "string" || raw.url === "" || raw.key === "") return null;
		return { url: raw.url.replace(/\/+$/, ""), key: raw.key, userId: typeof raw.userId === "string" ? raw.userId : "", name: typeof raw.name === "string" ? raw.name : "", joinedAtMs: typeof raw.joinedAtMs === "number" ? raw.joinedAtMs : 0 };
	} catch {
		return null;
	}
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
export function remoteProviderRegistration(remote: RemoteRouter, sessionId: string, subagent: boolean, blend: { inputPerMtok: number; outputPerMtok: number }, agentdoxScope = ""): {
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
