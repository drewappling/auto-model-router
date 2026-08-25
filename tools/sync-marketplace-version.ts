#!/usr/bin/env bun
/**
 * Syncs the Git-marketplace catalog version with package.json.
 *
 * The marketplace (`.omp-plugin/marketplace.json`) serves the repo tip, and omp
 * uses the catalog `version` for upgrade comparisons. If it lags the published
 * package version, marketplace users are never offered new releases.
 *
 * This runs automatically as the npm `version` lifecycle script (`npm version`
 * → this → commit), so every release keeps the catalog in step. It rewrites
 * `metadata.version` and every `plugins[].version` to package.json's version and
 * stages the file so it lands in the same version commit.
 *
 * Idempotent: a no-op when already in sync (nothing to stage). Also runnable by
 * hand: `bun tools/sync-marketplace-version.ts`.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const PKG_PATH = join(ROOT, "package.json");
const CATALOG_PATH = join(ROOT, ".omp-plugin", "marketplace.json");

function main(): void {
	const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as { version?: unknown };
	const version = pkg.version;
	if (typeof version !== "string" || version === "") {
		throw new Error(`package.json has no usable version: ${JSON.stringify(version)}`);
	}

	const before = readFileSync(CATALOG_PATH, "utf8");
	// Replace only the value of every `"version": "..."` field, preserving all
	// other formatting (single-line arrays, spacing, key order) so the tool is a
	// true no-op once in sync. marketplace.json carries exactly two: the
	// top-level metadata.version and the single plugin's version.
	if (!/"version"\s*:\s*"/.test(before)) {
		throw new Error(`no "version" field found in ${CATALOG_PATH}`);
	}
	const after = before.replace(
		/("version"\s*:\s*")[^"]*(")/g,
		(_m, head: string, tail: string) => `${head}${version}${tail}`,
	);
	if (after === before) {
		console.log(`marketplace.json already at ${version}`);
		return;
	}

	writeFileSync(CATALOG_PATH, after, "utf8");
	console.log(`marketplace.json → ${version}`);

	// Stage it so `npm version`'s commit includes the sync.
	const add = spawnSync("git", ["add", CATALOG_PATH], { cwd: ROOT, stdio: "inherit" });
	if (add.status !== 0) {
		throw new Error(`git add failed for ${CATALOG_PATH} (exit ${add.status ?? "signal"})`);
	}
}

main();
