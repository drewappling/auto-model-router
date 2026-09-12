import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectRemote, type ConnectOptions, type ConnectReport } from "../src/cli/connect.ts";
import { mergeClineProviders, mergeContinueConfig, mergeOpenCodeConfig } from "../src/cli/harnesses.ts";

/**
 * The harnesses `connect` reaches beyond omp, Hermes, Codex, Aider and Claude
 * Code. Each automated one starts from a fixture in the shape its harness
 * actually writes (`test/fixtures/connect/`), so the assertions are about
 * merging into a REAL file rather than into an empty one: the user's other keys,
 * providers and comments must survive, a second run must change nothing,
 * `--harness <id>` must select exactly one, and a machine without the harness
 * must be told it was skipped rather than have a file invented for it.
 *
 * The two manual harnesses are held to the other half of that promise — they
 * print and write nothing at all.
 */

const FIXTURES = join(import.meta.dir, "fixtures", "connect");

/** A temp HOME with nothing in it: every harness is absent until a test plants one. */
function bare(extra: Partial<ConnectOptions> = {}): { home: string; o: ConnectOptions } {
	const home = mkdtempSync(join(tmpdir(), "amr-harness-"));
	const o: ConnectOptions = {
		url: "https://team.example",
		key: "amrt_key",
		userId: "u_ada",
		name: "Ada",
		profile: false,
		dryRun: false,
		only: [],
		// Point every harness this suite does not exercise at a path that does not exist.
		env: { HOME: home, PI_CODING_AGENT_DIR: join(home, "no-omp"), HERMES_HOME: join(home, "no-hermes"), AUTO_MODEL_ROUTER_HOME: join(home, ".auto-model-router"), XDG_CONFIG_HOME: join(home, ".config") },
		home,
		packageDir: process.cwd(),
		platform: "linux",
		pathHas: () => false,
		...extra,
	};
	return { home, o };
}

/** Plants a captured config file for a harness under the temp HOME. */
function plant(home: string, fixture: string, ...rel: string[]): string {
	const target = join(home, ...rel);
	mkdirSync(join(target, ".."), { recursive: true });
	cpSync(join(FIXTURES, fixture), target);
	return target;
}

const configuredFor = (r: ConnectReport, prefix: string): string | undefined => r.configured.find((c) => c.startsWith(prefix));
const backupsIn = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(".bak"));

describe("OpenCode", () => {
	test("the provider block is merged into opencode.json, the plugin is copied, and a second run changes nothing", async () => {
		const { home, o } = bare();
		const dir = join(home, ".config", "opencode");
		const cfg = plant(home, "opencode.json", ".config", "opencode", "opencode.json");
		try {
			const r = connectRemote(o);
			expect(configuredFor(r, "OpenCode (")).toContain("opencode.json");
			// The exact file: our provider added, `model` pointed at it, and every
			// other key — the schema, the MCP server, the user's own Ollama provider — kept.
			expect(JSON.parse(readFileSync(cfg, "utf8"))).toEqual({
				$schema: "https://opencode.ai/config.json",
				model: "auto-model-router/auto",
				mcp: { unityMCP: { type: "remote", url: "http://127.0.0.1:8080/mcp", enabled: true } },
				provider: {
					ollama: {
						npm: "@ai-sdk/openai-compatible",
						name: "Ollama",
						options: { baseURL: "http://localhost:11434/v1" },
						models: { "qwen2.5:7b": { name: "Qwen2.5 7B (local)" } },
					},
					"auto-model-router": {
						npm: "@ai-sdk/openai-compatible",
						name: "auto-model-router",
						options: { baseURL: "https://team.example/v1", apiKey: "amrt_key", headers: { "X-Omp-Harness": "opencode" } },
						models: { auto: { name: "auto" }, "auto-cheap": { name: "auto-cheap" }, "auto-max": { name: "auto-max" } },
					},
				},
			});
			// The plugin is what gives OpenCode session identity, the toast and the digest.
			expect(readFileSync(join(dir, "plugin", "auto-model-router.ts"), "utf8")).toContain("chat.headers");
			expect(backupsIn(dir)).toHaveLength(1); // the previous file was kept
			const after = readFileSync(cfg, "utf8");
			connectRemote(o);
			expect(readFileSync(cfg, "utf8")).toBe(after);
			expect(backupsIn(dir)).toHaveLength(1); // and a no-op run backs nothing up
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("--harness opencode selects it alone, and an absent OpenCode is reported as skipped", async () => {
		const { home, o } = bare({ only: ["opencode"] });
		plant(home, "opencode.json", ".config", "opencode", "opencode.json");
		try {
			expect(connectRemote(o).configured.map((c) => c.split(" (")[0])).toEqual(["OpenCode"]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
		const { home: h2, o: o2 } = bare();
		try {
			expect(connectRemote(o2).skipped).toContain("OpenCode (not on PATH and no ~/.config/opencode)");
			expect(existsSync(join(h2, ".config", "opencode"))).toBe(false);
		} finally {
			rmSync(h2, { recursive: true, force: true });
		}
	});

	test("a pinned scope rides in the provider's headers; a file we cannot parse is left alone", async () => {
		expect(JSON.parse(mergeOpenCodeConfig("", "https://t", "k", "omp-router")!).provider["auto-model-router"].options.headers).toEqual({ "X-Omp-Harness": "opencode", "X-Agentdox-Scope": "omp-router" });
		expect(mergeOpenCodeConfig("[]", "https://t", "k")).toBeNull();
		expect(mergeOpenCodeConfig("{ not json", "https://t", "k")).toBeNull();
		expect(mergeOpenCodeConfig(mergeOpenCodeConfig("", "https://t", "k")!, "https://t", "k")).toBeNull();
	});
});

describe("Cline", () => {
	const REL = [".cline", "data", "settings"];

	test("the openai-compatible provider is merged into providers.json beside the user's own, and a second run changes nothing", async () => {
		const { home, o } = bare();
		const dir = join(home, ...REL);
		const cfg = plant(home, "cline-providers.json", ...REL, "providers.json");
		try {
			const r = connectRemote(o);
			expect(configuredFor(r, "Cline (")).toContain("providers.json");
			const written = JSON.parse(readFileSync(cfg, "utf8")) as Record<string, unknown>;
			// The harness id can only travel in `settings.headers`: cline's own auth
			// command has no flag for it, which is why connect writes the file itself.
			expect((written.providers as Record<string, { settings: unknown }>)["openai-compatible"]!.settings).toEqual({
				provider: "openai-compatible",
				apiKey: "amrt_key",
				model: "auto",
				baseUrl: "https://team.example/v1",
				headers: { "X-Omp-Harness": "cline" },
			});
			expect(written.lastUsedProvider).toBe("openai-compatible");
			expect(written.version).toBe(1);
			// The user's other provider is untouched, key and stamp included.
			expect((written.providers as Record<string, unknown>).anthropic).toEqual({
				settings: { provider: "anthropic", apiKey: "sk-ant-existing", model: "claude-sonnet-4-5" },
				updatedAt: "2026-09-10T05:27:55.818Z",
				tokenSource: "manual",
			});
			expect(backupsIn(dir)).toHaveLength(1);
			const after = readFileSync(cfg, "utf8");
			connectRemote(o);
			expect(readFileSync(cfg, "utf8")).toBe(after);
			expect(backupsIn(dir)).toHaveLength(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("--harness cline selects it alone, and an absent Cline is reported as skipped", async () => {
		const { home, o } = bare({ only: ["cline"] });
		plant(home, "cline-providers.json", ...REL, "providers.json");
		try {
			expect(connectRemote(o).configured.map((c) => c.split(" (")[0])).toEqual(["Cline"]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
		const { home: h2, o: o2 } = bare();
		try {
			expect(connectRemote(o2).skipped).toContain("Cline (not on PATH and no ~/.cline)");
			expect(existsSync(join(h2, ".cline"))).toBe(false);
		} finally {
			rmSync(h2, { recursive: true, force: true });
		}
	});

	test("the stamp only moves when the settings do, a pinned scope rides along, and an unreadable file is left alone", async () => {
		const first = mergeClineProviders("", "https://t", "k", "2026-01-01T00:00:00.000Z", "omp-router")!;
		expect(JSON.parse(first).providers["openai-compatible"].settings.headers).toEqual({ "X-Omp-Harness": "cline", "X-Agentdox-Scope": "omp-router" });
		expect(mergeClineProviders(first, "https://t", "k", "2027-01-01T00:00:00.000Z", "omp-router")).toBeNull();
		// A new key is a real change, so the stamp does move.
		const rekeyed = mergeClineProviders(first, "https://t", "k2", "2027-01-01T00:00:00.000Z", "omp-router")!;
		expect(JSON.parse(rekeyed).providers["openai-compatible"].updatedAt).toBe("2027-01-01T00:00:00.000Z");
		expect(mergeClineProviders("nope", "https://t", "k", "2026-01-01T00:00:00.000Z")).toBeNull();
	});
});

describe("Continue", () => {
	test("the three profiles become model entries in config.yaml, keeping the file's comments, and a second run changes nothing", async () => {
		const { home, o } = bare();
		const dir = join(home, ".continue");
		const cfg = plant(home, "continue-config.yaml", ".continue", "config.yaml");
		try {
			const r = connectRemote(o);
			expect(configuredFor(r, "Continue (")).toContain("config.yaml");
			const text = readFileSync(cfg, "utf8");
			// The document is edited, not re-serialised: comments, the user's own model
			// and the context blocks are all still there, in their original order.
			expect(text).toContain("# My Continue assistant — hand-edited, comments and all.");
			expect(text).toContain("name: Local Assistant");
			expect(text).toContain("  - name: Ollama Qwen");
			expect(text.indexOf("context:")).toBeGreaterThan(text.indexOf("auto-model-router-max"));
			for (const [name, model] of [
				["auto-model-router", "auto"],
				["auto-model-router-cheap", "auto-cheap"],
				["auto-model-router-max", "auto-max"],
			]) {
				expect(text).toContain(`  - name: ${name}\n    provider: openai\n    model: ${model}\n    apiBase: https://team.example/v1\n    apiKey: amrt_key\n`);
			}
			expect(text).toContain("        X-Omp-Harness: continue");
			expect(backupsIn(dir)).toHaveLength(1);
			connectRemote(o);
			expect(readFileSync(cfg, "utf8")).toBe(text);
			expect(backupsIn(dir)).toHaveLength(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("--harness continue selects it alone, and an absent Continue is reported as skipped", async () => {
		const { home, o } = bare({ only: ["continue"] });
		plant(home, "continue-config.yaml", ".continue", "config.yaml");
		try {
			expect(connectRemote(o).configured.map((c) => c.split(" (")[0])).toEqual(["Continue"]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
		const { home: h2, o: o2 } = bare();
		try {
			expect(connectRemote(o2).skipped).toContain("Continue (no ~/.continue)");
			expect(existsSync(join(h2, ".continue"))).toBe(false);
		} finally {
			rmSync(h2, { recursive: true, force: true });
		}
	});

	test("a fresh file gets the schema's required fields first, a re-key replaces entries in place, and broken YAML is left alone", async () => {
		const fresh = mergeContinueConfig("", "https://t", "k")!;
		expect(fresh.startsWith("name: auto-model-router\nversion: 0.0.1\nschema: v1\nmodels:\n  - name:")).toBe(true);
		expect(mergeContinueConfig(fresh, "https://t", "k")).toBeNull();
		const rekeyed = mergeContinueConfig(fresh, "https://t", "k2")!;
		expect(rekeyed.match(/- name: auto-model-router\n/g)).toHaveLength(1); // replaced, not appended
		expect(rekeyed).toContain("apiKey: k2");
		expect(rekeyed).not.toContain("apiKey: k\n");
		expect(mergeContinueConfig("models:\n  - [unclosed\n", "https://t", "k")).toBeNull();
		expect(mergeContinueConfig("- a\n- b\n", "https://t", "k")).toBeNull(); // a sequence is not an assistant file
	});
});

describe("Cursor and Windsurf keep their provider settings where no file can reach them", () => {
	test("connect prints what to set and writes nothing under either home", async () => {
		const { home, o } = bare({ only: ["cursor", "windsurf"] });
		mkdirSync(join(home, ".cursor"), { recursive: true });
		mkdirSync(join(home, ".codeium", "windsurf"), { recursive: true });
		try {
			const r = connectRemote(o);
			expect(r.configured).toEqual([]);
			expect(r.manual.map((m) => m.harness)).toEqual(["Cursor", "Windsurf"]);
			const cursor = r.manual[0]!.lines.join("\n");
			expect(cursor).toContain("base URL: https://team.example/v1");
			expect(cursor).toContain("API key:  amrt_key");
			// Windsurf has no base-URL field of its own, so the useful answer is the extension.
			expect(r.manual[1]!.lines.join("\n")).toContain("Cline extension");
			// Nothing was written into either harness's directory.
			expect(readdirSync(join(home, ".cursor"))).toEqual([]);
			expect(readdirSync(join(home, ".codeium", "windsurf"))).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a loopback router is called out for Cursor, which proxies chat through its own servers", async () => {
		const { home, o } = bare({ only: ["cursor"], url: "http://127.0.0.1:8788" });
		mkdirSync(join(home, ".cursor"), { recursive: true });
		try {
			expect(connectRemote(o).manual[0]!.lines.join("\n")).toContain("reachable from the internet");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
		// A public remote gets no such warning, and an uninstalled Cursor gets no recipe.
		const { home: h2, o: o2 } = bare({ only: ["cursor"] });
		mkdirSync(join(h2, ".cursor"), { recursive: true });
		try {
			expect(connectRemote(o2).manual[0]!.lines.join("\n")).not.toContain("reachable from the internet");
		} finally {
			rmSync(h2, { recursive: true, force: true });
		}
		const { home: h3, o: o3 } = bare();
		try {
			const r = connectRemote(o3);
			expect(r.manual).toEqual([]);
			expect(r.skipped).toContain("Cursor (no ~/.cursor)");
			expect(r.skipped).toContain("Windsurf (no ~/.codeium)");
		} finally {
			rmSync(h3, { recursive: true, force: true });
		}
	});
});
