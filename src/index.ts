#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 * Argv parsing is hand-rolled in `cli/args.ts`: five subcommands and a dozen
 * flags do not justify a dependency, and the shape stays obvious.
 */

import { join } from "node:path";

import { parseArgv } from "./cli/args.ts";
import { configCommand } from "./cli/config-cmd.ts";
import { explainCommand } from "./cli/explain.ts";
import { modelsCommand } from "./cli/models.ts";
import { statsCommand } from "./cli/stats.ts";

const USAGE = `auto-model-router - local cost/complexity-aware model router for omp, backed by OpenRouter

Usage: auto-model-router <command> [options]

Commands:
  stats      Show routed spend, per-model share, and escalation rates
  models     Show what each complexity tier would consider, and why
  explain    Route a saved request without dispatching it, and explain the decision
  config     Interactive wizard over the router's own config.yml
             (--print shows the models.yml block; --write splices it into omp)

Global options:
  --config <path>   Use a specific router config file
  --help, -h        Show help
  --version         Show version

Command options:
  stats    --days <n>  --json
  models   --tier <trivial|simple|moderate|hard>  --limit <n>  --json
  explain  --file <request.json>  --json          (reads stdin when --file is absent)
  config   --print  --write  --path <models.yml>  --config <router-config.yml>

Environment:
  OPENROUTER_API_KEY   Required for completions; the catalog is readable without it.
  AUTO_MODEL_ROUTER_HOME      Config and database directory (default ~/.auto-model-router)
`;

async function main(): Promise<number> {
	const args = parseArgv(process.argv.slice(2));

	if (args.flags.has("version")) {
		const pkg: unknown = await Bun.file(join(import.meta.dir, "..", "package.json")).json();
		const value =
			typeof pkg === "object" && pkg !== null && "version" in pkg && typeof pkg.version === "string"
				? pkg.version
				: "unknown";
		console.log(value);
		return 0;
	}
	if (args.command === "") {
		// No command is a usage question rather than an error when help was asked for.
		process.stdout.write(USAGE);
		return args.flags.has("help") ? 0 : 1;
	}
	if (args.flags.has("help")) {
		process.stdout.write(USAGE);
		return 0;
	}

	switch (args.command) {
		case "stats":
			await statsCommand(args);
			return 0;
		case "models":
			await modelsCommand(args);
			return 0;
		case "explain":
			await explainCommand(args);
			return 0;
		case "config":
			await configCommand(args);
			return 0;
		default:
			process.stderr.write(`unknown command "${args.command}"\n\n${USAGE}`);
			return 1;
	}
}

if (import.meta.main) {
	try {
		const code = await main();
		if (code !== 0) process.exit(code);
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}
}
