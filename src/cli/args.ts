/**
 * Argv parsing for the CLI.
 *
 * Lives apart from `src/index.ts` so command modules can import the helpers
 * without a cycle back through the entry point.
 */

import type { RouterConfig } from "../config/types.ts";

export interface CliArgs {
	command: string;
	positionals: string[];
	/** Long flags. Value-less flags map to `true`. */
	flags: Map<string, string | true>;
}

/**
 * Flags that never consume the following token. Without this, `--json` before
 * a positional would silently swallow it -- the classic hand-rolled parser bug.
 */
const BOOLEAN_FLAGS: Record<string, true> = {
	json: true,
	write: true,
	print: true,
	help: true,
	version: true,
};

const COMMANDS: Record<string, true> = {
	stats: true,
	models: true,
	explain: true,
	config: true,
};

export function parseArgv(argv: string[]): CliArgs {
	const flags = new Map<string, string | true>();
	const positionals: string[] = [];
	let command = "";

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === undefined) continue;

		if (token === "-h") {
			flags.set("help", true);
			continue;
		}
		if (!token.startsWith("--")) {
			if (command === "" && COMMANDS[token] === true) command = token;
			else positionals.push(token);
			continue;
		}

		const body = token.slice(2);
		const eq = body.indexOf("=");
		if (eq !== -1) {
			flags.set(body.slice(0, eq), body.slice(eq + 1));
			continue;
		}
		if (BOOLEAN_FLAGS[body] === true) {
			flags.set(body, true);
			continue;
		}
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("-")) {
			flags.set(body, next);
			i++;
			continue;
		}
		flags.set(body, true);
	}

	return { command, positionals, flags };
}

export function flagString(args: CliArgs, name: string): string | undefined {
	const value = args.flags.get(name);
	return typeof value === "string" ? value : undefined;
}

export function flagInt(args: CliArgs, name: string): number | undefined {
	const raw = flagString(args, name);
	if (raw === undefined) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) throw new Error(`--${name} expects an integer, got "${raw}"`);
	return parsed;
}

/**
 * Builds `loadConfig` options from the global `--config` flag.
 *
 * Keys are added only when present: `exactOptionalPropertyTypes` makes an
 * explicit `undefined` a type error, not a no-op.
 */
export function configOpts(
	args: CliArgs,
	overrides?: Partial<RouterConfig>,
): { path?: string; overrides?: Partial<RouterConfig> } {
	const opts: { path?: string; overrides?: Partial<RouterConfig> } = {};
	const path = flagString(args, "config");
	if (path !== undefined) opts.path = path;
	if (overrides !== undefined) opts.overrides = overrides;
	return opts;
}
