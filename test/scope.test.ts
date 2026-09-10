import { describe, expect, test } from "bun:test";
import { ORIGIN_ENV, SCOPE_ENV, acceptOrigin, acceptScope, isOrigin, isScopeSlug, normalizeOrigin } from "../src/context/scope.ts";
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

describe("the origin a request may name", () => {
	test("normalizeOrigin reduces every remote form to host/path, and a local path to nothing", () => {
		// The same repository over https and ssh is one fingerprint.
		expect(normalizeOrigin("https://github.com/DrewAppling/omp-router.git")).toBe("github.com/drewappling/omp-router");
		expect(normalizeOrigin("git@github.com:drewappling/omp-router.git")).toBe("github.com/drewappling/omp-router");
		expect(normalizeOrigin("ssh://git@gitlab.example.com:2222/team/api/")).toBe("gitlab.example.com/team/api");
		// Credentials and the port never reach the value.
		expect(normalizeOrigin("https://user:p4ss@host.example:8443/a/b.git")).toBe("host.example/a/b");
		expect(normalizeOrigin("host.example:repo")).toBe("host.example/repo");
		expect(normalizeOrigin(" https://github.com/a/b/.git ")).toBe("github.com/a/b");
		// No host, no fingerprint: a local clone says nothing about the project.
		expect(normalizeOrigin("file:///e/projects/x")).toBe("");
		expect(normalizeOrigin("/local/path")).toBe("");
		expect(normalizeOrigin("C:\\path")).toBe("");
		expect(normalizeOrigin("C:\\Users\\drew\\repo")).toBe("");
		expect(normalizeOrigin("C:/path")).toBe("");
		expect(normalizeOrigin("https://github.com/")).toBe("");
		expect(normalizeOrigin("")).toBe("");
	});

	test("isOrigin: host/path only; the env-var sentinel never passes", () => {
		expect(isOrigin("github.com/drewappling/omp-router")).toBe(true);
		expect(isOrigin("gitlab.example.com/team/sub/api")).toBe(true);
		// omp sends the header's literal value when the variable it names is
		// unset: the NAME must never become a fingerprint.
		expect(isOrigin(ORIGIN_ENV)).toBe(false);
		expect(isOrigin("github.com")).toBe(false);
		expect(isOrigin("GitHub.com/a/b")).toBe(false);
		expect(isOrigin("https://github.com/a/b")).toBe(false);
		expect(isOrigin("github.com/a/b/")).toBe(false);
		expect(isOrigin("")).toBe(false);
	});

	test("acceptOrigin trims and rejects", () => {
		expect(acceptOrigin(" github.com/a/b ")).toBe("github.com/a/b");
		expect(acceptOrigin(ORIGIN_ENV)).toBe("");
		expect(acceptOrigin("https://github.com/a/b")).toBe("");
		expect(acceptOrigin(null)).toBe("");
	});

	test("the wire parser reads X-Agentdox-Origin by that rule and nothing else changes", () => {
		const body = { model: "auto", messages: [{ role: "user", content: "hi" }] };
		const parse = (h: Record<string, string>) => parseChatRequest(body, new Headers(h));
		expect(parse({ "x-agentdox-scope": "omp-router" }).agentdoxOrigin).toBe("");
		const both = parse({ "x-agentdox-scope": "omp-router", "x-agentdox-origin": "github.com/drewappling/omp-router" });
		expect(both.agentdoxScope).toBe("omp-router");
		expect(both.agentdoxOrigin).toBe("github.com/drewappling/omp-router");
		// The sentinel and a raw URL are dropped, never passed through.
		expect(parse({ "x-agentdox-origin": ORIGIN_ENV }).agentdoxOrigin).toBe("");
		expect(parse({ "x-agentdox-origin": "https://github.com/a/b" }).agentdoxOrigin).toBe("");
	});
});
