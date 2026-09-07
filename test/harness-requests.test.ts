import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { canonicalTool, digestApplies } from "../src/server/digest.ts";
import { OPENAI_ONLY_PARAMS, parseChatRequest } from "../src/wire/openai/request.ts";
import type { UpstreamMutations } from "../src/wire/types.ts";
import { parsePolicy, shouldSend } from "../omp-extension/digest-logic.ts";

/**
 * Request shapes the config-only harnesses send to an OpenAI-compatible
 * endpoint, as each harness documents them: the router must parse them,
 * keep their tool calls and headers, and drop the OpenAI-platform-only
 * parameters before dispatch. These are representative bodies, not captured
 * traffic; a harness release that changes its shape belongs here as a new case.
 */

const MUT: UpstreamMutations = { slug: "x/y", fallbacks: [], sessionId: "s", cacheBreakpointMessageIndices: [], reasoning: undefined, maxTokens: undefined, stripAssistantReasoning: false };

const TOOL = (name: string) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: { path: { type: "string" } } } } });

const HARNESSES: Record<string, { headers: Record<string, string>; body: Record<string, unknown>; toolCall?: string }> = {
	codex: {
		headers: { "X-Omp-Harness": "codex" },
		body: {
			model: "auto",
			messages: [
				{ role: "developer", content: "You are Codex." },
				{ role: "user", content: "fix the failing test" },
				{ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: '{"command":["cat","x.ts"]}' } }] },
				{ role: "tool", tool_call_id: "call_1", content: "export const x = 1;" },
			],
			tools: [TOOL("shell"), TOOL("apply_patch")],
			stream: true,
			store: false,
			prompt_cache_key: "session-abc",
			reasoning_effort: "medium",
			parallel_tool_calls: false,
		},
		toolCall: "shell",
	},
	aider: {
		headers: { "X-Omp-Harness": "aider" },
		body: { model: "auto", messages: [{ role: "system", content: "Act as an expert software developer." }, { role: "user", content: "add a retry helper" }], stream: true, temperature: 0, extra_body: {} },
	},
	cline: {
		headers: { "X-Omp-Harness": "cline" },
		body: {
			model: "auto",
			messages: [
				{ role: "system", content: "You are Cline." },
				{ role: "user", content: [{ type: "text", text: "<task>rename the helper</task>" }] },
				{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"src/a.ts"}' } }] },
				{ role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "line 1\nline 2" }] },
			],
			tools: [TOOL("read_file"), TOOL("execute_command"), TOOL("search_files")],
			stream: true,
			stream_options: { include_usage: true },
			temperature: 0,
		},
		toolCall: "read_file",
	},
	opencode: {
		headers: { "X-Omp-Harness": "opencode" },
		body: {
			model: "auto",
			messages: [{ role: "system", content: "opencode" }, { role: "user", content: "list the tests" }],
			tools: [TOOL("read"), TOOL("bash"), TOOL("glob"), TOOL("webfetch")],
			stream: true,
			stream_options: { include_usage: true },
			max_tokens: 8192,
			service_tier: "auto",
		},
	},
	hermes: {
		headers: { "X-Omp-Harness": "hermes", "X-Omp-Session": "hermes-session-1", "X-Omp-Subagent": "1" },
		body: {
			model: "auto",
			messages: [
				{ role: "system", content: "You are Hermes." },
				{ role: "user", content: "summarise the repo" },
				{ role: "assistant", content: null, tool_calls: [{ id: "h1", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] },
				{ role: "tool", tool_call_id: "h1", content: '{"content":"# repo","path":"README.md"}' },
			],
			tools: [TOOL("read_file"), TOOL("terminal"), TOOL("search_files"), TOOL("delegate_task")],
			stream: true,
			max_tokens: 4096,
		},
		toolCall: "read_file",
	},
};

describe("config-only harness request shapes", () => {
	for (const [name, h] of Object.entries(HARNESSES)) {
		test(`${name}: parses, keeps headers and tool calls, and drops OpenAI-only parameters`, () => {
			const req = parseChatRequest(structuredClone(h.body), new Headers(h.headers));
			expect(req.harnessId).toBe(name);
			expect(req.requestedModel).toBe("auto");
			expect(req.messages.length).toBe((h.body.messages as unknown[]).length);
			if (h.toolCall !== undefined) {
				const assistant = req.messages.find((m) => m.role === "assistant");
				expect(assistant?.toolCalls[0]?.name).toBe(h.toolCall);
				expect(req.messages.find((m) => m.role === "tool")?.toolCallId).toBeDefined();
			}
			const out = req.renderUpstreamBody(MUT);
			for (const key of OPENAI_ONLY_PARAMS) expect(key in out).toBe(false);
			expect("stream_options" in out).toBe(false);
			expect(out.model).toBe("x/y");
			expect(out.stream).toBe(true);
			// Parameters every provider understands survive.
			if ("temperature" in h.body) expect(out.temperature).toBe(h.body.temperature);
			if ("tools" in h.body) expect((out.tools as unknown[]).length).toBe((h.body.tools as unknown[]).length);
		});
	}

	test("hermes headers carry session and subagent identity", () => {
		const req = parseChatRequest(structuredClone(HARNESSES.hermes!.body), new Headers(HARNESSES.hermes!.headers));
		expect(req.ompSessionId).toBe("hermes-session-1");
		expect(req.isSubagent).toBe(true);
	});
});

describe("digest tool aliases across harnesses", () => {
	const d = { ...DEFAULT_CONFIG.digest, enabled: true, minBytes: 10, maxBytes: 10_000 };
	test("harness spellings map onto the canonical tools list on both sides", () => {
		for (const [alias, canonical] of [["read_file", "read"], ["search_files", "grep"], ["terminal", "bash"], ["execute_command", "bash"], ["shell", "bash"], ["list_files", "ls"], ["web_extract", "web_fetch"], ["READ_FILE", "read"]] as const) {
			expect(canonicalTool(d, alias)).toBe(canonical);
			expect(digestApplies(d, alias, 500, false, "hard").ok).toBe(true);
		}
		expect(canonicalTool(d, "write_file")).toBe("write_file");
		expect(digestApplies(d, "write_file", 500, false, "hard").ok).toBe(false);
		// The policy the router publishes carries the aliases, and the client gate honours them.
		const policy = parsePolicy({ enabled: true, minBytes: 10, maxBytes: 10_000, tools: d.tools, toolAliases: d.toolAliases, fromTier: "moderate" });
		expect(shouldSend(policy, "search_files", false, "x".repeat(100), false)).toBe(true);
		expect(shouldSend(policy, "delegate_task", false, "x".repeat(100), false)).toBe(false);
		expect(parsePolicy({ enabled: true }).toolAliases).toEqual({});
	});
});
