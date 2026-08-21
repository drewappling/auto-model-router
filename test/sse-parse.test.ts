import { describe, expect, test } from "bun:test";
import { parseSse } from "../src/upstream/sse-parse.ts";
import type { StreamEvent, UpstreamChunk } from "../src/wire/types.ts";

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
	const enc = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(c) {
			for (const p of parts) c.enqueue(enc.encode(p));
			c.close();
		},
	});
}

async function collect(
	stream: ReadableStream<Uint8Array>,
	warn?: (msg: string, fields?: Record<string, unknown>) => void,
): Promise<UpstreamChunk[]> {
	const out: UpstreamChunk[] = [];
	for await (const c of parseSse(stream, warn)) out.push(c);
	return out;
}

function eventsOf(chunks: UpstreamChunk[]): StreamEvent[] {
	return chunks.flatMap((c) => c.events);
}

describe("parseSse", () => {
	test("a frame split across two byte chunks parses once and correctly", async () => {
		const payload = JSON.stringify({
			id: "gen-1",
			model: "openai/gpt-x",
			choices: [{ index: 0, delta: { content: "hello" } }],
		});
		const wire = `data: ${payload}\n\n`;
		const mid = wire.indexOf('"mod'); // split mid-line, inside the JSON
		const chunks = await collect(streamOf([wire.slice(0, mid), wire.slice(mid)]));
		expect(chunks).toHaveLength(1);
		const events = chunks[0]!.events;
		expect(events).toContainEqual({ type: "start", servedSlug: "openai/gpt-x", generationId: "gen-1" });
		expect(events).toContainEqual({ type: "text", delta: "hello" });
	});

	test("keep-alive comments are ignored", async () => {
		const payload = JSON.stringify({ id: "gen-1", model: "m", choices: [{ delta: { content: "hi" } }] });
		const wire = `: OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\n\ndata: ${payload}\n\n: OPENROUTER PROCESSING\n\n`;
		const chunks = await collect(streamOf([wire]));
		expect(chunks).toHaveLength(1);
		expect(eventsOf(chunks).some((e) => e.type === "text")).toBe(true);
	});

	test("data: [DONE] terminates the stream with no chunk", async () => {
		const payload = JSON.stringify({ id: "gen-1", model: "m", choices: [{ delta: { content: "hi" } }] });
		const chunks = await collect(streamOf([`data: ${payload}\n\ndata: [DONE]\n\ndata: {"never":true}\n\n`]));
		expect(chunks).toHaveLength(1);
	});

	test("usage maps to UsageCounts without double-counting cached tokens", async () => {
		const payload = JSON.stringify({
			choices: [],
			usage: {
				prompt_tokens: 100,
				prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 10 },
				completion_tokens: 20,
				completion_tokens_details: { reasoning_tokens: 5 },
				cost: 0.0012,
			},
		});
		const chunks = await collect(streamOf([`data: ${payload}\n\n`]));
		const usage = eventsOf(chunks).find((e) => e.type === "usage");
		expect(usage).toEqual({
			type: "usage",
			usage: {
				promptTokens: 100, // includes the 40 cached; NOT 140
				cachedTokens: 40,
				cacheWriteTokens: 10,
				completionTokens: 20,
				reasoningTokens: 5,
				images: 0,
			},
			reportedCostUsd: 0.0012,
		});
	});

	test("usage without cost reports reportedCostUsd null", async () => {
		const payload = JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } });
		const chunks = await collect(streamOf([`data: ${payload}\n\n`]));
		const usage = eventsOf(chunks).find((e) => e.type === "usage");
		expect(usage).toMatchObject({ reportedCostUsd: null });
	});

	test("a malformed frame is skipped with a warning, not thrown", async () => {
		const good = JSON.stringify({ id: "gen-1", model: "m", choices: [{ delta: { content: "fine" } }] });
		const warnings: string[] = [];
		const chunks = await collect(
			streamOf([`data: {not json\n\ndata: ${good}\n\n`]),
			(msg) => warnings.push(msg),
		);
		expect(chunks).toHaveLength(1);
		expect(warnings).toHaveLength(1);
		expect(eventsOf(chunks)).toContainEqual({ type: "text", delta: "fine" });
	});

	test("tool-call argument fragments arrive as separate argsDelta events", async () => {
		const f1 = JSON.stringify({
			id: "gen-1",
			model: "m",
			choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } }] } }],
		});
		const f2 = JSON.stringify({
			choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] } }],
		});
		const chunks = await collect(streamOf([`data: ${f1}\n\ndata: ${f2}\n\n`]));
		expect(chunks).toHaveLength(2);
		expect(chunks[0]!.events).toContainEqual({
			type: "tool_call",
			index: 0,
			id: "call_1",
			name: "read",
			argsDelta: '{"pa',
		});
		// Second fragment supplies only arguments: no id, no name keys.
		expect(chunks[1]!.events).toEqual([{ type: "tool_call", index: 0, argsDelta: 'th":"x"}' }]);
	});

	test("reasoning deltas surface from whichever field the provider used", async () => {
		const r1 = JSON.stringify({ choices: [{ delta: { reasoning: "thinking " } }] });
		const r2 = JSON.stringify({ choices: [{ delta: { reasoning_content: "hard" } }] });
		const r3 = JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.text", text: " about it" }] } }] });
		const chunks = await collect(streamOf([`data: ${r1}\n\ndata: ${r2}\n\ndata: ${r3}\n\n`]));
		const reasoning = eventsOf(chunks)
			.filter((e): e is Extract<StreamEvent, { type: "reasoning" }> => e.type === "reasoning")
			.map((e) => e.delta);
		expect(reasoning).toEqual(["thinking ", "hard", " about it"]);
	});

	test("unknown finish reasons map to error", async () => {
		const payload = JSON.stringify({ choices: [{ delta: {}, finish_reason: "provider_exploded" }] });
		const chunks = await collect(streamOf([`data: ${payload}\n\n`]));
		expect(eventsOf(chunks)).toContainEqual({ type: "finish", reason: "error" });
	});
});
