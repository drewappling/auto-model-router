import { describe, expect, test } from "bun:test";

import { MAX_QUERY_CHARS, relevanceQuery, userContent } from "../src/context/query.ts";

/**
 * The agentdox relevance query must be the user's ask, not omp's wrappers:
 * live blocks were queried with `<chat>`, `<system-reminder>` and an image
 * notice, re-ranking memory against noise on every refresh.
 */

const msg = (role: "user" | "assistant" | "system" | "tool", text: string) => ({ role, text }) as never;

describe("userContent", () => {
	test("strips wrapper elements and keeps the user's words", async () => {
		expect(userContent("<system-reminder>\n5 todo items still open.\n</system-reminder>\nplease fix the water tests")).toBe("please fix the water tests");
		expect(userContent("<recap>User stepped away; returning.</recap>")).toBe("");
		expect(userContent("<system-notice>Background job bg_43 completed.</system-notice>")).toBe("");
	});

	test("an unclosed wrapper at the start is all machinery", async () => {
		expect(userContent("<chat>\nassistant said things\nuser said things")).toBe("");
		expect(userContent("<system-reminder>Today: 2026-09-07")).toBe("");
	});

	test("auto-generated stubs are not content", async () => {
		expect(userContent("Attached image(s) from tool result:")).toBe("");
		expect(userContent("(no output)")).toBe("");
		expect(userContent("continue")).toBe("");
	});

	test("ordinary text passes through with whitespace collapsed", async () => {
		expect(userContent("  why does   the\n\nrouter pick glm?  ")).toBe("why does the router pick glm?");
	});
});

describe("relevanceQuery", () => {
	test("takes the last user message with real content, skipping wrapper-only turns", async () => {
		const req = {
			messages: [
				msg("system", "You are omp."),
				msg("user", "add a /router command with reports"),
				msg("assistant", "done"),
				msg("user", "<system-reminder>5 todo items still open.</system-reminder>"),
				msg("tool", "Attached image(s) from tool result:"),
				msg("user", "Attached image(s) from tool result:"),
			],
		};
		expect(relevanceQuery(req)).toBe("add a /router command with reports");
	});

	test("prefers the newest real ask over the opening one", async () => {
		const req = { messages: [msg("user", "first ask"), msg("assistant", "ok"), msg("user", "<recap>x</recap> now fix the report window")] };
		expect(relevanceQuery(req)).toBe("now fix the report window");
	});

	test("caps long asks so the block header stays a line", async () => {
		const long = "x".repeat(5_000);
		const q = relevanceQuery({ messages: [msg("user", long)] });
		expect(q.length).toBe(MAX_QUERY_CHARS);
		expect(q.endsWith("…")).toBe(true);
	});

	test("nothing usable yields an empty query", async () => {
		expect(relevanceQuery({ messages: [msg("user", "<chat>\nlog"), msg("assistant", "hi")] })).toBe("");
		expect(relevanceQuery({ messages: [] })).toBe("");
	});
});
