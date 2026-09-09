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
import { exportCommand } from "./cli/export.ts";
import { connectCommand } from "./cli/connect.ts";
import { isCompiled, readEmbeddedPackage } from "./cli/embedded.ts";
import { refreshCommand, tokenCommand } from "./cli/refresh.ts";
import { modelsCommand } from "./cli/models.ts";
import { reportCommand } from "./cli/report.ts";
import { serveCommand } from "./cli/serve.ts";
import { statsCommand } from "./cli/stats.ts";

const USAGE = `auto-model-router - local cost/complexity-aware model router for omp, backed by OpenRouter

Usage: auto-model-router <command> [options]

  serve      Run the router as a standalone process (for non-omp harnesses)
  stats      Show routed spend, per-model share, and escalation rates
  report     Usage analytics: providers, models, tiers, cost, speed, cache hit rate
  export     One row per day, harness and model as CSV (--json for rows)
  connect    Point this machine at a remote router (--url with --key[, --refresh-token] or --setup-token <one-time token from a team>; --scope pins one project for the whole machine (default: each workspace's own); --profile persists the environment and, from the compiled executable, PATH; the remote's skills are installed for Claude Code and omp)
  refresh    Trade the refresh token for a new access key and re-write every harness config (--force: even when not near expiry)
  token      Print an access key that is good right now, refreshing first if needed (for a harness key-helper)
  models     Show what each complexity tier would consider, and why
  explain    Route a saved request without dispatching it, and explain the decision
  config     Interactive wizard over the router's own config.yml
             (--print shows the models.yml block; --write splices it into omp)

Global options:
  --config <path>   Use a specific router config file
  --help, -h        Show help
  --version         Show version

  serve    --port <n>  --host <addr>  --log <level>
  stats    --days <n>  --json
  report   --days <n>  --harness <id>  --json
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
		// The compiled executable has no package.json beside it; its embedded copy answers.
		const embedded = await readEmbeddedPackage();
		const pkg: unknown = embedded ?? (await Bun.file(join(import.meta.dir, "..", "package.json")).json());
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
	switch (args.command) {
		case "serve":
			// Resolves once listening; the server itself keeps the loop alive.
			await serveCommand(args);
			return 0;
		case "stats":
			await statsCommand(args);
			return 0;
		case "report":
			await reportCommand(args);
			return 0;
		case "export":
			await exportCommand(args);
			return 0;
		case "connect":
		case "join": // the first release's name
			await connectCommand(args);
			return 0;
		case "refresh":
			await refreshCommand(args);
			return 0;
		case "token":
			await tokenCommand(args);
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

// The compiled executable loads this module from its entry, so it is never import.meta.main there.
if (import.meta.main || isCompiled()) {
	try {
		const code = await main();
		if (code !== 0) process.exit(code);
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}
}
