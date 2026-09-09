/**
 * Builds the single-file member install: this package compiled by
 * `bun build --compile` for one operating system, with the package's own source
 * files embedded so `connect` can write out what omp and Hermes load from disk
 * (see `embedded.ts`). A team server calls this once per router version and
 * target and serves the result; nothing here runs on a member's machine.
 *
 * Cross-compiling needs bun's runtime for the target, which bun downloads on
 * first use and caches; a host without network access to bun's releases can
 * only build its own platform.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EMBEDDED_GLOBAL, type EmbeddedPackage } from "./embedded.ts";

export const EXECUTABLE_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "windows-x64"] as const;
export type ExecutableTarget = (typeof EXECUTABLE_TARGETS)[number];

export function isExecutableTarget(value: string): value is ExecutableTarget {
	return (EXECUTABLE_TARGETS as readonly string[]).includes(value);
}

/** The target of the machine this process runs on, or null when bun has no build for it. */
export function hostTarget(platform = process.platform, arch = process.arch): ExecutableTarget | null {
	const cpu = arch === "x64" ? "x64" : arch === "arm64" ? "arm64" : null;
	if (cpu === null) return null;
	if (platform === "linux") return `linux-${cpu}`;
	if (platform === "darwin") return `darwin-${cpu}`;
	if (platform === "win32" && cpu === "x64") return "windows-x64";
	return null;
}

/** The file name a build for `target` is served under. */
export function executableFileName(target: ExecutableTarget): string {
	return `auto-model-router-${target}${target.startsWith("windows") ? ".exe" : ""}`;
}

/** The package entries the install needs: the CLI, the harness integrations, and the two runtime deps. */
const PACKAGE_ENTRIES = ["package.json", "README.md", "src", "omp-extension", "hermes-plugin", "opencode-plugin"] as const;
const RUNTIME_DEPS = ["yaml", "zod"] as const;

function walk(root: string, rel: string, keep: (rel: string) => boolean, out: Record<string, string>): void {
	const abs = join(root, ...rel.split("/").filter((s) => s !== ""));
	const st = statSync(abs);
	if (st.isDirectory()) {
		for (const name of readdirSync(abs)) walk(root, rel === "" ? name : `${rel}/${name}`, keep, out);
		return;
	}
	if (!keep(rel)) return;
	// Everything the filters let through is text (ts, py, yaml, js, json, md). No byte-level
	// sniffing: src/util/hash.ts holds a NUL inside a string literal and was silently dropped
	// by one, which broke the extension on a member machine and nowhere else.
	out[rel] = readFileSync(abs, "utf8");
}

const keepPackageFile = (rel: string): boolean => !rel.includes("__pycache__") && !rel.endsWith(".pyc") && !rel.endsWith(".test.ts");
const keepDepFile = (rel: string): boolean => !/(^|\/)(tests?|__tests__)\//.test(rel) && !/\.(d\.[cm]?ts|map)$/.test(rel) && !/\.test\.[cm]?[jt]sx?$/.test(rel);

/**
 * Every file the executable embeds, keyed by path relative to the package
 * root. The runtime dependencies are resolved from the package's own location,
 * so a `bun link`ed package finds them too.
 */
export function collectPackageFiles(packageDir: string): EmbeddedPackage {
	const files: Record<string, string> = {};
	for (const entry of PACKAGE_ENTRIES) {
		if (existsSync(join(packageDir, entry))) walk(packageDir, entry, keepPackageFile, files);
	}
	for (const dep of RUNTIME_DEPS) {
		let depDir: string;
		try {
			depDir = dirname(Bun.resolveSync(`${dep}/package.json`, packageDir));
		} catch {
			continue;
		}
		const depFiles: Record<string, string> = {};
		walk(depDir, "", keepDepFile, depFiles);
		for (const [rel, content] of Object.entries(depFiles)) files[`node_modules/${dep}/${rel}`] = content;
	}
	const version = (JSON.parse(files["package.json"] ?? "{}") as { version?: string }).version ?? "0.0.0";
	return { version, files };
}

export interface BuildExecutableOptions {
	packageDir: string;
	target: ExecutableTarget;
	/** Where the executable goes; created or replaced. */
	outFile: string;
	/** The bun binary to build with; this process's own when it is bun. */
	bun?: string;
	/** A directory for the manifest and entry module; a temp dir when absent, removed afterwards. */
	stageDir?: string;
}

export type BuildExecutableResult = { ok: true; path: string; bytes: number } | { ok: false; reason: string };

function bunBinary(explicit: string | undefined): string | null {
	if (explicit !== undefined) return explicit;
	if (/(^|[\\/])bun(\.exe)?$/i.test(process.execPath)) return process.execPath;
	return Bun.which("bun");
}

/**
 * Compiles the package at `packageDir` into `outFile` for `target`. The entry
 * module sets the global `embedded.ts` reads and then loads the CLI, so the CLI
 * itself never knows at build time whether it will be compiled.
 */
export async function buildExecutable(opts: BuildExecutableOptions): Promise<BuildExecutableResult> {
	const bun = bunBinary(opts.bun);
	if (bun === null) return { ok: false, reason: "bun is not available to build with" };
	const stage = opts.stageDir ?? mkdtempSync(join(tmpdir(), "amr-exe-"));
	mkdirSync(stage, { recursive: true });
	try {
		const pkg = collectPackageFiles(opts.packageDir);
		if (pkg.files["src/index.ts"] === undefined) return { ok: false, reason: `${opts.packageDir} does not hold the router package (no src/index.ts)` };
		writeFileSync(join(stage, "manifest.json"), JSON.stringify(pkg), "utf8");
		const entry = join(opts.packageDir, "src", "index.ts").replaceAll("\\", "/");
		writeFileSync(
			join(stage, "entry.ts"),
			[
				`import manifest from "./manifest.json" with { type: "file" };`,
				`(globalThis as Record<string, unknown>)[${JSON.stringify(EMBEDDED_GLOBAL)}] = { manifestPath: manifest };`,
				`await import(${JSON.stringify(entry)});`,
				"",
			].join("\n"),
			"utf8",
		);
		mkdirSync(dirname(opts.outFile), { recursive: true });
		const proc = Bun.spawn([bun, "build", "--compile", `--target=bun-${opts.target}`, join(stage, "entry.ts"), "--outfile", opts.outFile], { stdout: "pipe", stderr: "pipe", cwd: opts.packageDir });
		const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		if (exitCode !== 0 || !existsSync(opts.outFile)) {
			const tail = `${stderr}\n${stdout}`.trim().split("\n").slice(-6).join("\n");
			return { ok: false, reason: `bun build --compile for ${opts.target} failed (exit ${exitCode}): ${tail}` };
		}
		return { ok: true, path: opts.outFile, bytes: statSync(opts.outFile).size };
	} finally {
		if (opts.stageDir === undefined) rmSync(stage, { recursive: true, force: true });
	}
}

