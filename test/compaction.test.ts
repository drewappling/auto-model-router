import { describe, expect, test } from "bun:test";

import type { CompactionConfig } from "../src/config/types.ts";
import { planCompaction } from "../src/router/compaction.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";
import type { NormMessage } from "../src/wire/types.ts";

const CFG: CompactionConfig = {
	enabled: true,
	budgetTokens: 1,
	fitToWindow: false,
	protectRecentTurns: 2,
	maxToolResultBytes: 50,
	keepHeadBytes: 10,
	keepTailBytes: 10,
	elideSupersededReads: true,
	collapseDuplicateResults: true,
};

function user(text: string): NormMessage {
	return { role: "user", text, images: 0, textBytes: Buffer.byteLength(text), toolCalls: [] };
}
function asst(id: string, name: string, args: string): NormMessage {
	return { role: "assistant", text: "", images: 0, textBytes: 0, toolCalls: [{ id, name, argsJson: args }] };
}
function toolMsg(id: string, name: string, content: string): NormMessage {
	return { role: "tool", text: content, images: 0, textBytes: Buffer.byteLength(content), toolCalls: [], toolCallId: id, toolName: name };
}

// Two recent turns of padding so early tool results fall outside the protected window.
const PAD: NormMessage[] = [asst("z1", "bash", '{"command":"ls"}'), toolMsg("z1", "bash", "recent"), user("continue")];
const big = (marker: string): string => `${marker}:${"x".repeat(200)}`;

describe("planCompaction", () => {
	test("is a no-op when disabled", () => {
		const msgs = [user("go"), asst("c1", "read", '{"path":"a"}'), toolMsg("c1", "read", big("A")), ...PAD];
		expect(planCompaction(msgs, { ...CFG, enabled: false }, 0, 10_000).edits).toEqual([]);
	});

	test("truncates a large stale tool result, protecting recent turns", () => {
		const msgs = [
			user("go"),
			asst("c1", "read", '{"path":"a.ts"}'),
			toolMsg("c1", "read", big("OLD")), // eligible: outside the protected window
			asst("c2", "read", '{"path":"b.ts"}'),
			toolMsg("c2", "read", big("RECENT")), // within protectRecentTurns=2 → protected
			user("next"),
		];
		const { edits } = planCompaction(msgs, CFG, 1, 10_000);
		expect(edits).toHaveLength(1);
		expect(edits[0]?.index).toBe(2);
		expect(edits[0]?.mode).toBe("truncate");
	});

	test("collapses byte-identical duplicate results, keeping the last", () => {
		const msgs = [
			user("go"),
			asst("c1", "read", '{"path":"a.ts"}'),
			toolMsg("c1", "read", big("DUP")),
			asst("c2", "read", '{"path":"a.ts"}'),
			toolMsg("c2", "read", big("DUP")),
			...PAD,
		];
		const { edits } = planCompaction(msgs, { ...CFG, elideSupersededReads: false }, 10_000, 10_000);
		// Only the earlier identical copy is elided; the later one survives.
		expect(edits.map((e) => e.index)).toEqual([2]);
		expect(edits[0]?.mode).toBe("stub");
	});

	test("elides a read superseded by a newer call to the same resource", () => {
		const msgs = [
			user("go"),
			asst("c1", "read", '{"path":"a.ts"}'),
			toolMsg("c1", "read", big("V1")),
			asst("c2", "read", '{"path":"a.ts"}'),
			toolMsg("c2", "read", big("V2")), // different content, same path → supersedes c1
			...PAD,
		];
		const { edits } = planCompaction(msgs, { ...CFG, collapseDuplicateResults: false }, 10_000, 10_000);
		expect(edits.map((e) => e.index)).toEqual([2]);
		expect(edits[0]?.mode).toBe("stub");
	});

	test("different resources are not superseded", () => {
		const msgs = [
			user("go"),
			asst("c1", "read", '{"path":"a.ts"}'),
			toolMsg("c1", "read", "small"),
			asst("c2", "read", '{"path":"b.ts"}'),
			toolMsg("c2", "read", "small"),
			...PAD,
		];
		expect(planCompaction(msgs, CFG, 10_000, 10_000).edits).toEqual([]);
	});

	test("is deterministic and idempotent on stable input", () => {
		const msgs = [user("go"), asst("c1", "read", '{"path":"a.ts"}'), toolMsg("c1", "read", big("OLD")), ...PAD];
		const a = planCompaction(msgs, CFG, 1, 10_000);
		const b = planCompaction(msgs, CFG, 1, 10_000);
		expect(a).toEqual(b);
	});

	// The prompt-cache contract: an edit, once made, keeps its index and its keep
	// bytes for the rest of the conversation, and every later edit lands AFTER
	// it. Anything else rewrites already-cached history and forces a full
	// re-read of the prefix on the next turn.
	test("the edit set only ever extends forward as the conversation grows", () => {
		// Sizes GROW with age-descending order (newest results are the biggest), so
		// a size-ordered planner selects newest-first and its later additions move
		// BACKWARD into already-cached history. Equal-sized results would make
		// every ordering identical and the assertions vacuous.
		const loop = (pairs: number): NormMessage[] => {
			const msgs: NormMessage[] = [user("go")];
			for (let i = 0; i < pairs; i++) {
				const content = `R${i}:${"x".repeat(200 + i * 40)}`;
				msgs.push(asst(`c${i}`, "read", `{"path":"f${i}.ts"}`), toolMsg(`c${i}`, "read", content));
			}
			return msgs;
		};
		let previous: number[] = [];
		for (let pairs = 4; pairs <= 24; pairs++) {
			const msgs = loop(pairs);
			const promptBytes = msgs.reduce((n, m) => n + m.textBytes, 0);
			// A target the plan can hit with a handful of edits: this is where the
			// selection ORDER decides which results get truncated. A saturating
			// target would truncate everything and hide the difference.
			const indices = planCompaction(msgs, CFG, Math.floor(promptBytes * 0.8), promptBytes).edits.map((e) => e.index);
			// Nothing already compacted may be dropped...
			expect(indices).toEqual(expect.arrayContaining(previous));
			// ...and anything new lands after every existing edit.
			const added = indices.filter((i) => !previous.includes(i));
			if (previous.length > 0 && added.length > 0) {
				expect(Math.min(...added)).toBeGreaterThan(Math.max(...previous));
			}
			previous = indices;
		}
		expect(previous.length).toBeGreaterThan(4);
	});
});

describe("renderUpstreamBody applies compaction", () => {
	function bodyWith(messages: unknown[]): Record<string, unknown> {
		return { model: "auto", messages };
	}
	const MUT = {
		slug: "x/y",
		fallbacks: [],
		sessionId: "s",
		cacheBreakpointMessageIndices: [],
		reasoning: undefined,
		maxTokens: undefined,
		stripAssistantReasoning: false,
	};

	test("truncates content in place with a recoverable breadcrumb, preserving pairing", () => {
		const raw = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "c1", content: "HEAD" + "x".repeat(500) + "TAIL" },
		];
		const req = parseChatRequest(bodyWith(raw), new Headers());
		const out = req.renderUpstreamBody({ ...MUT, compactionPlan: [{ index: 2, mode: "truncate", keepHead: 4, keepTail: 4, note: "large read result" }] });
		const messages = out.messages as { role: string; content: unknown }[];
		expect(messages).toHaveLength(3); // no message removed → pairing intact
		const content = messages[2]?.content;
		expect(typeof content).toBe("string");
		expect(content as string).toContain("elided");
		expect(content as string).toContain("re-run the tool to restore");
		expect((content as string).length).toBeLessThan(510);
		expect(content as string).toStartWith("HEAD");
		expect(content as string).toEndWith("TAIL");
	});

	test("stub replaces the whole content with a breadcrumb", () => {
		const raw = [
			{ role: "user", content: "go" },
			{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
			{ role: "tool", tool_call_id: "c1", content: "a".repeat(300) },
		];
		const req = parseChatRequest(bodyWith(raw), new Headers());
		const out = req.renderUpstreamBody({ ...MUT, compactionPlan: [{ index: 2, mode: "stub", keepHead: 0, keepTail: 0, note: "identical repeated read result" }] });
		const messages = out.messages as { content: string }[];
		expect(messages[2]?.content).toBe("[omp-router: identical repeated read result elided to save context; re-run the tool to restore]");
	});
});
