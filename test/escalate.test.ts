import { describe, expect, test } from "bun:test";
import { createProbe } from "../src/router/escalate.ts";
import type { ProbePlan } from "../src/router/types.ts";
import type { NormMessage, NormRequest, NormTool, StreamEvent, UpstreamChunk } from "../src/wire/types.ts";

const ALL_TRIGGERS: ReadonlySet<string> = new Set([
	"malformed_tool_args",
	"refusal",
	"empty_completion",
	"repeat_tool_call",
	"missing_expected_tool_call",
	"length_stop",
	"upstream_error",
]);

function plan(over: Partial<ProbePlan> = {}): ProbePlan {
	return { enabled: true, maxTokens: 24, maxHoldMs: 60_000, escalateTo: "simple", ...over };
}

function req(messages: NormMessage[] = [], over: Partial<NormRequest> = {}): NormRequest {
	return {
		protocol: "openai-chat",
		conversationKey: "k",
		harnessId: "",
		ompSessionId: "",
		requestedModel: "auto",
		messages,
		tools: [],
		forcedToolChoice: false,
		stream: true,
		hasImages: false,
		promptBytes: 0,
		renderUpstreamBody: () => ({}),
		...over,
	};
}

function chunk(events: StreamEvent[]): UpstreamChunk {
	return { raw: {}, events };
}

function text(delta: string): UpstreamChunk {
	return chunk([{ type: "text", delta }]);
}

function toolDelta(
	index: number,
	fragment: { id?: string; name?: string; argsDelta?: string },
): UpstreamChunk {
	const ev: StreamEvent = { type: "tool_call", index, ...fragment };
	return chunk([ev]);
}

describe("createProbe", () => {
	test("valid tool-call JSON commits", () => {
		const p = createProbe(plan(), req(), ALL_TRIGGERS);
		expect(p.observe(toolDelta(0, { id: "c1", name: "read", argsDelta: '{"path":"a' }))).toBeNull();
		const verdict = p.observe(toolDelta(0, { argsDelta: '.ts"}' }));
		expect(verdict?.action).toBe("commit");
	});

	test("truncated tool-call JSON at stream end yields malformed_tool_args", () => {
		// Via the finish event.
		const p1 = createProbe(plan(), req(), ALL_TRIGGERS);
		p1.observe(toolDelta(0, { id: "c1", name: "read", argsDelta: '{"path":"a' }));
		const v1 = p1.observe(chunk([{ type: "finish", reason: "tool_calls" }]));
		expect(v1?.action).toBe("escalate");
		expect(v1).toMatchObject({ signal: "malformed_tool_args" });

		// Via stream end with no finish event at all.
		const p2 = createProbe(plan(), req(), ALL_TRIGGERS);
		p2.observe(toolDelta(0, { id: "c1", name: "read", argsDelta: '{"path":"a' }));
		const v2 = p2.verdictOnEnd();
		expect(v2.action).toBe("escalate");
		expect(v2).toMatchObject({ signal: "malformed_tool_args" });
	});

	test("a tool call identical to the previous assistant call yields repeat_tool_call", () => {
		const history: NormMessage[] = [
			{ role: "user", text: "read it", images: 0, textBytes: 8, toolCalls: [] },
			{
				role: "assistant",
				text: "",
				images: 0,
				textBytes: 0,
				toolCalls: [{ id: "c1", name: "read", argsJson: '{"path":"a.ts","line":1}' }],
			},
			{ role: "tool", text: "file contents", images: 0, textBytes: 13, toolCalls: [], toolCallId: "c1", toolName: "read" },
		];
		const p = createProbe(plan(), req(history), ALL_TRIGGERS);
		// Same call, key order shuffled: still a loop.
		const verdict = p.observe(toolDelta(0, { id: "c2", name: "read", argsDelta: '{"line":1,"path":"a.ts"}' }));
		expect(verdict?.action).toBe("escalate");
		expect(verdict).toMatchObject({ signal: "repeat_tool_call" });
	});

	test("a different tool call is not a repeat", () => {
		const history: NormMessage[] = [
			{
				role: "assistant",
				text: "",
				images: 0,
				textBytes: 0,
				toolCalls: [{ id: "c1", name: "read", argsJson: '{"path":"a.ts"}' }],
			},
		];
		const p = createProbe(plan(), req(history), ALL_TRIGGERS);
		const verdict = p.observe(toolDelta(0, { id: "c2", name: "read", argsDelta: '{"path":"b.ts"}' }));
		expect(verdict?.action).toBe("commit");
	});

	test("a disabled plan commits on the first chunk", () => {
		const p = createProbe(plan({ enabled: false }), req(), ALL_TRIGGERS);
		const verdict = p.observe(text("anything at all"));
		expect(verdict?.action).toBe("commit");
		expect(p.held()).toHaveLength(1);
	});

	test("a signal absent from triggers never fires", () => {
		// Truncated args would be malformed_tool_args, but the trigger is off.
		const p1 = createProbe(plan(), req(), new Set(["refusal"]));
		p1.observe(toolDelta(0, { id: "c1", name: "read", argsDelta: '{"path":"a' }));
		const v1 = p1.observe(chunk([{ type: "finish", reason: "tool_calls" }]));
		expect(v1?.action).toBe("commit");

		// Empty completion, but empty_completion is off.
		const p2 = createProbe(plan(), req(), new Set(["malformed_tool_args"]));
		p2.observe(chunk([{ type: "finish", reason: "stop" }]));
		const v2 = p2.verdictOnEnd();
		expect(v2.action).toBe("commit");
	});

	test("refusal openers escalate as soon as text arrives", () => {
		const p = createProbe(plan(), req(), ALL_TRIGGERS);
		const verdict = p.observe(text("I'm sorry, but I can't help with that request."));
		expect(verdict?.action).toBe("escalate");
		expect(verdict).toMatchObject({ signal: "refusal" });
	});

	test("a forced tool choice answered with prose yields missing_expected_tool_call", () => {
		const tools: NormTool[] = [{ name: "read", description: "read a file", schemaBytes: 42 }];
		const p = createProbe(plan(), req([], { tools, forcedToolChoice: true }), ALL_TRIGGERS);
		p.observe(text("Sure, here is some prose instead."));
		const verdict = p.observe(chunk([{ type: "finish", reason: "stop" }]));
		expect(verdict?.action).toBe("escalate");
		expect(verdict).toMatchObject({ signal: "missing_expected_tool_call" });
	});

	test("enough held text commits", () => {
		const p = createProbe(plan({ maxTokens: 2 }), req(), ALL_TRIGGERS);
		const verdict = p.observe(text("this is well over eight characters"));
		expect(verdict?.action).toBe("commit");
	});

	test("an empty stop with nothing emitted yields empty_completion", () => {
		const p = createProbe(plan(), req(), ALL_TRIGGERS);
		const verdict = p.observe(chunk([{ type: "finish", reason: "stop" }]));
		expect(verdict?.action).toBe("escalate");
		expect(verdict).toMatchObject({ signal: "empty_completion" });
	});

	test("a stalled stream escalates at the hold ceiling instead of committing silence", () => {
		let t = 0;
		const p = createProbe(plan({ maxHoldMs: 1_000 }), req(), ALL_TRIGGERS, () => t);
		expect(p.observe(chunk([]))).toBeNull();
		t = 1_001;
		const verdict = p.observe(chunk([]));
		expect(verdict?.action).toBe("escalate");
		expect(verdict).toMatchObject({ signal: "empty_completion" });
	});

	test("the hold ceiling still commits when content has arrived", () => {
		let t = 0;
		const p = createProbe(plan({ maxTokens: 1_000, maxHoldMs: 1_000 }), req(), ALL_TRIGGERS, () => t);
		expect(p.observe(text("partial answer"))).toBeNull();
		t = 1_001;
		const verdict = p.observe(text(" more"));
		expect(verdict?.action).toBe("commit");
	});

	test("a length finish on prose commits: that is the caller's max_tokens", () => {
		// Escalating cannot fix it — the retry runs under the same cap and
		// truncates in the same place, so it would just bill twice.
		const p = createProbe(plan({ maxTokens: 1_000 }), req(), ALL_TRIGGERS);
		expect(p.observe(text("a long answer that ran out of room"))).toBeNull();
		const verdict = p.observe(chunk([{ type: "finish", reason: "length" }]));
		expect(verdict?.action).toBe("commit");
	});

	test("a length finish that truncated tool-call arguments still escalates", () => {
		// Structurally unusable output: another model may emit a complete call.
		const p = createProbe(plan({ maxTokens: 1_000 }), req(), ALL_TRIGGERS);
		expect(p.observe(toolDelta(0, { id: "c1", name: "read", argsDelta: '{"path":"a' }))).toBeNull();
		const verdict = p.observe(chunk([{ type: "finish", reason: "length" }]));
		expect(verdict?.action).toBe("escalate");
	});

	test("a length finish having produced nothing escalates as an empty completion", () => {
		const p = createProbe(plan({ maxTokens: 1_000 }), req(), ALL_TRIGGERS);
		const verdict = p.observe(chunk([{ type: "finish", reason: "length" }]));
		expect(verdict?.action).toBe("escalate");
		if (verdict?.action === "escalate") expect(verdict.signal).toBe("empty_completion");
	});

	test("reasoning-only output counts as alive at the hold ceiling", () => {
		// A reasoning model that has emitted only reasoning tokens after the
		// ceiling is working normally; escalating would discard a healthy paid
		// generation.
		let t = 0;
		const p = createProbe(plan({ maxTokens: 1_000, maxHoldMs: 1_000 }), req(), ALL_TRIGGERS, () => t);
		expect(p.observe(chunk([{ type: "reasoning", delta: "weighing options" }]))).toBeNull();
		t = 1_001;
		const verdict = p.observe(chunk([{ type: "reasoning", delta: " further" }]));
		expect(verdict?.action).toBe("commit");
	});

	test("a stream that ENDS with only reasoning is still hollow", () => {
		const p = createProbe(plan({ maxTokens: 1_000 }), req(), ALL_TRIGGERS);
		expect(p.observe(chunk([{ type: "reasoning", delta: "thinking" }]))).toBeNull();
		const verdict = p.verdictOnEnd();
		expect(verdict.action).toBe("escalate");
		if (verdict.action === "escalate") expect(verdict.signal).toBe("empty_completion");
	});
});
