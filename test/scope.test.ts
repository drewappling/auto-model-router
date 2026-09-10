import { describe, expect, test } from "bun:test";
import { SCOPE_ENV, acceptScope, isScopeSlug } from "../src/context/scope.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";

describe("the scope a request may name", () => {
	test("a slug passes; the env-var sentinel and other non-slugs do not", () => {
		expect(isScopeSlug("omp-router")).toBe(true);
		expect(isScopeSlug("ashlands")).toBe(true);
		expect(isScopeSlug("my.app_v2")).toBe(true);
		// omp sends the header's literal value when the variable it names is
		// unset: the NAME must never become a project.
		expect(isScopeSlug(SCOPE_ENV)).toBe(false);
		expect(isScopeSlug("")).toBe(false);
		expect(isScopeSlug("-leading")).toBe(false);
		expect(isScopeSlug("Has Spaces")).toBe(false);
		expect(isScopeSlug("a".repeat(129))).toBe(false);
	});

	test("acceptScope trims and rejects", () => {
		expect(acceptScope(" omp-router ")).toBe("omp-router");
		expect(acceptScope(SCOPE_ENV)).toBe("");
		expect(acceptScope(null)).toBe("");
	});

	test("the wire parser drops a non-slug X-Agentdox-Scope", () => {
		const body = { model: "auto", messages: [{ role: "user", content: "hi" }] };
		const parse = (scope: string) => parseChatRequest(body, new Headers({ "x-agentdox-scope": scope }));
		expect(parse("omp-router").agentdoxScope).toBe("omp-router");
		expect(parse(SCOPE_ENV).agentdoxScope).toBe("");
	});

	test("the wire parser reads X-Agentdox-Group and X-Agentdox-Personal by the same rule", () => {
		// A team front door names the group-context and personal scopes; a
		// lone router never sees the headers and must end up with empties, so
		// nothing new is sent to agentdox.
		const body = { model: "auto", messages: [{ role: "user", content: "hi" }] };
		const parse = (h: Record<string, string>) => parseChatRequest(body, new Headers(h));
		const none = parse({ "x-agentdox-scope": "omp-router" });
		expect(none.agentdoxGroup).toBe("");
		expect(none.agentdoxPersonal).toBe("");
		const both = parse({ "x-agentdox-scope": "omp-router", "x-agentdox-group": " group.g1 ", "x-agentdox-personal": "omp-router.u.u_ada" });
		expect(both.agentdoxGroup).toBe("group.g1");
		expect(both.agentdoxPersonal).toBe("omp-router.u.u_ada");
		// Not slugs: dropped, never passed through.
		const bad = parse({ "x-agentdox-group": "Has Spaces", "x-agentdox-personal": SCOPE_ENV });
		expect(bad.agentdoxGroup).toBe("");
		expect(bad.agentdoxPersonal).toBe("");
		// Layers without a project scope are still parsed; the turn decides what to do.
		expect(parse({ "x-agentdox-group": "group.g1" }).agentdoxGroup).toBe("group.g1");
	});
});
