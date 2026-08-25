#!/usr/bin/env bun
/**
 * auto-model-router installer.
 *
 * Wires the auto-model-router extensions into omp's `~/.omp/agent/config.yml`
 * (or `$PI_CODING_AGENT_DIR/config.yml` when that env var relocates the agent
 * dir). Cross-platform: Windows, macOS, and Linux.
 *
 * It adds the three extension paths under `extensions:`:
 *   - router-embed.ts      (required — runs the router in-process)
 *   - router-toast.ts      (optional — chosen-model toasts)
 *   - router-configure.ts  (optional — /router configure command)
 *
 * Idempotent: already-present paths are left untouched, so re-running is safe.
 * The previous config.yml is backed up to a timestamped .bak before writing.
 *
 * Usage:
 *   bun tools/install.ts
 *   bun tools/install.ts --no-toast --no-configure   # only the embed extension
 *   PI_CODING_AGENT_DIR=/custom/agent bun tools/install.ts
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** The repo's omp-extension directory, resolved from this script's location. */
const EXT_DIR = resolve(import.meta.dir, "..", "omp-extension");

/** The three extensions, in install order. */
const EXTENSIONS = [
	{ file: "router-embed.ts", required: true, label: "router-embed (required)" },
	{ file: "router-toast.ts", required: false, label: "router-toast (toasts)" },
	{ file: "router-configure.ts", required: false, label: "router-configure (/router configure)" },
];

/** omp's agent config.yml path, honoring $PI_CODING_AGENT_DIR. */
function agentConfigPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const base = agentDir !== undefined && agentDir !== "" ? agentDir : join(homedir(), ".omp", "agent");
	return join(base, "config.yml");
}

/** The absolute path of an extension file, using forward slashes for portability. */
function extensionPath(file: string): string {
	return join(EXT_DIR, file).replace(/\\/g, "/");
}

/**
 * Inserts the extension paths under an `extensions:` key, preserving comments
 * and existing content. Creates the key if absent; appends to it if present.
 */
function spliceExtensions(text: string, paths: string[]): string {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const lines = text.split(/\r?\n/);

	// Find the `extensions:` key and its indentation.
	const extIdx = lines.findIndex((l) => /^extensions\s*:/.test(l));
	if (extIdx === -1) {
		// No extensions key: append one at the end (or after the last non-empty line).
		const indent = "  ";
		const block = ["extensions:", ...paths.map((p) => `${indent}- ${p}`)];
		const trimmed = lines.map((l) => l.trimEnd());
		while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") trimmed.pop();
		return [...trimmed, "", ...block, ""].join(eol);
	}

	// Existing key: find its child indentation (or default to 2 spaces).
	const extLine = lines[extIdx] ?? "";
	const indent = /^([ \t]*)/.exec(extLine)?.[1] ?? "";
	const childIndent = `${indent}  `;

	// Collect existing children until the next top-level key.
	const children: string[] = [];
	let i = extIdx + 1;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.trim() === "") {
			i++;
			continue;
		}
		// A line at the same or less indentation than the key ends the list.
		if (/^[ \t]*\S/.test(line) && !line.startsWith(childIndent)) break;
		children.push(line);
		i++;
	}

	const existing = children.map((l) => l.trim());
	const toAdd = paths.filter((p) => !existing.includes(`- ${p}`));
	if (toAdd.length === 0) return text;

	const newChildren = [...children, ...toAdd.map((p) => `${childIndent}- ${p}`)];
	const next = [...lines.slice(0, extIdx + 1), ...newChildren, ...lines.slice(i)];
	return next.join(eol);
}

function main(): void {
	const args = process.argv.slice(2);
	const noToast = args.includes("--no-toast");
	const noConfigure = args.includes("--no-configure");

	const selected = EXTENSIONS.filter((e) => {
		if (e.file === "router-toast.ts" && noToast) return false;
		if (e.file === "router-configure.ts" && noConfigure) return false;
		return true;
	});

	// Verify the required extension files exist before touching anything.
	const missing = selected.filter((e) => !existsSync(extensionPath(e.file)));
	if (missing.length > 0) {
		console.error(`error: missing extension file(s): ${missing.map((m) => extensionPath(m.file)).join(", ")}`);
		process.exit(1);
	}

	const target = agentConfigPath();
	const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
	const paths = selected.map((e) => extensionPath(e.file));
	const next = spliceExtensions(existing, paths);

	if (next === existing) {
		console.log(`already installed: ${target}`);
		return;
	}

	// Back up the previous file.
	if (existing !== "") {
		const backup = `${target}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
		copyFileSync(target, backup);
		console.log(`backup: ${backup}`);
	}

	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, next, "utf8");

	console.log(`installed auto-model-router extensions into ${target}:`);
	for (const e of selected) console.log(`  - ${extensionPath(e.file)}  (${e.label})`);
	console.log("restart the omp session to load them.");
}

main();
