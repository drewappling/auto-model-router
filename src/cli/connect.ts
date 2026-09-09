/**
 * `auto-model-router connect --url <router> --key <key>`: point this machine
 * at a remote router (a shared one on a LAN, or the team edition). Writes
 * `<router home>/remote.json` (the omp extensions then run in remote mode and
 * never bind a local router), and configures every harness it finds:
 *
 *   omp         the four extensions are added to ~/.omp/agent/config.yml, and
 *               the remote is written into ~/.omp/agent/models.yml so
 *               `auto-model-router/auto` resolves at STARTUP — omp builds the
 *               main model's handle before extensions load, so without that
 *               entry only the late-resolved roles (smol, tiny) reach the
 *               router and the main turns fall back to another provider
 *   Hermes      the provider plugin and the native plugin are copied into
 *               $HERMES_HOME/plugins and .env points them at the remote
 *   Codex       ~/.codex/config.toml gains the auto-model-router provider
 *   Aider       ~/.aider.conf.yml gains the base URL, key and model
 *   Claude Code ~/.claude/settings.json gains the base URL (its `env` block) and
 *               `apiKeyHelper` running `auto-model-router token`, so no key
 *               sits in its environment or on disk for it
 *
 * Every write is idempotent and announced. `--profile` persists the
 * environment lines (shell rc on POSIX, user environment on Windows).
 * `--dry-run` prints what would change. Honours PI_CODING_AGENT_DIR,
 * HERMES_HOME and AUTO_MODEL_ROUTER_HOME, so a test can point it anywhere.
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { refreshAccountOf, remoteFilePath } from "../../omp-extension/remote-logic.ts";
import { SCOPE_ENV } from "../context/scope.ts";
import { executablePath, materializePackage, readEmbeddedPackage } from "./embedded.ts";
import { pickStore, saveRefreshToken, type StoreDeps, type StoreKind } from "./credential-store.ts";
import { flagString, type CliArgs } from "./args.ts";

export interface ConnectOptions {
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
	/** Cost figures omp shows for the remote's virtual models, USD per million tokens. */
	blend?: { inputPerMtok: number; outputPerMtok: number };
	/** Pins `X-Agentdox-Scope` in omp's models.yml entry to one slug, machine-wide. Without it the entry follows the workspace (see renderRemoteModelsYml). Undefined keeps what the managed block already has. */
	agentdoxScope?: string;
	/** Short-lived credential fields from a remote that issues them; absent for a permanent key. */
	refreshToken?: string;
	/** Which store takes the refresh token; picked from the platform when absent. Tests inject a backend. */
	store?: StoreKind;
	storeDeps?: StoreDeps;
	keyExpiresAtMs?: number;
	refreshExpiresAtMs?: number;
	device?: string;
	/**
	 * The compiled executable running this, when one is (see embedded.ts). It
	 * becomes Claude Code's key helper and goes on PATH with --profile, and
	 * remote.json records it so a refresh from omp keeps pointing at it.
	 */
	exePath?: string;
	platform: string;
	pathHas: (bin: string) => boolean;
}

export interface ConnectReport {
	remoteFile: string;
	configured: string[];
	skipped: string[];
	envLines: string[];
	notes: string[];
}

const expand = (raw: string, home: string): string => (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? join(home, raw.slice(1)) : raw);

function routerHomeOf(o: ConnectOptions): string {
	return expand(o.env.AUTO_MODEL_ROUTER_HOME ?? join(o.home, ".auto-model-router"), o.home);
}

function ompAgentDir(o: ConnectOptions): string {
	const d = o.env.PI_CODING_AGENT_DIR;
	return d !== undefined && d !== "" ? expand(d, o.home) : join(o.home, ".omp", "agent");
}

function hermesHome(o: ConnectOptions): string {
	const d = o.env.HERMES_HOME;
	if (d !== undefined && d !== "") return expand(d, o.home);
	return o.platform === "win32" ? join(o.env.LOCALAPPDATA ?? join(o.home, "AppData", "Local"), "hermes") : join(o.home, ".hermes");
}

const wants = (o: ConnectOptions, h: string): boolean => o.only.length === 0 || o.only.includes(h);

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
name = "auto-model-router (remote)"
base_url = "${url}/v1"
env_key = "AUTO_MODEL_ROUTER_API_KEY"
wire_api = "responses"
http_headers = { "X-Omp-Harness" = "codex" }
`;
}

/** The models a remote router advertises, and what omp should believe they cost. */
const REMOTE_MODEL_ROWS: readonly { id: string; name: string }[] = [
	{ id: "auto", name: "Auto (auto-model-router)" },
	{ id: "auto-cheap", name: "Auto Cheap (auto-model-router)" },
	{ id: "auto-max", name: "Auto Max (auto-model-router)" },
];

const MODELS_YML_BEGIN = "  # BEGIN auto-model-router (remote)";
const MODELS_YML_END = "  # END auto-model-router (remote)";

/**
 * omp's `models.yml` entry for a remote router.
 *
 * A LOCAL router deliberately never writes this file: its port is ephemeral, so
 * a persisted entry names a dead socket on the next launch. A remote router has
 * neither problem — the URL and the key are stable — and the entry is what makes
 * omp's main model resolvable at startup, before extensions load.
 *
 * `X-Agentdox-Scope` on this entry reaches the MAIN model's turns, which the
 * extensions' own registration cannot (they load after the handle is built).
 * The file is machine-wide, so a literal slug here would label every
 * workspace's turns with one project; by default the value is the NAME of
 * `SCOPE_ENV`, which omp resolves from its environment per request, and the
 * embed extension sets that variable from the workspace folder as it loads.
 * `scope` pins a literal slug instead, for a single-project machine.
 */
export function renderRemoteModelsYml(url: string, key: string, blend: { inputPerMtok: number; outputPerMtok: number }, scope = ""): string {
	const round = (v: number): number => Math.round(v * 1e4) / 1e4;
	const cost = {
		input: round(blend.inputPerMtok),
		output: round(blend.outputPerMtok),
		cacheRead: round(blend.inputPerMtok * 0.1),
		cacheWrite: round(blend.inputPerMtok * 1.25),
	};
	const lines = [
		MODELS_YML_BEGIN,
		"  # Managed by `auto-model-router connect`. Remove this block to stop routing omp through the remote.",
		"  auto-model-router:",
		`    baseUrl: ${url.replace(/\/+$/, "")}/v1`,
		"    api: openai-completions",
		`    apiKey: ${key}`,
	];
	lines.push("    headers:", `      X-Agentdox-Scope: ${scope !== "" ? scope : SCOPE_ENV}`);
	lines.push("    models:");
	for (const m of REMOTE_MODEL_ROWS) {
		lines.push(
			`      - id: ${m.id}`,
			`        name: ${m.name}`,
			"        contextWindow: 200000",
			"        maxTokens: 32000",
			"        input: [text, image]",
			`        cost: { input: ${cost.input}, output: ${cost.output}, cacheRead: ${cost.cacheRead}, cacheWrite: ${cost.cacheWrite} }`,
		);
	}
	lines.push(MODELS_YML_END);
	return lines.join("\n");
}

/**
 * Merges the remote block into an existing `models.yml`, replacing a previous
 * one and leaving every other provider alone. Returns the new file text.
 */
export function mergeModelsYml(before: string, blockText: string): string {
	const eol = before.includes("\r\n") ? "\r\n" : "\n";
	const body = before.replace(/^\uFEFF/, "");
	const block = blockText.split("\n").join(eol);
	const begin = body.indexOf(MODELS_YML_BEGIN);
	if (begin >= 0) {
		const endIdx = body.indexOf(MODELS_YML_END, begin);
		const end = endIdx < 0 ? body.length : endIdx + MODELS_YML_END.length;
		return `${body.slice(0, begin)}${block}${body.slice(end)}`;
	}
	// A provider entry for the same id from an earlier local install would shadow
	// ours; the caller reports it rather than editing a block it does not own.
	if (body.trim() === "") return `providers:${eol}${block}${eol}`;
	if (/^providers:\s*$/m.test(body)) {
		return body.replace(/^providers:\s*$/m, (m) => `${m}${eol}${block}`);
	}
	return `${body.replace(/\s*$/, "")}${eol}providers:${eol}${block}${eol}`;
}

/** The literal `X-Agentdox-Scope` the managed block pins, or "" when it follows the workspace (or has none). */
export function existingBlockScope(text: string): string {
	const begin = text.indexOf(MODELS_YML_BEGIN);
	if (begin < 0) return "";
	const end = text.indexOf(MODELS_YML_END, begin);
	const block = text.slice(begin, end < 0 ? text.length : end);
	const m = /X-Agentdox-Scope:\s*(\S+)/.exec(block);
	const value = m?.[1] ?? "";
	return value === SCOPE_ENV ? "" : value;
}

/** True when the file already defines our provider outside a block we manage. */
export function hasForeignRouterProvider(text: string): boolean {
	if (text.includes(MODELS_YML_BEGIN)) return false;
	return /^\s{2,}auto-model-router:\s*$/m.test(text);
}

export function connectRemote(o: ConnectOptions): ConnectReport {
	const report: ConnectReport = { remoteFile: "", configured: [], skipped: [], envLines: [], notes: [] };
	const write = (path: string, content: string): void => {
		if (o.dryRun) return;
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, "utf8");
	};

	// 1. remote.json: what puts the omp extensions into remote mode.
	const rh = routerHomeOf(o);
	report.remoteFile = remoteFilePath(rh);
	const previous = existsSync(report.remoteFile) ? (JSON.parse(readFileSync(report.remoteFile, "utf8")) as Record<string, unknown>) : {};
	// The refresh token is the long-lived secret: it goes to the OS credential store, and
	// remote.json only says which one. The access key stays in the file: it is short-lived,
	// and the extensions need it without a subprocess on every poll.
	let refreshTokenStore: StoreKind | undefined;
	const refreshAccount = refreshAccountOf(o.url, o.userId);
	if (o.refreshToken !== undefined && o.refreshToken !== "" && !o.dryRun) {
		const wanted = o.store ?? pickStore(o.platform, o.pathHas);
		refreshTokenStore = saveRefreshToken(rh, refreshAccount, o.refreshToken, wanted, o.storeDeps ?? { pathHas: o.pathHas });
		if (refreshTokenStore !== wanted) report.notes.push(`the ${wanted} credential store was not usable; the refresh token is in ${join(rh, "refresh.token")} (owner-readable only)`);
	} else if (o.refreshToken !== undefined && o.refreshToken !== "") refreshTokenStore = o.store ?? pickStore(o.platform, o.pathHas);
	write(
		report.remoteFile,
		`${JSON.stringify(
			{
				url: o.url,
				key: o.key,
				userId: o.userId,
				name: o.name,
				joinedAtMs: typeof previous.joinedAtMs === "number" ? previous.joinedAtMs : Date.now(),
				...(refreshTokenStore !== undefined ? { refreshTokenStore, refreshAccount } : {}),
				...(o.keyExpiresAtMs !== undefined ? { keyExpiresAtMs: o.keyExpiresAtMs } : {}),
				...(o.refreshExpiresAtMs !== undefined ? { refreshExpiresAtMs: o.refreshExpiresAtMs } : {}),
				...(o.device !== undefined && o.device !== "" ? { device: o.device } : {}),
				...(o.exePath !== undefined && o.exePath !== "" ? { executable: o.exePath } : {}),
			},
			null,
			2,
		)}\n`,
	);

	// 2. omp
	const agentDir = ompAgentDir(o);
	if (wants(o, "omp") && existsSync(agentDir)) {
		const cfgPath = join(agentDir, "config.yml");
		const ext = ["router-toast", "router-embed", "router-configure", "router-digest"].map((n) => resolve(o.packageDir, "omp-extension", `${n}.ts`).replaceAll("\\", "/"));
		const before = existsSync(cfgPath) ? readFileSync(cfgPath, "utf8") : "";
		const after = addExtensions(before, ext);
		if (after !== before) write(cfgPath, after);
		// models.yml: what makes the MAIN model resolvable, since omp builds that
		// handle at startup, before the extensions register anything.
		const modelsPath = join(agentDir, "models.yml");
		const modelsBefore = existsSync(modelsPath) ? readFileSync(modelsPath, "utf8") : "";
		if (hasForeignRouterProvider(modelsBefore)) {
			report.notes.push(`${modelsPath} already defines an auto-model-router provider by hand; left alone — remove it to let connect manage the remote entry`);
			report.configured.push(`omp (${cfgPath}; extensions only)`);
		} else {
			// A refresh re-writes the block without knowing the scope: keep the one already there.
			const scope = o.agentdoxScope ?? existingBlockScope(modelsBefore);
			const modelsAfter = mergeModelsYml(modelsBefore, renderRemoteModelsYml(o.url, o.key, o.blend ?? { inputPerMtok: 1.1, outputPerMtok: 4.4 }, scope));
			if (modelsAfter !== modelsBefore) {
				// Never overwrite another provider's work without a way back.
				if (modelsBefore !== "" && !o.dryRun) writeFileSync(`${modelsPath}.${new Date().toISOString().replaceAll(":", "-")}.bak`, modelsBefore, "utf8");
				write(modelsPath, modelsAfter);
			}
			report.configured.push(`omp (${cfgPath} + ${modelsPath}; auto-model-router/auto is ready to pick)`);
		}
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

	// 6. Claude Code: its settings file carries the base URL (the `env` block) and a key
	// helper, a command it runs for the key — so the key is never in its environment or
	// on disk for it. Without a refresh token the helper still works (it prints the key it
	// holds); the helper is what lets a short-lived key rotate underneath a running session.
	const claudeDir = join(o.home, ".claude");
	if (wants(o, "claude") && (o.pathHas("claude") || existsSync(claudeDir))) {
		const settingsPath = join(claudeDir, "settings.json");
		let settings: Record<string, unknown> = {};
		const before = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
		try {
			settings = before === "" ? {} : (JSON.parse(before) as Record<string, unknown>);
		} catch {
			report.notes.push(`${settingsPath} is not valid JSON; left alone — set env.ANTHROPIC_BASE_URL and apiKeyHelper by hand`);
			settings = {};
		}
		const env: Record<string, unknown> = { ...((settings.env as Record<string, unknown> | undefined) ?? {}), ANTHROPIC_BASE_URL: o.url };
		// Never leave a stale key beside the helper: the helper is the source now.
		delete env.ANTHROPIC_API_KEY;
		// The executable is its own helper; under bun the source entry is.
		const helper = o.exePath !== undefined && o.exePath !== "" ? `"${o.exePath.replaceAll("\\", "/")}" token` : `bun run "${resolve(o.packageDir, "src", "index.ts").replaceAll("\\", "/")}" token`;
		const next = { ...settings, env, apiKeyHelper: helper };
		const after = `${JSON.stringify(next, null, 2)}\n`;
		if (after !== before) {
			if (before !== "" && !o.dryRun) writeFileSync(`${settingsPath}.${new Date().toISOString().replaceAll(":", "-")}.bak`, before, "utf8");
			write(settingsPath, after);
		}
		report.configured.push(`Claude Code (${settingsPath}: env.ANTHROPIC_BASE_URL + apiKeyHelper; open a new session)`);
	} else report.skipped.push("Claude Code (not on PATH and no ~/.claude)");
	report.envLines.unshift(`AUTO_MODEL_ROUTER_URL=${o.url}`, `AUTO_MODEL_ROUTER_API_KEY=${o.key}`);
	report.envLines = [...new Set(report.envLines)];

	// 7. Persist the environment.
	if (o.profile && !o.dryRun) {
		if (o.platform === "win32") {
			for (const line of report.envLines) {
				const [k, ...v] = line.split("=");
				Bun.spawnSync(["setx", k!, v.join("=")], { stdout: "ignore", stderr: "ignore" });
			}
			// Not setx for PATH: it truncates at 1024 characters and would eat the rest.
			if (o.exePath !== undefined && o.exePath !== "") addToUserPathWindows(dirname(o.exePath));
			report.notes.push("user environment variables set with setx; open a new terminal");
		} else {
			const shell = o.env.SHELL ?? "";
			const rc = shell.includes("zsh") ? join(o.home, ".zshrc") : join(o.home, ".bashrc");
			const pathLine = o.exePath !== undefined && o.exePath !== "" ? [`export PATH="${dirname(o.exePath)}:$PATH"`] : [];
			const block = `\n# auto-model-router remote (added by \`auto-model-router connect\`)\n${[...report.envLines.map((l) => `export ${l}`), ...pathLine].join("\n")}\n`;
			const before = existsSync(rc) ? readFileSync(rc, "utf8") : "";
			if (!before.includes("# auto-model-router remote") && !before.includes("# auto-model-router team")) appendFileSync(rc, block, "utf8");
			else write(rc, before.replace(/\n# auto-model-router (?:remote|team)[^\n]*\n(?:export [^\n]*\n)*/, block));
			report.notes.push(`environment appended to ${rc}; open a new shell or source it`);
		}
	} else report.notes.push("add the environment lines to your shell profile, or re-run with --profile");
	report.notes.push("omp's models.yml now carries the member key; treat that file as a secret");
	if (o.refreshToken !== undefined && o.refreshToken !== "") report.notes.push("the key is short-lived: omp refreshes it at session start; `auto-model-router refresh` does it by hand, and `auto-model-router token` prints a current key for a harness key-helper");
	return report;
}

/** What a team's one-time setup token is traded for. */
export interface IssuedCredential {
	key: string;
	refreshToken: string;
	keyExpiresAtMs?: number;
	refreshExpiresAtMs?: number;
	userId: string;
	name: string;
}

/**
 * Trades a one-time setup token for this machine's credential at the team's
 * exchange route, so the install needs nothing on the machine but this
 * program: the token is the only secret in the install command and dies on use.
 */
export async function exchangeSetupToken(url: string, token: string, device: string, fetchImpl: typeof fetch = fetch): Promise<IssuedCredential> {
	const res = await fetchImpl(`${url}/setup/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, device }), signal: AbortSignal.timeout(15_000) });
	if (res.status === 401) throw new Error("the setup token was refused (expired or already used); get a new one from the team's portal");
	if (!res.ok) throw new Error(`the team's setup exchange answered ${res.status}`);
	const body = (await res.json()) as Record<string, unknown>;
	if (typeof body.key !== "string" || body.key === "") throw new Error("the team's setup exchange returned no key");
	return {
		key: body.key,
		refreshToken: typeof body.refreshToken === "string" ? body.refreshToken : "",
		...(typeof body.keyExpiresAtMs === "number" ? { keyExpiresAtMs: body.keyExpiresAtMs } : {}),
		...(typeof body.refreshExpiresAtMs === "number" ? { refreshExpiresAtMs: body.refreshExpiresAtMs } : {}),
		userId: typeof body.userId === "string" ? body.userId : "",
		name: typeof body.name === "string" ? body.name : "",
	};
}

/** Adds `dir` to the user's PATH on Windows, once, through the registry-backed API rather than setx. */
function addToUserPathWindows(dir: string): void {
	const quoted = `'${dir.replaceAll("'", "''")}'`;
	const script = `$d=${quoted}; $p=[Environment]::GetEnvironmentVariable('Path','User'); if ($null -eq $p) { $p='' }; if (($p -split ';') -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';' + $d).TrimStart(';')), 'User') }`;
	Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], { stdout: "ignore", stderr: "ignore" });
}

/**
 * Where the harness integrations are read from. Under bun that is this
 * package; in the compiled executable it is the copy written out from the
 * executable's own embedded files.
 */
async function resolvePackageDir(): Promise<string> {
	const embedded = await readEmbeddedPackage();
	if (embedded === null) return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
	const raw = process.env.AUTO_MODEL_ROUTER_HOME ?? join(homedir(), ".auto-model-router");
	return materializePackage(expand(raw, homedir()), embedded);
}

export async function connectCommand(args: CliArgs): Promise<void> {
	const url = (flagString(args, "url") ?? process.env.AUTO_MODEL_ROUTER_URL ?? "").replace(/\/+$/, "");
	let key = flagString(args, "key") ?? process.env.AUTO_MODEL_ROUTER_API_KEY ?? "";
	const setupToken = flagString(args, "setup-token") ?? "";
	if (url === "" || (key === "" && setupToken === "")) throw new Error("connect needs --url <remote router> and either --key <its key> or --setup-token <one-time token from the team>");
	const only = (flagString(args, "harness") ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
	const pathHas = (bin: string): boolean => Bun.which(bin) !== null;
	const packageDir = await resolvePackageDir();
	const exePath = executablePath();
	let name = flagString(args, "name") ?? "";
	let userId = flagString(args, "user-id") ?? "";
	let device = flagString(args, "device") ?? "";
	// A remote that issues short-lived keys hands these over beside the key.
	let refreshToken = flagString(args, "refresh-token") ?? "";
	let keyExpires = Number.parseInt(flagString(args, "key-expires") ?? "", 10);
	let refreshExpires = Number.parseInt(flagString(args, "refresh-expires") ?? "", 10);
	if (setupToken !== "") {
		if (device === "") device = hostname();
		const issued = await exchangeSetupToken(url, setupToken, device);
		key = issued.key;
		refreshToken = issued.refreshToken;
		keyExpires = issued.keyExpiresAtMs ?? Number.NaN;
		refreshExpires = issued.refreshExpiresAtMs ?? Number.NaN;
		if (issued.userId !== "") userId = issued.userId;
		if (issued.name !== "") name = issued.name;
		console.log(`credential issued for ${name === "" ? userId : name} (device ${device})`);
	}
	// Verify the key against the route every router serves before touching anything.
	try {
		const res = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10_000) });
		if (res.status === 401) throw new Error("the remote router rejected this key");
	} catch (err) {
		if (err instanceof Error && err.message.includes("rejected")) throw err;
		console.log(`warning: could not reach ${url} to verify the key (${err instanceof Error ? err.message : String(err)}); configuring anyway`);
	}
	// HOME wins when set (Git Bash, WSL, CI) so a caller can redirect every write; the OS profile otherwise.
	const home = process.env.HOME !== undefined && process.env.HOME !== "" ? process.env.HOME : homedir();
	// A single-project machine can label every request; a machine with several
	// repos should leave it off and let the extensions send the workspace's own.
	const scopeFlag = flagString(args, "scope");
	const report = connectRemote({
		url,
		key,
		userId,
		name,
		profile: args.flags.has("profile"),
		dryRun: args.flags.has("dry-run"),
		only,
		env: process.env,
		home,
		packageDir,
		platform: process.platform,
		pathHas,
		...(scopeFlag === undefined ? {} : { agentdoxScope: scopeFlag }),
		...(refreshToken === "" ? {} : { refreshToken }),
		...(Number.isFinite(keyExpires) ? { keyExpiresAtMs: keyExpires } : {}),
		...(Number.isFinite(refreshExpires) ? { refreshExpiresAtMs: refreshExpires } : {}),
		...(device === "" ? {} : { device }),
		...(exePath === null ? {} : { exePath }),
	});
	if (exePath !== null) console.log(`executable ${exePath}; package files under ${packageDir}`);
	console.log(`${args.flags.has("dry-run") ? "would write" : "wrote"} ${report.remoteFile}${name === "" ? "" : ` for ${name}`}`);
	for (const c of report.configured) console.log(`  configured ${c}`);
	for (const s of report.skipped) console.log(`  skipped    ${s}`);
	console.log("environment:");
	for (const l of report.envLines) console.log(`  ${process.platform === "win32" ? "$env:" : "export "}${process.platform === "win32" ? l.replace("=", '="') + '"' : l}`);
	for (const n of report.notes) console.log(`note: ${n}`);
}
