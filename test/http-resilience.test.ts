import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { startServer, type StartedServer } from "../src/server/http.ts";

describe("HTTP server resilience against dead streams", () => {
	let handle: StartedServer;
	let baseUrl: string;

	beforeAll(() => {
		const cfg: RouterConfig = {
			...DEFAULT_CONFIG,
			server: { host: "127.0.0.1", port: 0, maxConcurrentTurns: 24 },
			ledger: { ...DEFAULT_CONFIG.ledger, path: ":memory:" },
			context: { ...DEFAULT_CONFIG.context, enabled: false },
			logLevel: "silent",
		};
		handle = startServer(cfg);
		baseUrl = `http://127.0.0.1:${handle.server.port}`;
	});
	afterAll(async () => {
		await handle.stop();
	});

	test("server answers /v1/models cleanly initially", async () => {
		const res = await fetch(`${baseUrl}/v1/models`);
		expect(res.status).toBe(200);
		const json = (await res.json()) as { data: unknown[] };
		expect(Array.isArray(json.data)).toBe(true);
	});

	test("cancelling a streaming /v1/chat/completions client does not crash the server", async () => {
		const res = await fetch(`${baseUrl}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: "auto",
				stream: true,
				messages: [{ role: "user", content: "hello" }],
			}),
		});

		// Immediately cancel the reader mid-stream (simulates client disconnect)
		const reader = res.body?.getReader();
		expect(reader).toBeDefined();
		await reader?.cancel("client abruptly dropped");

		// Allow microtasks and I/O ticks to settle without real wall-clock delays
		await new Promise<void>((resolve) => {
			setImmediate(() => resolve());
		});
		// and answers subsequent requests cleanly.
		const modelsRes = await fetch(`${baseUrl}/v1/models`);
		expect(modelsRes.status).toBe(200);
		const json = (await modelsRes.json()) as { data: unknown[] };
		expect(Array.isArray(json.data)).toBe(true);
	});
});
