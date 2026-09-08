/**
 * Team client mode for the omp extensions. `auto-model-router join` writes
 * `<router home>/team.json`; when it exists the embed extension registers the
 * TEAM endpoint as omp's provider instead of binding a local router, and the
 * toast, hub and digest extensions talk to the team with the member's key.
 * Nothing is classified or selected locally: the team router is the router.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TEAM_FILE = "team.json";

export interface TeamClient {
	/** The team endpoint, no trailing slash, e.g. https://team.example.com */
	url: string;
	/** The member's user key (`amrt_…`). */
	key: string;
	userId: string;
	name: string;
	joinedAtMs: number;
}

export function teamFilePath(routerHome: string): string {
	return join(routerHome, TEAM_FILE);
}

/** Parses team.json defensively; anything malformed ⇒ not in team mode. */
export function parseTeamClient(text: string): TeamClient | null {
	try {
		const raw = JSON.parse(text) as Record<string, unknown>;
		if (typeof raw.url !== "string" || typeof raw.key !== "string" || raw.url === "" || raw.key === "") return null;
		return { url: raw.url.replace(/\/+$/, ""), key: raw.key, userId: typeof raw.userId === "string" ? raw.userId : "", name: typeof raw.name === "string" ? raw.name : "", joinedAtMs: typeof raw.joinedAtMs === "number" ? raw.joinedAtMs : 0 };
	} catch {
		return null;
	}
}

export function readTeamClient(routerHome: string): TeamClient | null {
	const path = teamFilePath(routerHome);
	if (!existsSync(path)) return null;
	try {
		return parseTeamClient(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** The virtual models the team serves; costs are the router's fallback blend so omp can show estimates. */
export const TEAM_MODELS: readonly { id: string; name: string }[] = [
	{ id: "auto", name: "auto (team)" },
	{ id: "auto-cheap", name: "auto-cheap (team)" },
	{ id: "auto-max", name: "auto-max (team)" },
];

/**
 * omp's provider registration for team mode: the team's /v1 with the member
 * key, the session and subagent tags the team forwards to the router, and the
 * virtual models. Costs are USD per million tokens, like the embedded config.
 */
export function teamProviderRegistration(team: TeamClient, sessionId: string, subagent: boolean, blend: { inputPerMtok: number; outputPerMtok: number }): {
	baseUrl: string;
	api: string;
	apiKey: string;
	headers: Record<string, string>;
	models: { id: string; name: string; api: string; reasoning: boolean; input: string[]; contextWindow: number; maxTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }[];
} {
	const headers: Record<string, string> = {};
	if (sessionId !== "") headers["X-Omp-Session"] = sessionId;
	if (subagent) headers["X-Omp-Subagent"] = "1";
	const round = (v: number): number => Math.round(v * 1e4) / 1e4;
	return {
		baseUrl: `${team.url}/v1`,
		api: "openai-completions",
		apiKey: team.key,
		headers,
		models: TEAM_MODELS.map((m) => ({
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
