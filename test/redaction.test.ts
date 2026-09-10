import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import { loadConfig } from "../src/config/load.ts";
import { compileRedactionRules, redactionRulesFor, validateRedactionPattern, validateRedactionRule } from "../src/config/redaction.ts";
import { createLedger } from "../src/cost/ledger.ts";
import { buildUsageReport, renderUsageReport } from "../src/cost/report.ts";
import { EMPTY_USAGE, type LedgerEntry } from "../src/cost/types.ts";
import { redactUpstreamBody } from "../src/server/redact.ts";
import { openDb } from "../src/util/sqlite.ts";
import { parseMessagesRequest } from "../src/wire/anthropic/messages.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";
import { parseResponsesRequest } from "../src/wire/openai/responses.ts";

/**
 * Redaction: what the guard refuses to run, what the walker actually removes,
 * and the count the ledger keeps as evidence without keeping the secret.
 */

const SECRET = "sk-live-4f9a2b7c1d8e3f6a0b5c";

function rules(...specs: { name: string; pattern: string; replacement?: string }[]) {
	return compileRedactionRules(specs);
}

describe("pattern guard", () => {
	test("the shapes a real rule uses all compile", () => {
		for (const pattern of [
			"sk-live-[a-z0-9]{16,}",
			"AKIA[0-9A-Z]{16}",
			"(?:\\d{1,3}\\.){3}\\d{1,3}", // a quantified group, but BOUNDED
			"[\\w.+-]+@corp\\.example\\.com",
			"-----BEGIN [A-Z ]+PRIVATE KEY-----",
			"(?:acct|customer)-\\d{6}", // an alternation, but not under an unbounded quantifier
		]) {
			expect(validateRedactionPattern(pattern)).toBeNull();
		}
	});

	test("a pattern that can backtrack catastrophically is refused, with the reason", () => {
		const nested = validateRedactionPattern("(a+)+$");
		expect(nested).toContain("nested unbounded quantifiers");
		expect(nested).toContain("exponential");
		// The same shape spelled with a brace quantifier, and with `*`.
		expect(validateRedactionPattern("(\\d{2,})*")).toContain("nested unbounded quantifiers");
		expect(validateRedactionPattern("([a-z]*)+x")).toContain("nested unbounded quantifiers");
		// The other classic: branches that can match the same input many ways.
		expect(validateRedactionPattern("(?:a|a)*b")).toContain("alternation inside an unbounded quantifier");
		// And the shape no linear-time strategy exists for at all.
		expect(validateRedactionPattern("(secret)\\1")).toContain("backreferences");
		expect(validateRedactionPattern("(?<k>x)\\k<k>")).toContain("backreferences");
	});

	test("a pattern that cannot compile, is empty, matches nothing, or is enormous is refused", () => {
		expect(validateRedactionPattern("(unclosed")).toContain("does not compile");
		expect(validateRedactionPattern("")).toBe("pattern must not be empty");
		expect(validateRedactionPattern("x*")).toContain("matches the empty string");
		expect(validateRedactionPattern(`a${"b".repeat(600)}`)).toContain("the limit is 512");
	});

	test("a legacy pattern the unicode flag alone rejects still loads", () => {
		// `\d{1,2}` is fine either way; an unescaped `{` is a syntax error under
		// `u` and a literal brace without it. An operator's working rule must not
		// break on an upgrade, so `u` is preferred, not required.
		expect(validateRedactionPattern("token{[0-9]+}")).toBeNull();
		expect(rules({ name: "brace", pattern: "token{[0-9]+}" })[0]!.regex.flags).toBe("g");
		expect(rules({ name: "unicode", pattern: "sk-[a-z0-9]+" })[0]!.regex.flags).toBe("gu");
	});

	test("a rule name is checked too, since it is echoed into the prompt", () => {
		expect(validateRedactionRule({ name: "api key", pattern: "sk-\\w+" })).toBeNull();
		expect(validateRedactionRule({ name: "", pattern: "sk-\\w+" })).toContain("name must be");
		expect(validateRedactionRule({ name: "[redacted]\ninjected", pattern: "sk-\\w+" })).toContain("name must be");
	});

	test("compiling a rule set names the offending rule and refuses the whole set", () => {
		expect(() => rules({ name: "ok", pattern: "sk-\\w+" }, { name: "greedy", pattern: "(x+)+" })).toThrow(
			/redaction rule "greedy": nested unbounded quantifiers/,
		);
	});

	test("the config file rejects a backtracking rule at load, naming its path", () => {
		const dir = mkdtempSync(join(tmpdir(), "amr-redact-"));
		try {
			const path = join(dir, "config.yml");
			writeFileSync(path, `redaction:\n  enabled: true\n  rules:\n    - name: bad\n      pattern: "(a+)+b"\n`, "utf8");
			expect(() => loadConfig({ path })).toThrow(/redaction\.rules\.0.*nested unbounded quantifiers/s);
			writeFileSync(path, `redaction:\n  enabled: true\n  rules:\n    - name: key\n      pattern: "sk-[a-z0-9-]{8,}"\n`, "utf8");
			const cfg = loadConfig({ path });
			expect(cfg.redaction.enabled).toBe(true);
			expect(cfg.redaction.rules).toEqual([{ name: "key", pattern: "sk-[a-z0-9-]{8,}" }]);
			// Unset by the file, so the default stands: tools are not scanned.
			expect(cfg.redaction.scanTools).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("compiled rules are memoised on the rule text, and off means none", () => {
		const cfg = { enabled: true, rules: [{ name: "key", pattern: "sk-\\w+" }], scanTools: false };
		expect(redactionRulesFor(cfg)).toBe(redactionRulesFor({ ...cfg, rules: [{ name: "key", pattern: "sk-\\w+" }] }));
		expect(redactionRulesFor({ ...cfg, enabled: false })).toEqual([]);
		expect(redactionRulesFor({ ...cfg, rules: [] })).toEqual([]);
		// An edited pattern is a different rule set, not a cache hit.
		expect(redactionRulesFor({ ...cfg, rules: [{ name: "key", pattern: "sk-\\d+" }] })[0]!.regex.source).toBe("sk-\\d+");
	});
});

describe("each rule shape", () => {
	const body = () => ({ messages: [{ role: "user", content: `token ${SECRET} and 10.1.2.3` }] });

	test("a rule with no replacement redacts to [redacted:<name>]", () => {
		const b = body();
		expect(redactUpstreamBody(b, rules({ name: "api key", pattern: "sk-live-[a-z0-9]+" }), { scanTools: false })).toBe(1);
		expect(b.messages[0]!.content).toBe("token [redacted:api key] and 10.1.2.3");
	});

	test("a rule with a replacement uses it", () => {
		const b = body();
		redactUpstreamBody(b, rules({ name: "ip", pattern: "(?:\\d{1,3}\\.){3}\\d{1,3}", replacement: "0.0.0.0" }), { scanTools: false });
		expect(b.messages[0]!.content).toBe(`token ${SECRET} and 0.0.0.0`);
	});

	test("several rules all apply, and every match counts", () => {
		const b = { messages: [{ role: "user", content: `${SECRET} ${SECRET} 10.1.2.3` }] };
		const n = redactUpstreamBody(
			b,
			rules({ name: "key", pattern: "sk-live-[a-z0-9]+" }, { name: "ip", pattern: "(?:\\d{1,3}\\.){3}\\d{1,3}" }),
			{ scanTools: false },
		);
		expect(n).toBe(3);
		expect(b.messages[0]!.content).toBe("[redacted:key] [redacted:key] [redacted:ip]");
	});

	test("nothing to match leaves the body untouched and counts zero", () => {
		const b = { messages: [{ role: "user", content: "nothing secret here" }] };
		expect(redactUpstreamBody(b, rules({ name: "key", pattern: "sk-live-[a-z0-9]+" }), { scanTools: false })).toBe(0);
		expect(b.messages[0]!.content).toBe("nothing secret here");
	});
});

describe("what the walker reaches", () => {
	const KEY = rules({ name: "key", pattern: "sk-live-[a-z0-9]+" });

	function fullBody(): Record<string, unknown> {
		return {
			model: "sk-live-notreally/model", // a slug is not conversation content
			messages: [
				{ role: "system", content: [{ type: "text", text: `system ${SECRET}`, cache_control: { type: "ephemeral" } }] },
				{ role: "user", content: `user ${SECRET}` },
				{ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: `{"path":"${SECRET}"}` } }] },
				{ role: "tool", tool_call_id: "c1", content: `result ${SECRET}` },
			],
		};
	}

	test("message text is redacted; tool arguments and tool results wait for scanTools", () => {
		const b = fullBody();
		expect(redactUpstreamBody(b, KEY, { scanTools: false })).toBe(2);
		const messages = b.messages as Record<string, unknown>[];
		expect((messages[0]!.content as { text: string }[])[0]!.text).toBe("system [redacted:key]");
		// The cache breakpoint the router planted survives the rewrite.
		expect((messages[0]!.content as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: "ephemeral" });
		expect(messages[1]!.content).toBe("user [redacted:key]");
		expect(JSON.stringify(messages[2])).toContain(SECRET);
		expect(messages[3]!.content).toBe(`result ${SECRET}`);
		// A model slug is the router's own vocabulary, never scanned.
		expect(b.model).toBe("sk-live-notreally/model");
	});

	test("with scanTools, arguments and results go too and nothing else changes", () => {
		const b = fullBody();
		expect(redactUpstreamBody(b, KEY, { scanTools: true })).toBe(4);
		const messages = b.messages as Record<string, unknown>[];
		expect(JSON.stringify(b)).not.toContain(SECRET);
		const call = (messages[2]!.tool_calls as { id: string; function: { name: string; arguments: string } }[])[0]!;
		// The call/result pairing the model needs is untouched.
		expect(call.id).toBe("c1");
		expect(call.function.name).toBe("read");
		expect(call.function.arguments).toBe('{"path":"[redacted:key]"}');
		expect(messages[3]!.tool_call_id).toBe("c1");
	});

	test("no rules is a no-op, and a body without messages is ignored", () => {
		const b = fullBody();
		expect(redactUpstreamBody(b, [], { scanTools: true })).toBe(0);
		expect(JSON.stringify(b)).toContain(SECRET);
		expect(redactUpstreamBody({ model: "x" }, KEY, { scanTools: true })).toBe(0);
	});
});

describe("every wire renders into the shape redaction reads", () => {
	const KEY = rules({ name: "key", pattern: "sk-live-[a-z0-9]+" });
	const mutations = {
		slug: "vendor/model",
		fallbacks: [],
		sessionId: "s",
		cacheBreakpointMessageIndices: [],
		reasoning: undefined,
		maxTokens: undefined,
		stripAssistantReasoning: false,
	};

	test("chat completions, Responses and Anthropic Messages all lose the secret", () => {
		const chat = parseChatRequest(
			{ model: "auto", messages: [{ role: "system", content: `rules ${SECRET}` }, { role: "user", content: `use ${SECRET}` }] },
			new Headers(),
		);
		const responses = parseResponsesRequest(
			{ model: "auto", instructions: `rules ${SECRET}`, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: `use ${SECRET}` }] }] },
			new Headers(),
		);
		const messages = parseMessagesRequest(
			{ model: "claude-opus-5", max_tokens: 100, system: `rules ${SECRET}`, messages: [{ role: "user", content: [{ type: "text", text: `use ${SECRET}` }] }] },
			new Headers(),
		);
		for (const req of [chat, responses, messages]) {
			const body = req.renderUpstreamBody(mutations);
			expect(JSON.stringify(body)).toContain(SECRET);
			expect(redactUpstreamBody(body, KEY, { scanTools: false })).toBe(2);
			expect(JSON.stringify(body)).not.toContain(SECRET);
		}
	});
});

describe("the ledger keeps the count and never the match", () => {
	function entry(over: Partial<LedgerEntry>): LedgerEntry {
		return {
			id: crypto.randomUUID(),
			createdAtMs: Date.now(),
			conversationKey: "conv",
			sessionId: "sess",
			turn: 1,
			requestedModel: "auto",
			harnessId: "",
			ompSessionId: "",
			slug: "a/b",
			servedSlug: "a/b",
			tier: "simple",
			classificationSource: "heuristic",
			reasons: [],
			features: null,
			score: null,
			confidence: null,
			task: null,
			classifierReasons: null,
			exploredFrom: null,
			holdArm: null,
			predictedUsd: 0.001,
			reportedUsd: 0.001,
			usage: { ...EMPTY_USAGE, promptTokens: 100, completionTokens: 10 },
			attempt: 0,
			escalationSignal: null,
			latencyMs: 10,
			ttftMs: 5,
			finishReason: "stop",
			wasted: false,
			upstreamGenerationId: null,
			error: null,
			promptTokensSaved: 0,
			...over,
		};
	}

	test("the column round-trips, absent stays absent, and the report totals it", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, { ...DEFAULT_CONFIG, ledger: { ...DEFAULT_CONFIG.ledger, path: ":memory:" } });
			const now = Date.now();
			ledger.record(entry({ createdAtMs: now - 3, redactions: 3 }));
			ledger.record(entry({ createdAtMs: now - 2, redactions: 0 }));
			ledger.record(entry({ createdAtMs: now - 1 })); // redaction off: NULL, which is not 0
			const recorded = ledger.recentEntries(10);
			expect(recorded.map((e) => e.redactions)).toEqual([undefined, 0, 3]);
			const totals = buildUsageReport(db, { windowDays: 7 }).totals;
			expect(totals.redactions).toBe(3);
			expect(totals.redactedTurns).toBe(1);
			expect(renderUsageReport(buildUsageReport(db, { windowDays: 7 }))).toContain("redaction: 1 turns had something removed (3 strings)");
		} finally {
			db.close();
		}
	});

	test("a window with no redaction says nothing about it", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, { ...DEFAULT_CONFIG, ledger: { ...DEFAULT_CONFIG.ledger, path: ":memory:" } });
			ledger.record(entry({}));
			const report = buildUsageReport(db, { windowDays: 7 });
			expect(report.totals.redactions).toBe(0);
			expect(report.totals.redactedTurns).toBe(0);
			expect(renderUsageReport(report)).not.toContain("redaction:");
		} finally {
			db.close();
		}
	});
});
