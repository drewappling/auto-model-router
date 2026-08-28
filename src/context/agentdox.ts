/**
 * agentdox REST client.
 *
 * Deliberately tiny and total: every method resolves to a value or null and
 * never throws. agentdox is an ENRICHMENT, not a dependency — if it is down,
 * slow, or unauthorized, the turn must still route and dispatch normally.
 */

import type { Logger } from "../util/log.ts";

export interface AgentDoxClientOptions {
	baseUrl: string;
	token: string;
	timeoutMs: number;
	log: Logger;
}

export interface AgentDoxClient {
	/**
	 * Assembles a context slice for `scope`, biased by `query`. Falls back to
	 * the server's pre-assembled baseline when assembly is unavailable (older
	 * server, or no query-relevant content).
	 */
	assemble(scope: string, query: string): Promise<string | null>;
	createSession(scope: string, title: string): Promise<string | null>;
	append(sessionId: string, role: "user" | "assistant", content: string, refs: string[]): Promise<boolean>;
}

export function createAgentDoxClient(opts: AgentDoxClientOptions): AgentDoxClient {
	const { baseUrl, token, timeoutMs, log } = opts;
	const root = baseUrl.replace(/\/+$/, "");

	const request = async (
		method: string,
		path: string,
		body?: unknown,
	): Promise<{ status: number; json: unknown } | null> => {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), timeoutMs);
		try {
			const headers: Record<string, string> = { authorization: `Bearer ${token}` };
			if (body !== undefined) headers["content-type"] = "application/json";
			const res = await fetch(`${root}${path}`, {
				method,
				headers,
				signal: ctl.signal,
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
			// A 404 is meaningful data (no snapshot/brief yet), not a failure.
			const text = await res.text();
			let parsed: unknown = null;
			try {
				parsed = text === "" ? null : JSON.parse(text);
			} catch {
				parsed = null;
			}
			return { status: res.status, json: parsed };
		} catch (err) {
			// Timeouts, connection refused, DNS — all the same to the caller.
			log.debug("agentdox request failed", {
				method,
				path,
				error: err instanceof Error ? err.message : String(err),
			});
			return null;
		} finally {
			clearTimeout(timer);
		}
	};

	const promptOf = (json: unknown): string | null => {
		if (typeof json !== "object" || json === null) return null;
		const p = (json as { prompt?: unknown }).prompt;
		return typeof p === "string" && p.trim() !== "" ? p : null;
	};

	return {
		async assemble(scope, query) {
			const res = await request("POST", "/context/assemble", { scope, query });
			if (res !== null && res.status === 200) {
				const prompt = promptOf(res.json);
				if (prompt !== null) return prompt;
			}
			if (res !== null && (res.status === 401 || res.status === 403)) {
				log.warn("agentdox rejected the router token; context injection is off for this scope", {
					scope,
					status: res.status,
				});
				return null;
			}
			// Baseline fallback: the server-side auto-context job keeps this fresh.
			const snap = await request("GET", `/context/snapshot?scope=${encodeURIComponent(scope)}`);
			if (snap === null || snap.status !== 200) return null;
			return promptOf(snap.json);
		},

		async createSession(scope, title) {
			const res = await request("POST", "/sessions", { scope, title });
			if (res === null || (res.status !== 200 && res.status !== 201)) return null;
			const id = (res.json as { id?: unknown } | null)?.id;
			return typeof id === "string" ? id : null;
		},

		async append(sessionId, role, content, refs) {
			const res = await request("POST", `/sessions/${encodeURIComponent(sessionId)}/messages`, {
				role,
				content,
				refs,
			});
			return res !== null && (res.status === 200 || res.status === 201);
		},
	};
}
