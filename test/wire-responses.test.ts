import { describe, expect, test } from "bun:test";

import { WireErrorException } from "../src/wire/openai/errors.ts";
import { createResponsesBufferedSink, createResponsesStreamingSink, parseResponsesRequest, responsesToChatBody } from "../src/wire/openai/responses.ts";
import type { StreamEvent, TurnSummary, UpstreamChunk } from "../src/wire/types.ts";

/**
 * The Responses API wire: request translation into the chat shape the router
 * routes on, and rendering of the upstream chat stream as Responses events.
 */

const HEADERS = new Headers({ "X-Omp-Harness": "codex" });

describe("responsesToChatBody", () => {
	test("instructions, messages, function calls and their outputs become chat messages", () => {
		const chat = responsesToChatBody({
			model: "auto",
			instructions: "Be terse.",
			input: [
				{ type: "message", role: "user", content: [{ type: "input_text", text: "list files" }] },
				{ type: "function_call", call_id: "call_1", name: "shell", arguments: '{"cmd":"ls"}' },
				{ type: "function_call", call_id: "call_2", name: "shell", arguments: '{"cmd":"pwd"}' },
				{ type: "function_call_output", call_id: "call_1", output: "a.ts b.ts" },
				{ type: "function_call_output", call_id: "call_2", output: [{ type: "input_text", text: "/repo" }] },
				{ type: "reasoning", summary: [] },
				{ role: "user", content: "and now?" },
			],
			tools: [{ type: "function", name: "shell", description: "run", parameters: { type: "object" }, strict: false }, { type: "web_search" }],
			tool_choice: { type: "function", name: "shell" },
			max_output_tokens: 512,
			reasoning: { effort: "low", summary: "auto" },
			store: false,
			include: ["reasoning.encrypted_content"],
			prompt_cache_key: "k",
			stream: true,
			parallel_tool_calls: true,
		});
		expect(chat.messages).toEqual([
			{ role: "system", content: "Be terse." },
			{ role: "user", content: "list files" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } },
					{ id: "call_2", type: "function", function: { name: "shell", arguments: '{"cmd":"pwd"}' } },
				],
			},
			{ role: "tool", tool_call_id: "call_1", content: "a.ts b.ts" },
			{ role: "tool", tool_call_id: "call_2", content: "/repo" },
			{ role: "user", content: "and now?" },
		]);
		expect(chat.tools).toEqual([{ type: "function", function: { name: "shell", description: "run", parameters: { type: "object" } } }]);
		expect(chat.tool_choice).toEqual({ type: "function", function: { name: "shell" } });
		expect(chat.max_tokens).toBe(512);
		expect(chat.reasoning).toEqual({ effort: "low" });
		expect(chat.stream).toBe(true);
		expect(chat.parallel_tool_calls).toBe(true);
		for (const k of ["instructions", "input", "store", "include", "prompt_cache_key", "max_output_tokens"]) expect(k in chat).toBe(false);
	});

	test("a string input is one user message; images survive; previous_response_id is refused", () => {
		expect(responsesToChatBody({ model: "auto", input: "hi" }).messages).toEqual([{ role: "user", content: "hi" }]);
		const withImage = responsesToChatBody({ model: "auto", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "what is this" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] }] });
		expect(withImage.messages).toEqual([{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }]);
		expect(() => responsesToChatBody({ model: "auto", input: "x", previous_response_id: "resp_1" })).toThrow(WireErrorException);
		expect(() => responsesToChatBody({ model: "auto", input: [] })).toThrow(WireErrorException);
	});

	test("parseResponsesRequest yields a routed request tagged with the wire", () => {
		const req = parseResponsesRequest({ model: "auto-model-router/auto-cheap", input: "hello", stream: false }, HEADERS);
		expect(req.protocol).toBe("openai-responses");
		expect(req.requestedModel).toBe("auto-cheap");
		expect(req.harnessId).toBe("codex");
		expect(req.messages).toHaveLength(1);
		expect(req.stream).toBe(false);
	});
});

const SUMMARY: TurnSummary = {
	servedSlug: "openai/gpt-5.5",
	tier: "simple",
	attempts: 1,
	predictedUsd: 0.001,
	reportedUsd: 0.0012,
	usage: { promptTokens: 120, cachedTokens: 100, cacheWriteTokens: 0, completionTokens: 9, reasoningTokens: 2, images: 0 },
	reasons: [],
	escalated: false,
};
const chunk = (...events: StreamEvent[]): UpstreamChunk => ({ raw: { id: "gen-1", object: "chat.completion.chunk", model: "openai/gpt-5.5" }, events });

function parseEvents(text: string): { event: string; data: Record<string, unknown> }[] {
	return text
		.split("\n\n")
		.filter((f) => f.startsWith("event: "))
		.map((f) => {
			const [eventLine = "", ...rest] = f.split("\n");
			const dataLine = rest.find((l) => l.startsWith("data: ")) ?? "data: {}";
			return { event: eventLine.slice("event: ".length), data: JSON.parse(dataLine.slice("data: ".length)) as Record<string, unknown> };
		});
}

describe("createResponsesStreamingSink", () => {
	test("renders text then a function call as the standard event sequence, ending in response.completed with usage", async () => {
		const { sink, response } = createResponsesStreamingSink("auto");
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		sink.chunk(chunk({ type: "start", servedSlug: "openai/gpt-5.5", generationId: "gen-1" }));
		sink.chunk(chunk({ type: "text", delta: "Run" }));
		sink.chunk(chunk({ type: "text", delta: "ning" }));
		sink.chunk(chunk({ type: "tool_call", index: 0, id: "call_9", name: "shell", argsDelta: '{"cmd":' }));
		sink.chunk(chunk({ type: "tool_call", index: 0, argsDelta: '"ls"}' }));
		sink.chunk(chunk({ type: "finish", reason: "tool_calls" }, { type: "usage", usage: SUMMARY.usage, reportedCostUsd: 0.0012 }));
		sink.finish(SUMMARY);
		const text = await response.text();
		const events = parseEvents(text);
		expect(events.map((e) => e.event)).toEqual([
			"response.created",
			"response.in_progress",
			"response.output_item.added",
			"response.content_part.added",
			"response.output_text.delta",
			"response.output_text.delta",
			"response.output_text.done",
			"response.content_part.done",
			"response.output_item.done",
			"response.output_item.added",
			"response.function_call_arguments.delta",
			"response.function_call_arguments.delta",
			"response.function_call_arguments.done",
			"response.output_item.done",
			"response.completed",
		]);
		// Every frame names its type and carries a rising sequence number.
		events.forEach((e, i) => {
			expect(e.data.type).toBe(e.event);
			expect(e.data.sequence_number).toBe(i);
		});
		const completed = events.at(-1)!.data;
		const resp = completed.response as { status: string; model: string; output: Record<string, unknown>[]; usage: Record<string, unknown> };
		expect(resp.status).toBe("completed");
		expect(resp.model).toBe("auto");
		expect(resp.output).toHaveLength(2);
		expect(resp.output[0]).toMatchObject({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Running" }] });
		expect(resp.output[1]).toMatchObject({ type: "function_call", call_id: "call_9", name: "shell", arguments: '{"cmd":"ls"}', status: "completed" });
		expect(resp.usage).toEqual({ input_tokens: 120, input_tokens_details: { cached_tokens: 100 }, output_tokens: 9, output_tokens_details: { reasoning_tokens: 2 }, total_tokens: 129 });
		expect(completed.x_auto_model_router).toEqual({ model: "openai/gpt-5.5", tier: "simple", cost_usd: 0.0012, attempts: 1 });
		// The Responses stream has no [DONE] sentinel.
		expect(text).not.toContain("[DONE]");
	});

	test("an error becomes an error event and response.failed", async () => {
		const { sink, response } = createResponsesStreamingSink("auto");
		sink.error({ status: 502, code: "upstream_error", message: "boom" });
		const events = parseEvents(await response.text());
		expect(events.map((e) => e.event)).toEqual(["error", "response.failed"]);
		expect(events[0]!.data).toMatchObject({ code: "upstream_error", message: "boom" });
	});
});

describe("createResponsesBufferedSink", () => {
	test("aggregates the stream into one Response object with the routing headers", async () => {
		const { sink, response } = createResponsesBufferedSink("auto");
		sink.chunk(chunk({ type: "start", servedSlug: "openai/gpt-5.5", generationId: "gen-1" }, { type: "text", delta: "4" }, { type: "finish", reason: "stop" }));
		sink.finish(SUMMARY);
		const res = await response;
		expect(res.status).toBe(200);
		expect(res.headers.get("x-auto-model-router-model")).toBe("openai/gpt-5.5");
		const body = (await res.json()) as { object: string; status: string; output: { type: string; content: { text: string }[] }[]; usage: { total_tokens: number } };
		expect(body.object).toBe("response");
		expect(body.status).toBe("completed");
		expect(body.output[0]?.content[0]?.text).toBe("4");
		expect(body.usage.total_tokens).toBe(129);
	});
});
