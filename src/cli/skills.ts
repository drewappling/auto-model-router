/**
 * Skills served by a remote router, installed by `connect`.
 *
 * A coding agent is only as good as the instructions it carries, and a team
 * has instructions it wants every member's agent to have: how its shared
 * context works, how to use the router well. The remote serves them as one
 * versioned bundle (`GET <url>/setup/skills`, with the member key), and
 * `connect` writes them into every harness it configures that reads a
 * user-level skills directory — Claude Code's `~/.claude/skills`, omp's
 * `~/.omp/agent/skills`. A manifest under the router home records what was
 * placed, so an update removes what the bundle no longer carries and a skill
 * the member wrote themselves under the same name is never touched.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface SkillsBundle {
	/** Changes whenever any file changes; what `connect` reports and remembers. */
	version: string;
	skills: { name: string; files: Record<string, string> }[];
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const REL = /^(?!\.)(?!.*\/\.)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** Parses a bundle defensively: a malformed one installs nothing rather than something odd. */
export function parseSkillsBundle(value: unknown): SkillsBundle | null {
	if (typeof value !== "object" || value === null) return null;
	const raw = value as Record<string, unknown>;
	if (typeof raw.version !== "string" || raw.version === "" || !Array.isArray(raw.skills)) return null;
	const skills: SkillsBundle["skills"] = [];
	for (const s of raw.skills) {
		if (typeof s !== "object" || s === null) return null;
		const r = s as Record<string, unknown>;
		if (typeof r.name !== "string" || !NAME.test(r.name) || typeof r.files !== "object" || r.files === null) return null;
		const files: Record<string, string> = {};
		for (const [rel, content] of Object.entries(r.files as Record<string, unknown>)) {
			if (!REL.test(rel) || typeof content !== "string") return null;
			files[rel] = content;
		}
		if (files["SKILL.md"] === undefined) return null;
		skills.push({ name: r.name, files });
	}
	return { version: raw.version, skills };
}

/** The remote's bundle, or null when it serves none (404) or cannot be reached; never throws. */
export async function fetchSkills(url: string, key: string, fetchImpl: typeof fetch = fetch): Promise<{ bundle: SkillsBundle | null; note?: string }> {
	try {
		const res = await fetchImpl(`${url}/setup/skills`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
		if (res.status === 404) return { bundle: null };
		if (!res.ok) return { bundle: null, note: `skills: ${url}/setup/skills answered ${res.status}; nothing installed` };
		const bundle = parseSkillsBundle(await res.json());
		return bundle === null ? { bundle: null, note: "skills: the remote's bundle was not understood; nothing installed" } : { bundle };
	} catch (err) {
		return { bundle: null, note: `skills: could not fetch ${url}/setup/skills (${err instanceof Error ? err.message : String(err)}); nothing installed` };
	}
}

export interface SkillsTarget {
	/** Shown in the report: "Claude Code", "omp". */
	harness: string;
	/** The harness's user-level skills directory; each skill goes in `<dir>/<name>/`. */
	dir: string;
}

export interface SkillsInstallReport {
	version: string;
	/** "<harness>: <name>" per skill written. */
	placed: string[];
	/** Files from an earlier install the bundle no longer carries. */
	removed: string[];
	/** Skills left alone because the member has their own of that name there. */
	skipped: string[];
}

interface Manifest {
	version: string;
	files: string[];
}

export function skillsManifestPath(routerHome: string): string {
	return join(routerHome, "skills-installed.json");
}

export function readSkillsManifest(routerHome: string): Manifest | null {
	try {
		const raw = JSON.parse(readFileSync(skillsManifestPath(routerHome), "utf8")) as Record<string, unknown>;
		return typeof raw.version === "string" && Array.isArray(raw.files) ? { version: raw.version, files: raw.files.filter((f): f is string => typeof f === "string") } : null;
	} catch {
		return null;
	}
}

const norm = (p: string): string => p.replaceAll("\\", "/");

/**
 * Writes the bundle into each target, records what it placed, removes what a
 * previous install placed that is gone now, and skips a skill directory it did
 * not create. Pure over the file system: no network, so a test can drive it.
 */
export function installSkills(bundle: SkillsBundle, targets: readonly SkillsTarget[], routerHome: string, dryRun = false): SkillsInstallReport {
	const previous = readSkillsManifest(routerHome);
	const ours = new Set((previous?.files ?? []).map(norm));
	const report: SkillsInstallReport = { version: bundle.version, placed: [], removed: [], skipped: [] };
	const placedFiles: string[] = [];
	for (const t of targets) {
		for (const skill of bundle.skills) {
			const dir = join(t.dir, skill.name);
			const foreign = existsSync(dir) && !readdirSync(dir).some((f) => ours.has(norm(join(dir, f))));
			if (foreign) {
				report.skipped.push(`${t.harness}: ${skill.name} (a skill of that name is already there and was not placed by connect; left alone)`);
				continue;
			}
			for (const [rel, content] of Object.entries(skill.files)) {
				const path = join(dir, ...rel.split("/"));
				placedFiles.push(norm(path));
				if (dryRun) continue;
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(path, content, "utf8");
			}
			report.placed.push(`${t.harness}: ${skill.name}`);
		}
	}
	const keep = new Set(placedFiles);
	for (const old of ours) {
		if (keep.has(old)) continue;
		report.removed.push(old);
		if (dryRun) continue;
		rmSync(old, { force: true });
		// An emptied skill directory goes too, so the harness does not list a hollow skill.
		const parent = dirname(old);
		try {
			if (readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true });
		} catch {
			/* already gone */
		}
	}
	if (!dryRun) {
		mkdirSync(routerHome, { recursive: true });
		writeFileSync(skillsManifestPath(routerHome), `${JSON.stringify({ version: bundle.version, files: placedFiles } satisfies Manifest, null, 2)}\n`, "utf8");
	}
	return report;
}
