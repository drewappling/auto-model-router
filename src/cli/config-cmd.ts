/**
 * `omp-router config`.
 *
 * Bare invocation opens the interactive wizard over the router's own
 * config.yml (see `config-wizard.ts`). `--print` emits the `models.yml`
 * provider block that registers this router with omp, and `--write` splices
 * that block into omp's models.yml.
 *
 * The splice operates on TEXT, never a YAML round-trip. A user's models.yml is
 * hand-maintained and full of comments explaining non-obvious context-window
 * choices; reserializing it would silently delete all of that.
 *
 * The router's own config.yml is ours, so the wizard DOES reserialize it —
 * but only after merging the user's edits over the existing file, so unedited
 * keys survive.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify } from "yaml";

import { loadConfig, resolveTilde } from "../config/load.ts";
import { configInputSchema } from "../config/schema.ts";
import type { RouterConfig } from "../config/types.ts";
import { createLedger } from "../cost/ledger.ts";
import type { BlendedRate } from "../cost/types.ts";
import { openDb } from "../util/sqlite.ts";
import { configOpts, flagString, type CliArgs } from "./args.ts";
import {
	mergeConfigPartial,
	runWizard,
	StreamLineSource,
	type WizardIo,
} from "./config-wizard.ts";

export const BEGIN_GUARD = "# BEGIN omp-router";
export const END_GUARD = "# END omp-router";

/**
 * Cache-price multipliers used only when the ledger has no measured blend yet.
 * These are the rates the major upstreams publish (reads ~0.1x input, writes
 * ~1.25x input); they are a starting estimate, replaced by measurement as soon
 * as enough turns are recorded.
 */
const FALLBACK_CACHE_READ_MULTIPLIER = 0.1;
const FALLBACK_CACHE_WRITE_MULTIPLIER = 1.25;

export interface SpliceResult {
	text: string;
	action: "replaced" | "inserted" | "created";
}

/**
 * Renders the provider block body (without guards) as YAML lines.
 *
 * `cost` is in omp's units: USD per MILLION tokens. The catalog works in
 * per-token rates, so everything is scaled by 1e6 exactly once, here.
 */
export function renderProviderBlock(cfg: RouterConfig, blend: BlendedRate | null): string {
	const input = blend?.inputPerMtok ?? cfg.ledger.fallbackBlend.inputPerMtok;
	const output = blend?.outputPerMtok ?? cfg.ledger.fallbackBlend.outputPerMtok;
	const cacheRead = blend?.cacheReadPerMtok ?? input * FALLBACK_CACHE_READ_MULTIPLIER;
	const cacheWrite = blend?.cacheWritePerMtok ?? input * FALLBACK_CACHE_WRITE_MULTIPLIER;

	const round = (v: number): number => Math.round(v * 1e4) / 1e4;
	const host = cfg.server.host === "0.0.0.0" || cfg.server.host === "::" ? "127.0.0.1" : cfg.server.host;

	const provider: Record<string, unknown> = {
		"omp-router": {
			baseUrl: `http://${host}:${cfg.server.port}/v1`,
			api: "openai-completions",
			auth: "none",
			// When a harness id is configured, tag every request so the router can
			// scope daily budgets and toasts per harness.
			...(cfg.server.harnessId !== undefined && cfg.server.harnessId !== ""
				? { headers: { "X-Omp-Harness": cfg.server.harnessId } }
				: {}),
			models: cfg.profiles.map((p) => ({
				id: p.id,
				name: p.name,
				contextWindow: p.contextWindow,
				maxTokens: p.maxTokens,
				input: ["text", "image"],
				cost: {
					input: round(input),
					output: round(output),
					cacheRead: round(cacheRead),
					cacheWrite: round(cacheWrite),
				},
			})),
		},
	};

	return stringify(provider, { indent: 2 }).trimEnd();
}

function detectEol(text: string): string {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Indentation used by the children of a top-level `providers:` mapping.
 *
 * Matching the file's existing style matters: YAML is indentation-sensitive,
 * and mixing 2- and 4-space children under one mapping is invalid.
 */
function detectChildIndent(lines: string[], providersIdx: number): string {
	for (let i = providersIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		if (line.trim() === "") continue;
		const match = /^([ \t]+)\S/.exec(line);
		if (match === null) break; // dedented to a new top-level key
		const indent = match[1];
		if (indent !== undefined) return indent;
	}
	return "    ";
}

function indentBlock(block: string, indent: string, eol: string): string[] {
	return block.split(/\r?\n/).map((line) => (line === "" ? "" : `${indent}${line}`)).join(eol).split(eol);
}

/**
 * Inserts or replaces the guarded region in an existing models.yml body.
 *
 * Exported so tests can exercise it without touching a real omp config.
 */
export function spliceProviderBlock(existing: string, block: string): SpliceResult {
	// omp's own models.yml is frequently BOM-prefixed (editors on Windows add
	// one). Left in place, the BOM makes the very first line read as
	// "\uFEFFproviders:" so the top-level key is missed and a SECOND
	// `providers:` gets appended -- duplicate keys, and omp then discards the
	// whole file. Strip it for processing and restore it verbatim on output.
	const bom = existing.startsWith("\uFEFF") ? "\uFEFF" : "";
	const source = bom === "" ? existing : existing.slice(1);
	const eol = detectEol(source === "" ? "\n" : source);
	const note = "# Managed by omp-router. Cost figures are a rolling blend of actual routed";
	const note2 = "# spend; re-run `omp-router config --write` to refresh them.";

	if (source.trim() === "") {
		const indent = "    ";
		const body = [
			"providers:",
			`${indent}${BEGIN_GUARD}`,
			`${indent}${note}`,
			`${indent}${note2}`,
			...indentBlock(block, indent, eol),
			`${indent}${END_GUARD}`,
			"",
		];
		return { text: bom + body.join(eol), action: "created" };
	}

	const lines = source.split(/\r?\n/);
	const beginIdx = lines.findIndex((l) => l.trim() === BEGIN_GUARD);
	const endIdx = lines.findIndex((l) => l.trim() === END_GUARD);

	if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
		const beginLine = lines[beginIdx] ?? "";
		const indent = /^([ \t]*)/.exec(beginLine)?.[1] ?? "    ";
		const replacement = [
			`${indent}${BEGIN_GUARD}`,
			`${indent}${note}`,
			`${indent}${note2}`,
			...indentBlock(block, indent, eol),
			`${indent}${END_GUARD}`,
		];
		const next = [...lines.slice(0, beginIdx), ...replacement, ...lines.slice(endIdx + 1)];
		return { text: bom + next.join(eol), action: "replaced" };
	}

	const providersIdx = lines.findIndex((l) => /^providers\s*:/.test(l));
	if (providersIdx === -1) {
		const indent = "    ";
		const appended = [
			...lines,
			...(lines[lines.length - 1]?.trim() === "" ? [] : [""]),
			"providers:",
			`${indent}${BEGIN_GUARD}`,
			`${indent}${note}`,
			`${indent}${note2}`,
			...indentBlock(block, indent, eol),
			`${indent}${END_GUARD}`,
			"",
		];
		return { text: bom + appended.join(eol), action: "inserted" };
	}

	// Insert as the first child of `providers:`. Placing it at the top of the
	// mapping keeps every following line untouched, which is what makes the
	// "preserves comments" guarantee hold.
	const indent = detectChildIndent(lines, providersIdx);
	const inserted = [
		...lines.slice(0, providersIdx + 1),
		`${indent}${BEGIN_GUARD}`,
		`${indent}${note}`,
		`${indent}${note2}`,
		...indentBlock(block, indent, eol),
		`${indent}${END_GUARD}`,
		...lines.slice(providersIdx + 1),
	];
	return { text: bom + inserted.join(eol), action: "inserted" };
}

/**
 * Rejects a spliced result that omp could not load.
 *
 * Exported so tests can assert the guarantee directly. Duplicate top-level
 * keys are the specific failure a BOM once produced here, and YAML treats
 * them as a hard error rather than a merge.
 */
export function assertUsableModelsYaml(text: string): void {
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		throw new Error(
			`refusing to write: the spliced models.yml would not parse (${err instanceof Error ? err.message : String(err)}). Your file was left untouched.`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || !("providers" in parsed)) {
		throw new Error("refusing to write: the spliced models.yml has no top-level `providers` mapping.");
	}
	const providers = parsed.providers;
	if (typeof providers !== "object" || providers === null || !("omp-router" in providers)) {
		throw new Error("refusing to write: the spliced models.yml does not contain the omp-router provider.");
	}
}

/** The router's own config file path (the one `loadConfig` reads). */
export function routerConfigPath(): string {
	const home = resolveTilde(process.env.OMP_ROUTER_HOME ?? "~/.omp-router");
	return join(home, "config.yml");
}

/**
 * Merges a wizard partial into the config file at `target`, validating the
 * result before anything is written and backing up the previous file.
 *
 * Returns the backup path, or null when there was no prior file.
 */
export function writeRouterConfig(target: string, partial: Record<string, unknown>): string | null {
	const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
	const parsed = existing.trim() === "" ? {} : parseYaml(existing);
	const base: Record<string, unknown> =
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};

	const merged = mergeConfigPartial(base, partial);

	// Validate the MERGED file, not just the partial: a legal edit can still
	// combine with existing keys into something the loader would reject.
	const validated = configInputSchema.safeParse(merged);
	if (!validated.success) {
		const lines = validated.error.issues.map(
			(issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
		);
		throw new Error(`refusing to write invalid config:\n${lines.join("\n")}`);
	}

	let backup: string | null = null;
	if (existing !== "") {
		backup = `${target}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
		copyFileSync(target, backup);
	}

	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, stringify(merged, { indent: 2 }), "utf8");
	return backup;
}

/**
 * Runs the interactive wizard and persists the result to the router's own
 * config.yml.
 */
async function runWizardCommand(args: CliArgs): Promise<void> {
	const cfg = loadConfig(configOpts(args));
	const io: WizardIo = {
		read: new StreamLineSource(process.stdin),
		write: (text) => process.stdout.write(text),
	};

	const { partial, changed } = await runWizard(cfg, io);
	if (partial === null) {
		console.log("\nno changes written");
		return;
	}

	const target = flagString(args, "config") ?? routerConfigPath();
	const backup = writeRouterConfig(target, partial);
	if (backup !== null) console.log(`\nbackup: ${backup}`);
	console.log(`wrote ${target} (${changed} field${changed === 1 ? "" : "s"} changed)`);
	console.log("restart the router to pick up the change");
}

/** omp's models.yml location: `$PI_CODING_AGENT_DIR` relocates the whole agent dir. */
export function ompModelsPath(): string {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (agentDir !== undefined && agentDir !== "") return join(agentDir, "models.yml");
	return join(homedir(), ".omp", "agent", "models.yml");
}

export async function configCommand(args: CliArgs): Promise<void> {
	const cfg = loadConfig(configOpts(args));

	// Reading a blend must not create a database just by asking.
	let blend: BlendedRate | null = null;
	if (existsSync(cfg.ledger.path)) {
		const db = openDb(cfg.ledger.path);
		try {
			blend = createLedger(db, cfg).blendedRate(cfg.ledger.blendWindowDays);
		} finally {
			db.close();
		}
	}

	const block = renderProviderBlock(cfg, blend);

	// Bare `config` runs the interactive wizard over the router's own
	// config.yml. `--print` keeps the old block output; `--write` splices it.
	if (!args.flags.has("write") && !args.flags.has("print")) {
		await runWizardCommand(args);
		return;
	}

	if (args.flags.has("print") && !args.flags.has("write")) {
		console.log(block);
		console.log("");
		console.log(
			blend === null
				? `# cost figures are estimates (no measured blend yet: needs ${cfg.ledger.blendMinSamples} routed turns)`
				: `# cost figures blended from ${blend.sampleCount} routed turns over ${blend.windowDays}d`,
		);
		console.log(`# apply with: omp-router config --write   (target: ${ompModelsPath()})`);
		return;
	}

	const target = flagString(args, "path") ?? ompModelsPath();
	const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
	const result = spliceProviderBlock(existing, block);

	// Validate before overwriting. The splice is textual so comments survive,
	// but that also means nothing else would catch a malformed result -- and a
	// models.yml that fails to parse makes omp silently discard every custom
	// provider in the file, not just ours. Parse is read-only: the validated
	// text is what gets written, never a reserialization.
	assertUsableModelsYaml(result.text);

	if (existing !== "") {
		const backup = `${target}.${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
		copyFileSync(target, backup);
		console.log(`backup: ${backup}`);
	}

	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, result.text, "utf8");
	console.log(`${result.action} omp-router provider block in ${target}`);
	console.log(`restart omp (or run /models) to pick up the change`);
}
