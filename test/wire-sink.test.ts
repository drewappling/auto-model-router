import { describe, expect, test } from "bun:test";
import { EMPTY_USAGE } from "../src/cost/types.ts";
import type { TurnSummary } from "../src/wire/types.ts";
import { createBufferedSink, createStreamingSink } from "../src/wire/openai/sink.ts";

const SUMMARY: TurnSummary = {
	servedSlug: "openai/gpt-5.5",
	tier: "simple",
	attempts: 1,
	predictedUsd: 0.001,
	reportedUsd: 0.0012,
	usage: EMPTY_USAGE,
	reasons: [],
	escalated: false,
};

function chunk(raw: Record<string, unknown>): { raw: Record<string, unknown>; events: [] } {
	return { raw, events: [] };
}

function parseFrames(text: string): unknown[] {
	return text
		.split("\n\n")
		.filter((f) => f.startsWith("data: ") && f !== "data: [DONE]")
		.map((f) => JSON.parse(f.slice("data: ".length)));
}

describe("createStreamingSink", () => {
	test("rewrites model to the virtual id and preserves the served slug under x_auto_model_router", async () => {
		const { sink, response } = createStreamingSink("auto");
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(response.headers.get("cache-control")).toBe("no-cache");

		sink.chunk(
			chunk({
				id: "gen-1",
				object: "chat.completion.chunk",
				created: 1700000000,
				model: "openai/gpt-5.5",
				choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
			}),
		);
		sink.finish(SUMMARY);

		const text = await response.text();
		const frames = parseFrames(text);
		const first = frames[0] as Record<string, unknown>;
		expect(first.model).toBe("auto");
		expect(first.x_auto_model_router).toEqual({ model: "openai/gpt-5.5" });
		// Unknown upstream fields ride along verbatim.
		expect(first.id).toBe("gen-1");

		// Headers flushed with the first chunk, so the summary arrives as the
		// final x_auto_model_router frame before [DONE].
		const last = frames[frames.length - 1] as Record<string, unknown>;
		expect(last.x_auto_model_router).toEqual({
			model: "openai/gpt-5.5",
			tier: "simple",
			cost_usd: 0.0012,
			attempts: 1,
		});
		expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
	});

	test("error emits one OpenAI-envelope frame before closing", async () => {
		const { sink, response } = createStreamingSink("auto");
		sink.error({ status: 502, code: "upstream_error", message: "boom" });
		const frames = parseFrames(await response.text());
		expect(frames).toEqual([
			{ error: { message: "boom", type: "server_error", code: "upstream_error" } },
		]);
	});
});

describe("createBufferedSink", () => {
	test("reassembles split tool_calls argument fragments into one valid JSON string", async () => {
		const { sink, response } = createBufferedSink("auto");
		sink.chunk(
			chunk({
				id: "gen-1",
				created: 1700000000,
				model: "anthropic/claude-haiku-4.5",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							tool_calls: [
								{
									index: 0,
									id: "call_abc",
									type: "function",
									function: { name: "read", arguments: "{\"path\":" },
								},
							],
						},
						finish_reason: null,
					},
				],
			}),
		);
		// Second fragment carries neither id nor name; they must survive from the first.
		sink.chunk(
			chunk({
				model: "anthropic/claude-haiku-4.5",
				choices: [
					{
						index: 0,
						delta: { tool_calls: [{ index: 0, function: { arguments: "\"src/main.ts\"}" } }] },
						finish_reason: null,
					},
				],
			}),
		);
		sink.chunk(
			chunk({
				model: "anthropic/claude-haiku-4.5",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
				usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
			}),
		);
		sink.finish(SUMMARY);

		const res = await response;
		expect(res.headers.get("x-auto-model-router-model")).toBe("openai/gpt-5.5");
		expect(res.headers.get("x-auto-model-router-tier")).toBe("simple");
		expect(res.headers.get("x-auto-model-router-cost-usd")).toBe("0.0012");
		expect(res.headers.get("x-auto-model-router-attempts")).toBe("1");

		const body = (await res.json()) as {
			object: string;
			model: string;
			choices: Array<{
				finish_reason: string;
				message: { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> };
			}>;
			usage: unknown;
		};
		expect(body.object).toBe("chat.completion");
		expect(body.model).toBe("auto");
		expect(body.choices[0]!.finish_reason).toBe("tool_calls");
		const call = body.choices[0]!.message.tool_calls[0]!;
		expect(call.id).toBe("call_abc");
		expect(call.function.name).toBe("read");
		expect(JSON.parse(call.function.arguments)).toEqual({ path: "src/main.ts" });
		expect(body.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
	});

	test("merges text and reasoning deltas per choice", async () => {
		const { sink, response } = createBufferedSink("auto-cheap");
		sink.chunk(
			chunk({
				model: "x/y",
				choices: [{ index: 0, delta: { role: "assistant", reasoning: "think ", content: "Hel" } }],
			}),
		);
		sink.chunk(
			chunk({
				model: "x/y",
				choices: [{ index: 0, delta: { reasoning: "more", content: "lo" }, finish_reason: "stop" }],
			}),
		);
		sink.finish(SUMMARY);
		const body = (await (await response).json()) as {
			choices: Array<{ message: { role: string; content: string; reasoning: string } }>;
		};
		expect(body.choices[0]!.message).toEqual({ role: "assistant", content: "Hello", reasoning: "think more" });
	});

	test("error before finish resolves with the envelope at the WireError status", async () => {
		const { sink, response } = createBufferedSink("auto");
		sink.error({ status: 429, code: "rate_limit", message: "slow down" });
		const res = await response;
		expect(res.status).toBe(429);
		expect(await res.json()).toEqual({
			error: { message: "slow down", type: "rate_limit_error", code: "rate_limit" },
		});
	});
});
