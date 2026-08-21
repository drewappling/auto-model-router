import { describe, expect, test } from "bun:test";
import type { UpstreamMutations } from "../src/wire/types.ts";
import { WireErrorException } from "../src/wire/openai/errors.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";

const HEADERS = new Headers();

function mutations(overrides: Partial<UpstreamMutations> = {}): UpstreamMutations {
	return {
		slug: "openai/gpt-5.5",
		fallbacks: [],
		sessionId: "omp-test",
		cacheBreakpointMessageIndices: [],
		reasoning: undefined,
		maxTokens: undefined,
		stripAssistantReasoning: false,
		...overrides,
	};
}

function userBody(content: unknown): Record<string, unknown> {
	return { model: "auto", messages: [{ role: "user", content }] };
}

describe("parseChatRequest normalization", () => {
	test("string content and equivalent content-part array normalize to the same text", () => {
		const fromString = parseChatRequest(userBody("hello world"), HEADERS);
		const fromParts = parseChatRequest(
			userBody([{ type: "text", text: "hello world" }]),
			HEADERS,
		);
		expect(fromParts.messages[0]!.text).toBe(fromString.messages[0]!.text);
		expect(fromParts.messages[0]!.textBytes).toBe(fromString.messages[0]!.textBytes);
		expect(fromParts.messages[0]!.images).toBe(0);
	});

	test("image parts are counted and flag hasImages", () => {
		const req = parseChatRequest(
			userBody([
				{ type: "text", text: "look at these" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
				{ type: "image_url", image_url: { url: "https://example.com/x.png" } },
			]),
			HEADERS,
		);
		expect(req.messages[0]!.images).toBe(2);
		expect(req.messages[0]!.text).toBe("look at these");
		expect(req.hasImages).toBe(true);
		expect(parseChatRequest(userBody("plain"), HEADERS).hasImages).toBe(false);
	});

	test("provider prefix is stripped from model", () => {
		expect(parseChatRequest(userBody("hi"), HEADERS).requestedModel).toBe("auto");
		const prefixed = parseChatRequest(
			{ model: "omp-router/auto", messages: [{ role: "user", content: "hi" }] },
			HEADERS,
		);
		expect(prefixed.requestedModel).toBe("auto");
	});

	test("tool schemas, names, and descriptions contribute to promptBytes", () => {
		const parameters = { type: "object", properties: { path: { type: "string" } } };
		const withTools = parseChatRequest(
			{
				model: "auto",
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{
						type: "function",
						function: { name: "read", description: "Read a file", parameters },
					},
				],
			},
			HEADERS,
		);
		const withoutTools = parseChatRequest(userBody("hi"), HEADERS);
		const tool = withTools.tools[0]!;
		expect(tool.schemaBytes).toBe(new TextEncoder().encode(JSON.stringify(parameters)).length);
		expect(withTools.promptBytes).toBe(
			withoutTools.promptBytes + tool.schemaBytes + 4 + "Read a file".length,
		);
	});

	test("tool calls and tool results are carried into NormMessage", () => {
		const req = parseChatRequest(
			{
				model: "auto",
				messages: [
					{
						role: "assistant",
						content: null,
						tool_calls: [
							{ id: "call_1", type: "function", function: { name: "read", arguments: "{\"path\":\"x\"}" } },
						],
					},
					{ role: "tool", tool_call_id: "call_1", name: "read", content: "file bytes" },
				],
			},
			HEADERS,
		);
		expect(req.messages[0]!.toolCalls).toEqual([{ id: "call_1", name: "read", argsJson: "{\"path\":\"x\"}" }]);
		expect(req.messages[1]!.toolCallId).toBe("call_1");
		expect(req.messages[1]!.toolName).toBe("read");
	});

	test("forcedToolChoice only for objects and non-auto/none strings", () => {
		const base = userBody("hi");
		expect(parseChatRequest(base, HEADERS).forcedToolChoice).toBe(false);
		expect(parseChatRequest({ ...base, tool_choice: "auto" }, HEADERS).forcedToolChoice).toBe(false);
		expect(parseChatRequest({ ...base, tool_choice: "none" }, HEADERS).forcedToolChoice).toBe(false);
		expect(parseChatRequest({ ...base, tool_choice: "required" }, HEADERS).forcedToolChoice).toBe(true);
		expect(
			parseChatRequest(
				{ ...base, tool_choice: { type: "function", function: { name: "read" } } },
				HEADERS,
			).forcedToolChoice,
		).toBe(true);
	});

	test("reasoning accepted from both spellings, omitted when absent", () => {
		expect(
			parseChatRequest({ ...userBody("hi"), reasoning_effort: "high" }, HEADERS).reasoning,
		).toBe("high");
		expect(
			parseChatRequest({ ...userBody("hi"), reasoning: { effort: "low" } }, HEADERS).reasoning,
		).toBe("low");
		expect(
			parseChatRequest({ ...userBody("hi"), reasoning: { enabled: false } }, HEADERS).reasoning,
		).toBe("off");
		const plain = parseChatRequest(userBody("hi"), HEADERS);
		expect("reasoning" in plain).toBe(false);
	});

	test("malformed input throws WireErrorException", () => {
		expect(() => parseChatRequest(null, HEADERS)).toThrow(WireErrorException);
		expect(() => parseChatRequest({ model: "auto", messages: [] }, HEADERS)).toThrow(WireErrorException);
		expect(() => parseChatRequest({ messages: [{ role: "user", content: "hi" }] }, HEADERS)).toThrow(
			WireErrorException,
		);
		try {
			parseChatRequest({ model: "auto", messages: [{ role: "user", content: 42 }] }, HEADERS);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(WireErrorException);
			expect((e as WireErrorException).wireError.status).toBe(400);
			expect((e as WireErrorException).wireError.code).toBe("invalid_request");
		}
	});
});

describe("conversationKey", () => {
	const system = { role: "system", content: "You are a coding agent." };
	const first = { role: "user", content: "Fix the bug in main.ts" };

	test("stable across later turns of the same conversation", () => {
		const turn1 = parseChatRequest({ model: "auto", messages: [system, first] }, HEADERS);
		const turn3 = parseChatRequest(
			{
				model: "auto",
				messages: [
					system,
					first,
					{ role: "assistant", content: "Done." },
					{ role: "user", content: "Now add a test" },
				],
			},
			HEADERS,
		);
		expect(turn1.conversationKey).toBe(turn3.conversationKey);
		expect(turn1.conversationKey).toMatch(/^[0-9a-f]{32}$/);
	});

	test("differs when the first non-system message differs", () => {
		const a = parseChatRequest({ model: "auto", messages: [system, first] }, HEADERS);
		const b = parseChatRequest(
			{ model: "auto", messages: [system, { role: "user", content: "Write a poem" }] },
			HEADERS,
		);
		expect(a.conversationKey).not.toBe(b.conversationKey);
	});
});

describe("renderUpstreamBody", () => {
	test("two renders are independent and never mutate the original body", () => {
		const original = {
			model: "auto",
			messages: [{ role: "user", content: "hi" }],
			stream: false,
			max_tokens: 100,
			reasoning_effort: "low",
		};
		const req = parseChatRequest(original, HEADERS);
		const before = JSON.stringify(original);

		const a = req.renderUpstreamBody(mutations({ slug: "openai/aaa" }));
		const b = req.renderUpstreamBody(
			mutations({
				slug: "openai/bbb",
				fallbacks: ["openai/ccc"],
				sessionId: "omp-2",
				maxTokens: 50,
				reasoning: "high",
				cacheBreakpointMessageIndices: [0],
			}),
		);

		expect(a.model).toBe("openai/aaa");
		expect(b.model).toBe("openai/bbb");
		expect(a.models).toBeUndefined();
		expect(b.models).toEqual(["openai/bbb", "openai/ccc"]);
		expect(b.session_id).toBe("omp-2");
		expect(a.stream).toBe(true);
		expect(b.stream).toBe(true);
		expect("stream_options" in b).toBe(false);
		expect(a.max_tokens).toBe(100);
		expect(b.max_tokens).toBe(50);
		expect("reasoning_effort" in a).toBe(false);
		expect("reasoning_effort" in b).toBe(false);
		expect("reasoning" in a).toBe(false);
		expect(b.reasoning).toEqual({ effort: "high" });

		// Mutating one render must not leak into the other or the original.
		(b.messages as Record<string, unknown>[])[0]!.content = "mutated";
		expect((a.messages as Record<string, unknown>[])[0]!.content).toBe("hi");
		expect(JSON.stringify(original)).toBe(before);
	});

	test("maxTokens lands on whichever spelling the client used", () => {
		const req = parseChatRequest(
			{ model: "auto", messages: [{ role: "user", content: "hi" }], max_completion_tokens: 200 },
			HEADERS,
		);
		const out = req.renderUpstreamBody(mutations({ maxTokens: 64 }));
		expect(out.max_completion_tokens).toBe(64);
		expect("max_tokens" in out).toBe(false);
	});

	test("reasoning off renders as { enabled: false }", () => {
		const req = parseChatRequest(userBody("hi"), HEADERS);
		const out = req.renderUpstreamBody(mutations({ reasoning: "off" }));
		expect(out.reasoning).toEqual({ enabled: false });
	});

	test("cache breakpoints land on named messages and promote string content to parts", () => {
		const req = parseChatRequest(
			{
				model: "auto",
				messages: [
					{ role: "system", content: "system prompt" },
					{ role: "user", content: "first question" },
					{ role: "assistant", content: [{ type: "text", text: "answer" }, { type: "text", text: "more" }] },
					{ role: "user", content: "follow up" },
				],
			},
			HEADERS,
		);
		const out = req.renderUpstreamBody(mutations({ cacheBreakpointMessageIndices: [0, 2] }));
		const msgs = out.messages as Array<Record<string, unknown>>;

		expect(msgs[0]!.content).toEqual([
			{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
		]);
		// Untouched message keeps its original shape.
		expect(msgs[1]!.content).toBe("first question");
		// Breakpoint lands on the LAST text part of the message.
		expect(msgs[2]!.content).toEqual([
			{ type: "text", text: "answer" },
			{ type: "text", text: "more", cache_control: { type: "ephemeral" } },
		]);
	});

	test("stripAssistantReasoning removes all three spellings from assistant messages only", () => {
		const req = parseChatRequest(
			{
				model: "auto",
				messages: [
					{
						role: "assistant",
						content: "a1",
						reasoning: "r",
						reasoning_content: "rc",
						reasoning_details: [{ type: "reasoning.text", text: "rc" }],
					},
					{ role: "user", content: "u1", reasoning: "keep-me" },
				],
			},
			HEADERS,
		);
		const out = req.renderUpstreamBody(mutations({ stripAssistantReasoning: true }));
		const msgs = out.messages as Array<Record<string, unknown>>;
		expect("reasoning" in msgs[0]!).toBe(false);
		expect("reasoning_content" in msgs[0]!).toBe(false);
		expect("reasoning_details" in msgs[0]!).toBe(false);
		expect(msgs[0]!.content).toBe("a1");
		expect(msgs[1]!.reasoning).toBe("keep-me");
	});
});
