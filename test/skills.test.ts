import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectRemote } from "../src/cli/connect.ts";
import { fetchSkills, installSkills, parseSkillsBundle, readSkillsManifest, type SkillsBundle } from "../src/cli/skills.ts";

const NL = String.fromCharCode(10);
const bundle = (version: string, skills: Record<string, Record<string, string>>): SkillsBundle => ({ version, skills: Object.entries(skills).map(([name, files]) => ({ name, files })) });

describe("skills served by the remote, installed by connect", () => {
	test("a bundle is parsed defensively", async () => {
		expect(parseSkillsBundle({ version: "v1", skills: [{ name: "team-context", files: { "SKILL.md": "# x" } }] })?.skills[0]?.name).toBe("team-context");
		expect(parseSkillsBundle({ version: "v1", skills: [{ name: "Bad Name", files: { "SKILL.md": "# x" } }] })).toBeNull();
		expect(parseSkillsBundle({ version: "v1", skills: [{ name: "ok", files: { "notes.md": "x" } }] })).toBeNull(); // no SKILL.md
		expect(parseSkillsBundle({ version: "v1", skills: [{ name: "ok", files: { "../escape.md": "x", "SKILL.md": "y" } }] })).toBeNull();
		expect(parseSkillsBundle({ version: "", skills: [] })).toBeNull();
		expect(parseSkillsBundle("nope")).toBeNull();
	});

	test("install writes each skill into each target, updates in place, removes what is gone, and leaves a member's own skill alone", async () => {
		const home = mkdtempSync(join(tmpdir(), "amr-skills-"));
		const rh = join(home, ".auto-model-router");
		const claude = join(home, ".claude", "skills");
		const omp = join(home, ".omp", "agent", "skills");
		try {
			const targets = [
				{ harness: "Claude Code", dir: claude },
				{ harness: "omp", dir: omp },
			];
			// The member already has their own "router" skill in Claude Code.
			mkdirSync(join(claude, "router"), { recursive: true });
			writeFileSync(join(claude, "router", "SKILL.md"), "mine", "utf8");
			const v1 = bundle("v1", { "team-context": { "SKILL.md": `# ctx v1${NL}`, "notes/extra.md": "extra" }, router: { "SKILL.md": "# router v1" } });
			const r1 = installSkills(v1, targets, rh);
			expect(r1.placed).toEqual(["Claude Code: team-context", "omp: team-context", "omp: router"]);
			expect(r1.skipped).toHaveLength(1);
			expect(r1.skipped[0]).toContain("Claude Code: router");
			expect(readFileSync(join(claude, "router", "SKILL.md"), "utf8")).toBe("mine");
			expect(readFileSync(join(omp, "router", "SKILL.md"), "utf8")).toBe("# router v1");
			expect(readFileSync(join(claude, "team-context", "notes", "extra.md"), "utf8")).toBe("extra");
			expect(readSkillsManifest(rh)?.version).toBe("v1");
			expect(readSkillsManifest(rh)?.files).toHaveLength(5);

			// v2 drops the extra file and the router skill; team-context changes.
			const v2 = bundle("v2", { "team-context": { "SKILL.md": `# ctx v2${NL}` } });
			const r2 = installSkills(v2, targets, rh);
			expect(r2.placed).toEqual(["Claude Code: team-context", "omp: team-context"]);
			expect(readFileSync(join(omp, "team-context", "SKILL.md"), "utf8")).toBe(`# ctx v2${NL}`);
			expect(existsSync(join(claude, "team-context", "notes", "extra.md"))).toBe(false);
			expect(existsSync(join(omp, "router"))).toBe(false); // ours, now gone, directory and all
			expect(readFileSync(join(claude, "router", "SKILL.md"), "utf8")).toBe("mine"); // theirs, untouched
			expect(r2.removed).toHaveLength(3);
			expect(readSkillsManifest(rh)?.files).toHaveLength(2);

			// Dry run touches nothing.
			const r3 = installSkills(bundle("v3", { fresh: { "SKILL.md": "x" } }), targets, rh, true);
			expect(r3.placed).toHaveLength(2);
			expect(existsSync(join(omp, "fresh"))).toBe(false);
			expect(readSkillsManifest(rh)?.version).toBe("v2");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("fetchSkills: a remote without skills is silent, an unreachable one is a note, never an error", async () => {
		const gone = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
		expect(await fetchSkills("https://t", "k", gone)).toEqual({ bundle: null });
		const seen: string[] = [];
		const ok = (async (url: string | URL | Request, init?: RequestInit) => {
			seen.push(`${String(url)} ${(init?.headers as Record<string, string>).authorization}`);
			return Response.json({ version: "v9", skills: [{ name: "team-context", files: { "SKILL.md": "# hi" } }] });
		}) as unknown as typeof fetch;
		expect((await fetchSkills("https://t", "amrt_k", ok)).bundle?.version).toBe("v9");
		expect(seen[0]).toBe("https://t/setup/skills Bearer amrt_k");
		const down = (async () => {
			throw new Error("connect ECONNREFUSED");
		}) as unknown as typeof fetch;
		const r = await fetchSkills("https://t", "k", down);
		expect(r.bundle).toBeNull();
		expect(r.note).toContain("ECONNREFUSED");
		const odd = (async () => Response.json({ version: "v1", skills: "?" })) as unknown as typeof fetch;
		expect((await fetchSkills("https://t", "k", odd)).note).toContain("not understood");
	});

	test("connect installs the bundle only into the harnesses it configured", async () => {
		const home = mkdtempSync(join(tmpdir(), "amr-skills-connect-"));
		mkdirSync(join(home, ".claude"), { recursive: true });
		const agent = join(home, ".omp", "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "config.yml"), `extensions: []${NL}`, "utf8");
		const rh = join(home, ".auto-model-router");
		const env = { HOME: home, PI_CODING_AGENT_DIR: agent, AUTO_MODEL_ROUTER_HOME: rh, HERMES_HOME: join(home, "no-hermes") };
		try {
			const skills = bundle("s1", { "team-context": { "SKILL.md": "# team" } });
			const r = connectRemote({ url: "https://team.example", key: "amrt_k", userId: "u", name: "Ada", profile: false, dryRun: false, only: ["omp", "claude"], env, home, packageDir: "/pkg", skills, platform: "linux", pathHas: () => false });
			expect(r.skills?.placed).toEqual(["omp: team-context", "Claude Code: team-context"]);
			expect(readFileSync(join(agent, "skills", "team-context", "SKILL.md"), "utf8")).toBe("# team");
			expect(readFileSync(join(home, ".claude", "skills", "team-context", "SKILL.md"), "utf8")).toBe("# team");
			expect(r.configured.some((c) => c.startsWith("skills s1 ("))).toBe(true);
			// Only Claude Code asked for: omp's directory is not created.
			rmSync(join(agent, "skills"), { recursive: true, force: true });
			const r2 = connectRemote({ url: "https://team.example", key: "amrt_k", userId: "u", name: "Ada", profile: false, dryRun: false, only: ["claude"], env, home, packageDir: "/pkg", skills, platform: "linux", pathHas: () => false });
			expect(r2.skills?.placed).toEqual(["Claude Code: team-context"]);
			expect(existsSync(join(agent, "skills"))).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
