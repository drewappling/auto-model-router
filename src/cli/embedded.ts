/**
 * The router package carried inside a compiled executable.
 *
 * `bun build --compile` turns this CLI into one file per operating system, and
 * that is what a team member downloads: no bun, no npm, nothing else. But the
 * harness integrations are not the CLI — omp loads `omp-extension/*.ts` with
 * its own runtime and Hermes copies `hermes-plugin/` — so the executable also
 * carries the package's source files and writes them out under the router home
 * the first time `connect` runs. The build side (`build-executable.ts`) puts a
 * JSON manifest of those files into the executable and sets a global that names
 * it; this side reads it.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface EmbeddedPackage {
	/** The router package's version, which also names the extracted directory. */
	version: string;
	/** Relative path (forward slashes) → file content. Text only: the package has no binaries. */
	files: Record<string, string>;
}

/** What the build's entry module sets before the CLI loads. */
export interface EmbeddedHandle {
	/** Path of the manifest inside the executable's embedded filesystem. */
	manifestPath: string;
}

export const EMBEDDED_GLOBAL = "AUTO_MODEL_ROUTER_EMBEDDED";

export function embeddedHandle(): EmbeddedHandle | null {
	const h = (globalThis as Record<string, unknown>)[EMBEDDED_GLOBAL];
	return typeof h === "object" && h !== null && typeof (h as EmbeddedHandle).manifestPath === "string" ? (h as EmbeddedHandle) : null;
}

/** True when this process is the compiled executable rather than `bun run src/index.ts`. */
export function isCompiled(): boolean {
	return embeddedHandle() !== null;
}

/** The executable's own path when compiled, for key helpers and PATH; null under bun. */
export function executablePath(): string | null {
	return isCompiled() ? process.execPath : null;
}

export async function readEmbeddedPackage(): Promise<EmbeddedPackage | null> {
	const h = embeddedHandle();
	if (h === null) return null;
	const parsed = JSON.parse(await Bun.file(h.manifestPath).text()) as EmbeddedPackage;
	return typeof parsed.version === "string" && typeof parsed.files === "object" && parsed.files !== null ? parsed : null;
}

const MARKER = ".materialized";

/**
 * Writes the embedded package under `<routerHome>/package/<version>/` and
 * returns that directory, the `packageDir` every harness config then points
 * at. Idempotent: a marker records the manifest's hash, so an unchanged
 * executable writes nothing on later runs and a rebuilt one of the same
 * version refreshes the files.
 */
export function materializePackage(routerHome: string, pkg: EmbeddedPackage): string {
	const dir = join(routerHome, "package", pkg.version);
	const digest = Bun.hash(JSON.stringify(pkg.files)).toString(16);
	try {
		if (readFileSync(join(dir, MARKER), "utf8").trim() === digest) return dir;
	} catch {
		/* not written yet */
	}
	for (const [rel, content] of Object.entries(pkg.files)) {
		const target = join(dir, ...rel.split("/"));
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content, "utf8");
	}
	writeFileSync(join(dir, MARKER), `${digest}\n`, "utf8");
	return dir;
}
