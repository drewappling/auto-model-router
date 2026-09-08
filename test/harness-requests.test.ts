import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { canonicalTool, digestApplies } from "../src/server/digest.ts";
import { OPENAI_ONLY_PARAMS, parseChatRequest } from "../src/wire/openai/request.ts";
import type { UpstreamMutations } from "../src/wire/types.ts";
import { parsePolicy, shouldSend } from "../omp-extension/digest-logic.ts";
import { RESPONSES_ONLY_PARAMS, parseResponsesRequest } from "../src/wire/openai/responses.ts";

/**
 * Request shapes other harnesses send: the router must parse them, keep their
 * tool calls and headers, and drop the OpenAI-platform-only parameters before
 * dispatch. The first block holds representative bodies for harnesses that
 * could not be run here (Cline/Roo/Kilo) or that illustrate a header set; the
 * second block parses requests actually captured with tools/capture-proxy.ts
 * (Aider, OpenCode, Codex). A harness release that changes its shape belongs
 * here as a refreshed capture.
 */

const MUT: UpstreamMutations = { slug: "x/y", fallbacks: [], sessionId: "s", cacheBreakpointMessageIndices: [], reasoning: undefined, maxTokens: undefined, stripAssistantReasoning: false };

const TOOL = (name: string) => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: { path: { type: "string" } } } } });

const HARNESSES: Record<string, { headers: Record<string, string>; body: Record<string, unknown>; toolCall?: string }> = {
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

/** A request a harness actually sent, captured with tools/capture-proxy.ts (bodies trimmed, ids scrubbed). */
async function fixture(name: string): Promise<{ headers: Record<string, string>; body: Record<string, unknown> }> {
	return (await Bun.file(`${import.meta.dir}/fixtures/harness/${name}.json`).json()) as { headers: Record<string, string>; body: Record<string, unknown> };
}

describe("captured harness requests", () => {
	test("aider 0.86: plain chat completions, no tools, no harness header", async () => {
		const f = await fixture("aider");
		const req = parseChatRequest(structuredClone(f.body), new Headers(f.headers));
		expect(f.headers["user-agent"]).toContain("OpenAI/Python");
		expect(req.harnessId).toBe("");
		expect(req.stream).toBe(true);
		expect(req.tools).toHaveLength(0);
		expect(req.messages[0]?.role).toBe("system");
		expect(req.renderUpstreamBody(MUT).model).toBe("x/y");
	});

	test("opencode 1.18: chat completions with tools, stream options and the harness header", async () => {
		const f = await fixture("opencode");
		const req = parseChatRequest(structuredClone(f.body), new Headers(f.headers));
		expect(req.harnessId).toBe("opencode");
		expect(req.tools.length).toBeGreaterThan(5);
		expect(req.tools.map((t) => t.name)).toContain("read");
		const out = req.renderUpstreamBody(MUT);
		expect("stream_options" in out).toBe(false);
		expect(out.max_tokens).toBe(f.body.max_tokens);
	});

	test("cline cli 3.0: chat completions with native tool calls, no harness header", async () => {
		const f = await fixture("cline-cli");
		const req = parseChatRequest(structuredClone(f.body), new Headers(f.headers));
		expect(f.headers["user-agent"]).toContain("ai-sdk/openai-compatible");
		expect(req.harnessId).toBe("");
		const names = req.tools.map((t) => t.name);
		for (const n of ["read_files", "search_codebase", "run_commands", "fetch_web_content"]) {
			expect(names).toContain(n);
			expect(DEFAULT_CONFIG.digest.tools).toContain(canonicalTool(DEFAULT_CONFIG.digest, n));
		}
		expect("stream_options" in req.renderUpstreamBody(MUT)).toBe(false);
	});

	test("kilo cli 7.5: an OpenCode-derived request with the harness header and OpenCode tool names", async () => {
		const f = await fixture("kilo");
		const req = parseChatRequest(structuredClone(f.body), new Headers(f.headers));
		expect(f.headers["user-agent"]).toContain("Kilo-Code");
		expect(req.harnessId).toBe("kilo");
		const names = req.tools.map((t) => t.name);
		for (const n of ["read", "grep", "glob", "bash", "webfetch"]) expect(names).toContain(n);
	});

	test("roo code 3.54 (VS Code): native tool calls with a tool round trip and the harness header", async () => {
		const f = await fixture("roo");
		const req = parseChatRequest(structuredClone(f.body), new Headers(f.headers));
		expect(f.headers["user-agent"]).toContain("RooCode");
		expect(req.harnessId).toBe("roo");
		const names = req.tools.map((t) => t.name);
		for (const n of ["read_file", "search_files", "list_files", "apply_diff", "attempt_completion"]) expect(names).toContain(n);
		expect(req.messages.some((m) => m.role === "tool")).toBe(true);
		expect(req.messages.find((m) => m.role === "assistant" && m.toolCalls.length > 0)).toBeDefined();
		expect("stream_options" in req.renderUpstreamBody(MUT)).toBe(false);
	});

	test("codex 0.153: Responses API body translates to a routed chat request", async () => {
		const f = await fixture("codex-responses");
		const req = parseResponsesRequest(structuredClone(f.body), new Headers(f.headers));
		expect(req.protocol).toBe("openai-responses");
		expect(req.harnessId).toBe("codex");
		expect(req.requestedModel).toBe("auto");
		expect(req.stream).toBe(true);
		// The thread id in the body becomes the session id; the root agent is not a subagent.
		expect(req.ompSessionId).toBe((f.body.client_metadata as { thread_id: string }).thread_id);
		expect(req.isSubagent).toBe(false);
		// instructions became the system message; the input items follow in order.
		expect(req.messages.map((m) => m.role)).toEqual(["system", "developer", "user", "user"]);
		expect(req.messages[0]?.text).toContain("coding agent running in the Codex CLI");
		expect(req.tools.map((t) => t.name)).toContain("exec_command");
		const out = req.renderUpstreamBody(MUT);
		for (const key of RESPONSES_ONLY_PARAMS) expect(key in out).toBe(false);
		expect(Array.isArray(out.messages)).toBe(true);
		expect((out.tools as { function: { name: string } }[])[0]?.function.name).toBe("exec_command");
		expect(out.parallel_tool_calls).toBe(true);
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
