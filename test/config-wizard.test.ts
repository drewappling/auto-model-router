import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { writeRouterConfig } from "../src/cli/config-cmd.ts";
import {
	applyAnswers,
	CLEAR_TOKEN,
	formatValue,
	getPath,
	mergeConfigPartial,
	runWizard,
	ScriptedLineSource,
	setPath,
	StreamLineSource,
	validateField,
	WIZARD_SECTIONS,
	type FieldSpec,
	type WizardIo,
} from "../src/cli/config-wizard.ts";
import { loadConfig } from "../src/config/load.ts";

const cfg = loadConfig({});

/** Section numbers as shown in the menu (1-based, in declaration order). */
const SECTION = new Map(WIZARD_SECTIONS.map((s, i) => [s.title, String(i + 1)]));

/** Drives the wizard with a scripted answer list, capturing written output. */
async function drive(lines: string[]): Promise<{
	partial: Record<string, unknown> | null;
	changed: number;
	out: string;
}> {
	let out = "";
	const io: WizardIo = {
		read: new ScriptedLineSource(lines),
		write: (text) => {
			out += text;
		},
	};
	const result = await runWizard(cfg, io);
	return { partial: result.partial, changed: result.changed, out };
}

describe("getPath / setPath", () => {
	test("reads nested and top-level config paths", () => {
		expect(getPath(cfg, "server.port")).toBe(cfg.server.port);
		expect(getPath(cfg, "logLevel")).toBe(cfg.logLevel);
		expect(getPath(cfg, "tiers.hard.minQuality")).toBe(cfg.tiers.hard.minQuality);
	});

	test("returns undefined for missing paths without throwing", () => {
		expect(getPath(cfg, "nope.missing.deep")).toBeUndefined();
		expect(getPath(null, "a.b")).toBeUndefined();
	});

	test("creates intermediate objects", () => {
		const target: Record<string, unknown> = {};
		setPath(target, "a.b.c", 1);
		expect(target).toEqual({ a: { b: { c: 1 } } });
	});

	test("replaces a non-object on the path rather than throwing", () => {
		const target: Record<string, unknown> = { a: 5 };
		setPath(target, "a.b", 1);
		expect(target).toEqual({ a: { b: 1 } });
	});
});

describe("validateField", () => {
	const num: FieldSpec = { path: "n", label: "n", kind: "number", min: 0, max: 10 };
	const opt: FieldSpec = { path: "o", label: "o", kind: "number", min: 0, optional: true };
	const bool: FieldSpec = { path: "b", label: "b", kind: "boolean" };
	const en: FieldSpec = { path: "e", label: "e", kind: "enum", options: ["a", "b"] };
	const arr: FieldSpec = { path: "a", label: "a", kind: "stringArray" };

	test("accepts in-range numbers", () => {
		expect(validateField(num, "5")).toEqual({ ok: true, value: 5 });
		expect(validateField(num, " 0 ")).toEqual({ ok: true, value: 0 });
	});

	test("rejects non-numbers and out-of-range numbers", () => {
		expect(validateField(num, "abc").ok).toBe(false);
		expect(validateField(num, "-1").ok).toBe(false);
		expect(validateField(num, "11").ok).toBe(false);
		expect(validateField(num, "Infinity").ok).toBe(false);
	});

	test("parses both boolean spellings", () => {
		for (const yes of ["y", "yes", "true", "1", "on", "Y", "TRUE"]) {
			expect(validateField(bool, yes)).toEqual({ ok: true, value: true });
		}
		for (const no of ["n", "no", "false", "0", "off"]) {
			expect(validateField(bool, no)).toEqual({ ok: true, value: false });
		}
		expect(validateField(bool, "maybe").ok).toBe(false);
	});

	test("enforces enum options", () => {
		expect(validateField(en, "b")).toEqual({ ok: true, value: "b" });
		const bad = validateField(en, "z");
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain("a, b");
	});

	test("splits and trims string arrays, dropping blanks", () => {
		expect(validateField(arr, "x, y ,, z")).toEqual({ ok: true, value: ["x", "y", "z"] });
	});

	test("clear token is allowed only on optional fields", () => {
		expect(validateField(opt, CLEAR_TOKEN)).toEqual({ ok: true, value: null });
		expect(validateField(num, CLEAR_TOKEN).ok).toBe(false);
	});
});

describe("applyAnswers", () => {
	test("nests a flat edit map into a deep partial", () => {
		expect(
			applyAnswers({
				"server.port": 9000,
				"budget.perDayUsd": 0.5,
				"tiers.hard.minQuality": 80,
			}),
		).toEqual({
			server: { port: 9000 },
			budget: { perDayUsd: 0.5 },
			tiers: { hard: { minQuality: 80 } },
		});
	});
});

describe("mergeConfigPartial", () => {
	test("deep-merges without clobbering sibling keys", () => {
		const merged = mergeConfigPartial(
			{ server: { host: "127.0.0.1", port: 8788 } },
			{ server: { port: 9000 } },
		);
		expect(merged).toEqual({ server: { host: "127.0.0.1", port: 9000 } });
	});

	test("a null leaf deletes the key instead of writing null", () => {
		const merged = mergeConfigPartial(
			{ budget: { perDayUsd: 1, onExceeded: "reject" } },
			{ budget: { perDayUsd: null } },
		);
		expect(merged).toEqual({ budget: { onExceeded: "reject" } });
	});

	test("prunes a section left empty by a clear", () => {
		const merged = mergeConfigPartial({ budget: { perDayUsd: 1 } }, { budget: { perDayUsd: null } });
		expect(merged).toEqual({});
	});

	test("replaces arrays wholesale rather than merging by index", () => {
		const merged = mergeConfigPartial(
			{ filters: { deny: ["a", "b", "c"] } },
			{ filters: { deny: ["z"] } },
		);
		expect(merged).toEqual({ filters: { deny: ["z"] } });
	});

	test("does not mutate the base object", () => {
		const base = { server: { port: 8788 } };
		mergeConfigPartial(base, { server: { port: 1 } });
		expect(base).toEqual({ server: { port: 8788 } });
	});
});

describe("formatValue", () => {
	test("renders scalars, arrays, and absent values", () => {
		expect(formatValue(0.5)).toBe("0.5");
		expect(formatValue(true)).toBe("y");
		expect(formatValue(false)).toBe("n");
		expect(formatValue(["a", "b"])).toBe("a, b");
		expect(formatValue([])).toBe("empty");
		expect(formatValue(undefined)).toBe("unset");
		expect(formatValue(null)).toBe("unset");
	});
});

describe("runWizard", () => {
	test("quitting writes nothing", async () => {
		const { partial, changed } = await drive(["q"]);
		expect(partial).toBeNull();
		expect(changed).toBe(0);
	});

	test("saving with no edits writes nothing", async () => {
		const { partial } = await drive(["s"]);
		expect(partial).toBeNull();
	});

	test("end of input aborts without saving", async () => {
		const { partial } = await drive([]);
		expect(partial).toBeNull();
	});

	test("blank answers keep current values; only edits are written", async () => {
		// Server section: host, port, apiKey, harnessId.
		const { partial, changed } = await drive([
			SECTION.get("Server") ?? "",
			"", // keep host
			"9000", // change port
			"", // keep apiKey
			"", // keep harnessId
			"s",
		]);
		expect(partial).toEqual({ server: { port: 9000 } });
		expect(changed).toBe(1);
	});

	test("re-prompts on invalid input and keeps the corrected value", async () => {
		const { partial, out } = await drive([
			SECTION.get("Logging") ?? "",
			"loud", // invalid enum
			"debug", // corrected
			"s",
		]);
		expect(partial).toEqual({ logLevel: "debug" });
		expect(out).toContain("silent, error, warn, info, debug");
	});

	test("clear token clears an optional field", async () => {
		const { partial } = await drive([
			SECTION.get("Budget") ?? "",
			CLEAR_TOKEN, // clear perTurnUsd
			"",
			"",
			"",
			"s",
		]);
		expect(partial).toEqual({ budget: { perTurnUsd: null } });
	});

	test("rejects a bad menu choice and stays in the menu", async () => {
		const { partial, out } = await drive(["99", "zzz", "q"]);
		expect(partial).toBeNull();
		expect(out).toContain("not a choice");
	});

	test("edits across two sections accumulate", async () => {
		const { partial, changed } = await drive([
			SECTION.get("Logging") ?? "",
			"warn",
			SECTION.get("Cache") ?? "",
			"n", // injectBreakpoints
			"", // maxBreakpoints
			"", // minPromptTokens
			"s",
		]);
		expect(partial).toEqual({ logLevel: "warn", cache: { injectBreakpoints: false } });
		expect(changed).toBe(2);
	});

	test("menu shows the pending edit count", async () => {
		const { out } = await drive([SECTION.get("Logging") ?? "", "warn", "q"]);
		expect(out).toContain("1 pending");
	});
});

describe("runWizard: profiles", () => {
	// PROFILE_FIELDS order: id, name, minTier, maxTier, contextWindow, maxTokens.
	const KEEP_ALL = ["", "", "", "", "", ""];

	test("editing one profile field leaves the other profiles intact", async () => {
		const { partial, changed } = await drive([
			"p",
			"1",
			"", // id
			"", // name
			"", // minTier
			"", // maxTier
			"500000", // contextWindow
			"", // maxTokens
			"b",
			"s",
		]);
		expect(changed).toBe(1);
		const profiles = (partial ?? {})["profiles"];
		expect(Array.isArray(profiles)).toBe(true);
		if (!Array.isArray(profiles)) return;
		expect(profiles).toHaveLength(3);
		expect(profiles[0]).toMatchObject({ id: "auto", contextWindow: 500000 });
		expect(profiles[1]).toMatchObject({ id: "auto-cheap", contextWindow: 400000 });
	});

	test("adding a profile appends it", async () => {
		const { partial } = await drive([
			"p",
			"n",
			"auto-fast",
			"Auto Fast",
			"trivial",
			"simple",
			"200000",
			"8000",
			"b",
			"s",
		]);
		const profiles = (partial ?? {})["profiles"];
		expect(Array.isArray(profiles)).toBe(true);
		if (!Array.isArray(profiles)) return;
		expect(profiles).toHaveLength(4);
		expect(profiles[3]).toEqual({
			id: "auto-fast",
			name: "Auto Fast",
			minTier: "trivial",
			maxTier: "simple",
			contextWindow: 200000,
			maxTokens: 8000,
		});
	});

	test("a new profile refuses a blank id", async () => {
		const { out } = await drive(["p", "n", "", "ok-id", "Name", "", "", "", "", "b", "q"]);
		expect(out).toContain("is required");
	});

	test("deleting a profile removes it", async () => {
		const { partial } = await drive(["p", "x2", "b", "s"]);
		const profiles = (partial ?? {})["profiles"];
		expect(Array.isArray(profiles)).toBe(true);
		if (!Array.isArray(profiles)) return;
		expect(profiles.map((p) => (p as Record<string, unknown>)["id"])).toEqual(["auto", "auto-max"]);
	});

	test("refuses to delete the last remaining profile", async () => {
		const { out } = await drive(["p", "x3", "x2", "x1", "b", "q"]);
		expect(out).toContain("cannot delete the last profile");
	});

	test("rejects an out-of-range delete and a bad choice", async () => {
		const { out } = await drive(["p", "x9", "zzz", "b", "q"]);
		expect(out).toContain("no profile 9");
		expect(out).toContain("not a choice");
	});

	test("back without edits records nothing", async () => {
		const { partial } = await drive(["p", "b", "s"]);
		expect(partial).toBeNull();
	});

	test("keeping every field still records the array (idempotent rewrite)", async () => {
		const { partial } = await drive(["p", "1", ...KEEP_ALL, "b", "s"]);
		const profiles = (partial ?? {})["profiles"];
		expect(Array.isArray(profiles)).toBe(true);
		if (!Array.isArray(profiles)) return;
		expect(profiles[0]).toMatchObject({ id: "auto", contextWindow: 400000 });
	});

	test("profile edits survive a round-trip through the config file", () => {
		const dir = mkdtempSync(join(tmpdir(), "ompr-prof-"));
		try {
			const target = join(dir, "config.yml");
			writeRouterConfig(target, {
				profiles: [
					{ id: "only", name: "Only", minTier: "simple", maxTier: "hard", contextWindow: 123456, maxTokens: 4096 },
				],
			});
			const reloaded = loadConfig({ path: target });
			expect(reloaded.profiles).toHaveLength(1);
			expect(reloaded.profiles[0]).toMatchObject({ id: "only", contextWindow: 123456 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("WIZARD_SECTIONS", () => {
	test("required fields resolve against the default config", () => {
		for (const section of WIZARD_SECTIONS) {
			for (const field of section.fields) {
				if (field.optional === true) continue;
				expect(getPath(cfg, field.path), `path ${field.path} should resolve`).not.toBeUndefined();
			}
		}
	});

	test("field paths are unique", () => {
		const paths = WIZARD_SECTIONS.flatMap((s) => s.fields.map((f) => f.path));
		expect(new Set(paths).size).toBe(paths.length);
	});

	test("every enum field declares its options", () => {
		for (const section of WIZARD_SECTIONS) {
			for (const field of section.fields) {
				if (field.kind !== "enum") continue;
				expect((field.options ?? []).length, `${field.path} needs options`).toBeGreaterThan(0);
			}
		}
	});
});

describe("StreamLineSource", () => {
	async function collect(chunks: string[]): Promise<Array<string | null>> {
		const encoder = new TextEncoder();
		async function* gen(): AsyncGenerator<Uint8Array> {
			for (const chunk of chunks) yield encoder.encode(chunk);
		}
		const source = new StreamLineSource(gen());
		const lines: Array<string | null> = [];
		for (;;) {
			const line = await source.next();
			lines.push(line);
			if (line === null) return lines;
		}
	}

	test("splits lines across chunk boundaries", async () => {
		expect(await collect(["a\nb", "c\n"])).toEqual(["a", "bc", null]);
	});

	test("strips CR for Windows line endings", async () => {
		expect(await collect(["a\r\nb\r\n"])).toEqual(["a", "b", null]);
	});

	test("yields a trailing line with no newline", async () => {
		expect(await collect(["only"])).toEqual(["only", null]);
	});

	test("yields blank lines (a bare Enter keypress)", async () => {
		expect(await collect(["\n\n"])).toEqual(["", "", null]);
	});
});

describe("writeRouterConfig", () => {
	function withTemp<T>(fn: (dir: string) => T): T {
		const dir = mkdtempSync(join(tmpdir(), "ompr-cfg-"));
		try {
			return fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	test("creates the file and reloads to the chosen value", () => {
		withTemp((dir) => {
			const target = join(dir, "config.yml");
			const backup = writeRouterConfig(target, { server: { port: 9123 } });
			expect(backup).toBeNull();
			expect(parseYaml(readFileSync(target, "utf8"))).toEqual({ server: { port: 9123 } });
			// The written file must actually load through the real loader.
			expect(loadConfig({ path: target }).server.port).toBe(9123);
		});
	});

	test("preserves unrelated existing keys and backs up the old file", () => {
		withTemp((dir) => {
			const target = join(dir, "config.yml");
			writeFileSync(target, "logLevel: debug\nserver:\n  host: 0.0.0.0\n", "utf8");
			const backup = writeRouterConfig(target, { server: { port: 9123 } });
			expect(backup).not.toBeNull();
			expect(parseYaml(readFileSync(target, "utf8"))).toEqual({
				logLevel: "debug",
				server: { host: "0.0.0.0", port: 9123 },
			});
			if (backup !== null) {
				expect(readFileSync(backup, "utf8")).toContain("logLevel: debug");
			}
		});
	});

	test("refuses to write an invalid config and leaves the file untouched", () => {
		withTemp((dir) => {
			const target = join(dir, "config.yml");
			writeFileSync(target, "logLevel: debug\n", "utf8");
			expect(() => writeRouterConfig(target, { logLevel: "loud" })).toThrow(/invalid config/);
			expect(readFileSync(target, "utf8")).toBe("logLevel: debug\n");
		});
	});

	test("a clear deletes the key from the written file", () => {
		withTemp((dir) => {
			const target = join(dir, "config.yml");
			writeFileSync(target, "budget:\n  perDayUsd: 5\n  onExceeded: reject\n", "utf8");
			writeRouterConfig(target, { budget: { perDayUsd: null } });
			expect(parseYaml(readFileSync(target, "utf8"))).toEqual({ budget: { onExceeded: "reject" } });
		});
	});
});
