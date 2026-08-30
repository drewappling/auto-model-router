/**
 * Scriptable stand-in for the OpenRouter API, for end-to-end verification
 * without an API key or real spend.
 *
 * Serves the real 147-model catalog fixture from `GET /models`, and synthesizes
 * SSE chat completions whose shape and `usage` accounting mirror OpenRouter's
 * wire format (including `prompt_tokens_details` and `cost`).
 *
 * Behaviour is driven at runtime via `POST /__control` so a driver can force
 * the exact failure a guarded probe is supposed to catch.
 */

import { existsSync } from "node:fs";

export interface MockControl {
	/** Slugs that emit a truncated tool call, tripping `malformed_tool_args`. */
	truncateToolArgs: string[];
	/**
	 * Truncate the tool call on the next N tool-offering generations, whatever
	 * model serves them. Lets a test exercise escalation without predicting
	 * which slug the router will pick.
	 */
	truncateFirstN: number;
	/** Slugs that finish `stop` with no content, tripping `empty_completion`. */
	emptyCompletion: string[];
	/** Slugs that open with a refusal, tripping `refusal`. */
	refuse: string[];
	/** Slugs that answer with the tool call named here, to trip `repeat_tool_call`. */
	echoToolCall: Record<string, { name: string; arguments: string }>;
	/** Slugs that fail with this HTTP status before streaming. */
	failWith: Record<string, number>;
	/**
	 * Guardrail allowlist: when non-empty, `/models/user` returns ONLY models
	 * matching these slugs.
	 */
	allowedModels: string[];
	/** Fraction of prompt tokens reported as cache reads. */
	cacheHitRate: number;
	/** Artificial delay before the first content chunk, ms. */
	ttftMs: number;
}
const DEFAULT_CONTROL: MockControl = {
	truncateToolArgs: [],
	truncateFirstN: 0,
	emptyCompletion: [],
	refuse: [],
	echoToolCall: {},
	failWith: {},
	allowedModels: [],
	cacheHitRate: 0,
	ttftMs: 0,
};

export interface MockServer {
	url: string;
	port: number;
	control: MockControl;
	/** Every completion request observed, in order. Assertions read this. */
	requests: { model: string; models: string[] | undefined; sessionId: string | null; body: Record<string, unknown> }[];
	stop(): Promise<void>;
}

function sse(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function startMockOpenRouter(fixturePath: string, port = 0): Promise<MockServer> {
	if (!existsSync(fixturePath)) throw new Error(`mock catalog fixture missing: ${fixturePath}`);
	const catalog = await Bun.file(fixturePath).text();
	const control: MockControl = { ...DEFAULT_CONTROL };
	const requests: MockServer["requests"] = [];

	const server = Bun.serve({
		port,
		hostname: "127.0.0.1",
		idleTimeout: 60,
		async fetch(req) {
			const url = new URL(req.url);

			if (url.pathname === "/__control" && req.method === "POST") {
				Object.assign(control, (await req.json()) as Partial<MockControl>);
				return Response.json({ ok: true, control });
			}
			if (url.pathname === "/__requests") return Response.json(requests);
			if (url.pathname.endsWith("/models/user")) {
				if (control.allowedModels.length === 0) {
					return new Response(catalog, { headers: { "content-type": "application/json" } });
				}
				try {
					const parsed = JSON.parse(catalog) as { data: Array<{ id?: string }> };
					const filtered = parsed.data.filter((m) => typeof m.id === "string" && control.allowedModels.includes(m.id));
					return Response.json({ ...parsed, data: filtered });
				} catch {
					return new Response(catalog, { headers: { "content-type": "application/json" } });
				}
			}
			if (url.pathname.endsWith("/models")) {
				return new Response(catalog, { headers: { "content-type": "application/json" } });
			}
			if (!url.pathname.endsWith("/chat/completions")) {
				return Response.json({ error: { message: "not found" } }, { status: 404 });
			}

			const body = (await req.json()) as Record<string, unknown>;
			const model = String(body.model ?? "");
			requests.push({
				model,
				models: Array.isArray(body.models) ? (body.models as string[]) : undefined,
				sessionId: req.headers.get("x-session-id"),
				body,
			});

			const status = control.failWith[model];
			if (status !== undefined) {
				return Response.json(
					{ error: { message: `mock forced status ${status} for ${model}`, code: status } },
					{ status },
				);
			}

			// Plausible magnitudes suffice here; the mock is not a tokenizer.
			const promptTokens = Math.max(1, Math.ceil(JSON.stringify(body).length / 3.6));
			const cached = Math.floor(promptTokens * control.cacheHitRate);
			const offersTools = Array.isArray(body.tools) && body.tools.length > 0;
			const generationId = `gen-mock-${Math.random().toString(36).slice(2, 10)}`;

			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					const enc = new TextEncoder();
					const push = (s: string) => controller.enqueue(enc.encode(s));
					const base = { id: generationId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1e3), model };

					// OpenRouter emits keep-alive comments on slow upstreams; exercise that path.
					push(": OPENROUTER PROCESSING\n\n");
					push(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }));
					if (control.ttftMs > 0) await Bun.sleep(control.ttftMs);

					let finishReason = "stop";
					let completionTokens = 8;

					const echo = control.echoToolCall[model];
					if (control.emptyCompletion.includes(model)) {
						completionTokens = 0;
					} else if (control.refuse.includes(model)) {
						for (const piece of ["I'm sorry, ", "but I can't ", "help with that."]) {
							push(sse({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
						}
					} else if (echo) {
						push(
							sse({
								...base,
								choices: [
									{
										index: 0,
										delta: {
											tool_calls: [
												{ index: 0, id: "call_echo", type: "function", function: { name: echo.name, arguments: "" } },
											],
										},
										finish_reason: null,
									},
								],
							}),
						);
						push(
							sse({
								...base,
								choices: [
									{
										index: 0,
										delta: { tool_calls: [{ index: 0, function: { arguments: echo.arguments } }] },
										finish_reason: null,
									},
								],
							}),
						);
						finishReason = "tool_calls";
					} else if (offersTools) {
						const full = JSON.stringify({ path: "src/index.ts" });
						// Split the argument JSON across frames; truncate it when scripted to,
						// which is exactly the malformed-tool-args case the probe must catch.
						let truncate = control.truncateToolArgs.includes(model);
						if (!truncate && control.truncateFirstN > 0) {
							truncate = true;
							control.truncateFirstN--;
						}
						const args = truncate ? full.slice(0, full.length - 4) : full;
						push(
							sse({
								...base,
								choices: [
									{
										index: 0,
										delta: {
											tool_calls: [
												{ index: 0, id: "call_mock", type: "function", function: { name: "read", arguments: "" } },
											],
										},
										finish_reason: null,
									},
								],
							}),
						);
						for (let i = 0; i < args.length; i += 7) {
							push(
								sse({
									...base,
									choices: [
										{
											index: 0,
											delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 7) } }] },
											finish_reason: null,
										},
									],
								}),
							);
						}
						finishReason = "tool_calls";
						completionTokens = 24;
					} else {
						push(sse({ ...base, choices: [{ index: 0, delta: { reasoning: "weighing options" }, finish_reason: null }] }));
						for (const piece of ["Mock ", "answer ", "from ", model, "."]) {
							push(sse({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
						}
						completionTokens = 12;
					}

					push(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }));
					push(
						sse({
							...base,
							choices: [],
							usage: {
								prompt_tokens: promptTokens,
								completion_tokens: completionTokens,
								total_tokens: promptTokens + completionTokens,
								prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: cached > 0 ? 0 : promptTokens },
								completion_tokens_details: { reasoning_tokens: 0 },
								cost: (promptTokens * 3e-6 + completionTokens * 1.5e-5) as number,
								cost_details: { upstream_inference_cost: 0 },
							},
						}),
					);
					push("data: [DONE]\n\n");
					controller.close();
				},
			});

			return new Response(stream, {
				headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
			});
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		port: server.port ?? 0,
		control,
		requests,
		stop: async () => {
			await server.stop(true);
		},
	};
}

if (import.meta.main) {
	const mock = await startMockOpenRouter("test/fixtures/openrouter-models.json", Number(process.env.MOCK_PORT ?? 8799));
	console.log(`mock openrouter listening on ${mock.url}`);
}
