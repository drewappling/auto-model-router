#!/usr/bin/env bun
/**
 * Request-capture proxy for harness fixtures.
 *
 *   bun tools/capture-proxy.ts --listen 8799 --upstream http://127.0.0.1:8788 --out test/fixtures/harness --name codex
 *
 * Point a harness at http://127.0.0.1:8799/v1, run one turn, and every
 * POST /v1/chat/completions body it sent is written to
 * `<out>/<name>-<n>.json` with the request headers that matter (harness,
 * session, subagent, content-type, user-agent) beside it. Everything is
 * forwarded to the real router unchanged, streaming included, so the turn
 * completes normally. Authorization headers are never written.
 *
 * The saved bodies are what test/harness-requests.test.ts parses: a harness
 * release that changes its request shape then shows up as a failing test
 * rather than a user report. Re-run only to refresh a harness's fixture.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
};
const listen = Number.parseInt(flag("--listen", "8799"), 10);
const upstream = flag("--upstream", "http://127.0.0.1:8788").replace(/\/$/, "");
const out = flag("--out", "test/fixtures/harness");
const name = flag("--name", "harness");
mkdirSync(out, { recursive: true });

const KEEP_HEADERS = ["content-type", "user-agent", "x-omp-harness", "x-omp-session", "x-omp-subagent", "x-title", "http-referer"];
let n = 0;

/** Large text is not what the fixture guards; cap message text so files stay small. */
function trim(body: unknown): unknown {
	if (typeof body === "string") return body.length > 400 ? `${body.slice(0, 400)}…[${body.length} chars]` : body;
	if (Array.isArray(body)) return body.map(trim);
	if (body !== null && typeof body === "object") return Object.fromEntries(Object.entries(body as Record<string, unknown>).map(([k, v]) => [k, trim(v)]));
	return body;
}

Bun.serve({
	port: listen,
	hostname: "127.0.0.1",
	idleTimeout: 255,
	async fetch(req) {
		const url = new URL(req.url);
		const raw = req.method === "POST" ? await req.text() : "";
		if (req.method === "POST" && (url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/responses") || url.pathname.endsWith("/messages"))) {
			n += 1;
			let body: unknown = raw;
			try {
				body = JSON.parse(raw);
			} catch {
				// Not JSON: keep the raw text.
			}
			const headers: Record<string, string> = {};
			for (const h of KEEP_HEADERS) {
				const v = req.headers.get(h);
				if (v !== null) headers[h] = v;
			}
			const file = join(out, `${name}-${n}.json`);
			await Bun.write(file, JSON.stringify({ harness: name, capturedAtMs: Date.now(), headers, body: trim(body) }, null, 1));
			console.log(`captured ${file} (${raw.length} bytes)`);
		}
		const fwd = new Headers(req.headers);
		fwd.delete("host");
		fwd.delete("content-length");
		const res = await fetch(upstream + url.pathname + url.search, {
			method: req.method,
			headers: fwd,
			...(req.method === "POST" ? { body: raw } : {}),
		});
		return new Response(res.body, { status: res.status, headers: res.headers });
	},
});
console.log(`capture proxy on http://127.0.0.1:${listen} → ${upstream}; writing ${out}/${name}-<n>.json`);
