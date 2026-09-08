/**
 * `auto-model-router join --url <team> --key <key>`: make this machine a
 * member of a team router. Writes `<router home>/team.json` (the omp
 * extensions then run in team-client mode and never bind a local router),
 * and configures every harness it finds:
 *
 *   omp         the four extensions are added to ~/.omp/agent/config.yml
 *   Hermes      the provider plugin and the native plugin are copied into
 *               $HERMES_HOME/plugins and .env points them at the team
 *   Codex       ~/.codex/config.toml gains the auto-model-router provider
 *   Aider       ~/.aider.conf.yml gains the base URL, key and model
 *   Claude Code ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY (printed; --profile persists)
 *
 * Every write is idempotent and announced. `--profile` persists the
 * environment lines (shell rc on POSIX, user environment on Windows).
 * `--dry-run` prints what would change. Honours PI_CODING_AGENT_DIR,
 * HERMES_HOME and AUTO_MODEL_ROUTER_HOME, so a test can point it anywhere.
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { teamFilePath } from "../../omp-extension/team-logic.ts";
import { flagString, type CliArgs } from "./args.ts";

export interface JoinOptions {
	url: string;
	key: string;
	userId: string;
	name: string;
	profile: boolean;
	dryRun: boolean;
	/** Restrict to these harnesses (omp, hermes, codex, aider, claude); empty ⇒ every one detected. */
	only: string[];
	env: Record<string, string | undefined>;
	home: string;
	/** Where this package lives (the extensions are referenced from here). */
	packageDir: string;
	platform: string;
	pathHas: (bin: string) => boolean;
}

export interface JoinReport {
	teamFile: string;
	configured: string[];
	skipped: string[];
	envLines: string[];
	notes: string[];
}

const expand = (raw: string, home: string): string => (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? join(home, raw.slice(1)) : raw);

function routerHomeOf(o: JoinOptions): string {
	return expand(o.env.AUTO_MODEL_ROUTER_HOME ?? join(o.home, ".auto-model-router"), o.home);
}

function ompAgentDir(o: JoinOptions): string {
	const d = o.env.PI_CODING_AGENT_DIR;
	return d !== undefined && d !== "" ? expand(d, o.home) : join(o.home, ".omp", "agent");
}

function hermesHome(o: JoinOptions): string {
	const d = o.env.HERMES_HOME;
	if (d !== undefined && d !== "") return expand(d, o.home);
	return o.platform === "win32" ? join(o.env.LOCALAPPDATA ?? join(o.home, "AppData", "Local"), "hermes") : join(o.home, ".hermes");
}

const wants = (o: JoinOptions, h: string): boolean => o.only.length === 0 || o.only.includes(h);

/** Adds lines to a YAML `extensions:` list by text, keeping everything else byte-identical. */
export function addExtensions(text: string, paths: readonly string[]): string {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const missing = paths.filter((p) => !text.includes(p));
	if (missing.length === 0) return text;
	const lines = missing.map((p) => `  - ${p}`);
	const m = /^extensions:[ \t]*\r?\n/m.exec(text);
	if (m === null) return `${text}${text.endsWith("\n") || text === "" ? "" : eol}extensions:${eol}${lines.join(eol)}${eol}`;
	const at = m.index + m[0].length;
	return `${text.slice(0, at)}${lines.join(eol)}${eol}${text.slice(at)}`;
}

/** Sets `KEY=value` lines in a dotenv-style file, replacing existing keys. */
export function setDotenv(text: string, values: Record<string, string>): string {
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	let out = text;
	for (const [k, v] of Object.entries(values)) {
		const re = new RegExp(`^${k}=.*$`, "m");
		if (re.test(out)) out = out.replace(re, `${k}=${v}`);
		else out = `${out}${out === "" || out.endsWith("\n") ? "" : eol}${k}=${v}${eol}`;
	}
	return out;
}

export function codexBlock(url: string): string {
	return `
[model_providers.auto-model-router]
name = "auto-model-router (team)"
base_url = "${url}/v1"
env_key = "AUTO_MODEL_ROUTER_API_KEY"
wire_api = "responses"
http_headers = { "X-Omp-Harness" = "codex" }
`;
}

export function joinTeam(o: JoinOptions): JoinReport {
	const report: JoinReport = { teamFile: "", configured: [], skipped: [], envLines: [], notes: [] };
	const write = (path: string, content: string): void => {
		if (o.dryRun) return;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	};

	// 1. team.json: what puts the omp extensions into team-client mode.
	const rh = routerHomeOf(o);
	report.teamFile = teamFilePath(rh);
	write(report.teamFile, `${JSON.stringify({ url: o.url, key: o.key, userId: o.userId, name: o.name, joinedAtMs: Date.now() }, null, 2)}\n`);

	// 2. omp
	const agentDir = ompAgentDir(o);
	if (wants(o, "omp") && existsSync(agentDir)) {
		const cfgPath = join(agentDir, "config.yml");
		const ext = ["router-toast", "router-embed", "router-configure", "router-digest"].map((n) => resolve(o.packageDir, "omp-extension", `${n}.ts`).replaceAll("\\", "/"));
		const before = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
		const after = addExtensions(before, ext);
		if (after !== before) write(cfgPath, after);
		report.configured.push(`omp (${cfgPath}; pick auto-model-router/auto as the model)`);
	} else report.skipped.push("omp (no ~/.omp/agent)");

	// 3. Hermes
	const hh = hermesHome(o);
	if (wants(o, "hermes") && existsSync(hh)) {
		if (!o.dryRun) {
			cpSync(join(o.packageDir, "hermes-plugin"), join(hh, "plugins", "model-providers", "auto-model-router"), { recursive: true });
			cpSync(join(o.packageDir, "hermes-plugin", "native"), join(hh, "plugins", "auto-model-router"), { recursive: true });
		}
		const envPath = join(hh, ".env");
		write(envPath, setDotenv(existsSync(envPath) ? readFileSync(envPath, "utf8") : "", { AUTO_MODEL_ROUTER_URL: o.url, AUTO_MODEL_ROUTER_API_KEY: o.key }));
		report.configured.push(`Hermes (${hh}/plugins; restart Hermes and select auto-model-router/auto)`);
	} else report.skipped.push("Hermes (no HERMES_HOME)");

	// 4. Codex
	const codexDir = join(o.home, ".codex");
	if (wants(o, "codex") && existsSync(codexDir)) {
		const p = join(codexDir, "config.toml");
		const before = existsSync(p) ? readFileSync(p, "utf8") : "";
		if (!before.includes("[model_providers.auto-model-router]")) write(p, before + codexBlock(o.url));
		report.configured.push(`Codex (${p}; set model = "auto" and model_provider = "auto-model-router")`);
		report.envLines.push(`AUTO_MODEL_ROUTER_API_KEY=${o.key}`);
	} else report.skipped.push("Codex (no ~/.codex)");

	// 5. Aider
	const aiderConf = join(o.home, ".aider.conf.yml");
	if (wants(o, "aider") && (existsSync(aiderConf) || o.pathHas("aider"))) {
		const before = existsSync(aiderConf) ? readFileSync(aiderConf, "utf8") : "";
		if (!before.includes("openai-api-base:")) write(aiderConf, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}openai-api-base: ${o.url}/v1\nopenai-api-key: ${o.key}\nmodel: openai/auto\n`);
		report.configured.push(`Aider (${aiderConf})`);
	} else report.skipped.push("Aider (not found)");

	// 6. Claude Code: environment only.
	if (wants(o, "claude") && o.pathHas("claude")) {
		report.envLines.push(`ANTHROPIC_BASE_URL=${o.url}`, `ANTHROPIC_API_KEY=${o.key}`);
		report.configured.push("Claude Code (environment)");
	} else report.skipped.push("Claude Code (not on PATH)");
	report.envLines.unshift(`AUTO_MODEL_ROUTER_URL=${o.url}`, `AUTO_MODEL_ROUTER_API_KEY=${o.key}`);
	report.envLines = [...new Set(report.envLines)];

	// 7. Persist the environment.
	if (o.profile && !o.dryRun) {
		if (o.platform === "win32") {
			for (const line of report.envLines) {
				const [k, ...v] = line.split("=");
				Bun.spawnSync(["setx", k!, v.join("=")], { stdout: "ignore", stderr: "ignore" });
			}
			report.notes.push("user environment variables set with setx; open a new terminal");
		} else {
			const shell = o.env.SHELL ?? "";
			const rc = shell.includes("zsh") ? join(o.home, ".zshrc") : join(o.home, ".bashrc");
			const block = `\n# auto-model-router team (added by \`auto-model-router join\`)\n${report.envLines.map((l) => `export ${l}`).join("\n")}\n`;
			const before = existsSync(rc) ? readFileSync(rc, "utf8") : "";
			if (!before.includes("# auto-model-router team")) appendFileSync(rc, block, "utf8");
			else write(rc, before.replace(/\n# auto-model-router team[^\n]*\n(?:export [^\n]*\n)*/, block));
			report.notes.push(`environment appended to ${rc}; open a new shell or source it`);
		}
	} else report.notes.push("add the environment lines to your shell profile, or re-run with --profile");
	return report;
}

export async function joinCommand(args: CliArgs): Promise<void> {
	const url = (flagString(args, "url") ?? process.env.AUTO_MODEL_ROUTER_URL ?? "").replace(/\/+$/, "");
	const key = flagString(args, "key") ?? process.env.AUTO_MODEL_ROUTER_API_KEY ?? "";
	if (url === "" || key === "") throw new Error("join needs --url <team endpoint> and --key <your team key>");
	const only = (flagString(args, "harness") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
	const pathHas = (bin: string): boolean => Bun.which(bin) !== null;
	const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	// Verify the key before touching anything.
	let name = flagString(args, "name") ?? "";
	let userId = flagString(args, "user-id") ?? "";
	try {
		const res = await fetch(`${url}/me`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
		if (res.status === 401) throw new Error("the team rejected this key");
		if (res.ok) {
			const me = (await res.json()) as { user?: { id?: string; name?: string } };
			userId = me.user?.id ?? userId;
			name = me.user?.name ?? name;
		}
	} catch (err) {
		if (err instanceof Error && err.message.includes("rejected")) throw err;
		console.log(`warning: could not reach ${url} to verify the key (${err instanceof Error ? err.message : String(err)}); configuring anyway`);
	}
	const report = joinTeam({ url, key, userId, name, profile: args.flags.has("profile"), dryRun: args.flags.has("dry-run"), only, env: process.env, home: homedir(), packageDir, platform: process.platform, pathHas });
	console.log(`${args.flags.has("dry-run") ? "would write" : "wrote"} ${report.teamFile}${name === "" ? "" : ` for ${name}`}`);
	for (const c of report.configured) console.log(`  configured ${c}`);
	for (const s of report.skipped) console.log(`  skipped    ${s}`);
	console.log("environment:");
	for (const l of report.envLines) console.log(`  ${process.platform === "win32" ? "$env:" : "export "}${process.platform === "win32" ? l.replace("=", '="') + '"' : l}`);
	for (const n of report.notes) console.log(`note: ${n}`);
}
