import { describe, expect, test } from "bun:test";

import { WIZARD_SECTIONS } from "../src/cli/config-wizard.ts";
import type { FieldSpec } from "../src/cli/config-wizard.ts";

import { editProfile, editSectionMenu, walkSection, type ConfigUi, type SelectOption } from "../omp-extension/configure-logic.ts";

function makeUi(script: Array<{ type: "select" | "input" | "confirm"; value?: string | boolean | undefined }>): ConfigUi {
	const calls = script.slice();
	return {
		async select(_title, _options) {
			const call = calls.shift();
			if (call?.type !== "select") throw new Error("expected select, got " + JSON.stringify(call));
			if (call.value === undefined) return undefined;
			return call.value as string;
		},
		async input(_title, _placeholder) {
			const call = calls.shift();
			if (call?.type !== "input") throw new Error("expected input, got " + JSON.stringify(call));
			if (call.value === undefined) return undefined;
			return call.value as string;
		},
		async confirm() {
			const call = calls.shift();
			if (call?.type !== "confirm") throw new Error("expected confirm, got " + JSON.stringify(call));
			return call.value as boolean;
		},
		notify(_text, _level) {},
	};
}
/** One "keep" answer per field of a section, with overrides by dotted path. */
function keepAll(section: { fields: readonly FieldSpec[] }, overrides: Record<string, string> = {}) {
	return section.fields.map((f) => {
		const value = overrides[f.path] ?? "";
		if (f.kind === "boolean" || f.kind === "enum") {
			// A cancelled select aborts the walk, so an optional boolean keeps
			// "unset" and everything else must be given a value by the caller.
			return { type: "select" as const, value: value !== "" ? value : f.kind === "boolean" && f.optional === true ? "unset" : undefined };
		}
		return { type: "input" as const, value };
	});
}

const baseCfg = {
	server: { host: "127.0.0.1", port: 8788, apiKey: undefined, harnessId: undefined },
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1",
		title: "auto-model-router",
		timeoutMs: 600000,
		catalogTtlMs: 3600000,
		catalogRefreshMs: 300000,
	},
	adaptiveTierFloors: true,
	tiers: {},
	tasks: {},
	filters: {},
	classifier: {},
	escalation: {},
	hysteresis: {},
	cache: {},
	budget: { onExceeded: "downgrade" },
	profiles: [],
	ledger: {},
	logLevel: "info",
} as never;

const serverSection = WIZARD_SECTIONS.find((s) => s.title === "Server")!;

describe("promptField via walkSection", () => {
	test("empty answer keeps the current value (no change)", async () => {
		const ui = makeUi(keepAll(serverSection));
		const answers: Record<string, unknown> = {};
		const changed = await walkSection(ui, serverSection, baseCfg, answers);
		expect(changed).toBe(false);
		expect(answers).toEqual({});
	});

	test("an edit is collected under its dotted path", async () => {
		const ui = makeUi(keepAll(serverSection, { "server.host": "127.0.0.2" }));
		const answers: Record<string, unknown> = {};
		const changed = await walkSection(ui, serverSection, baseCfg, answers);
		expect(changed).toBe(true);
		expect(answers).toEqual({ "server.host": "127.0.0.2" });
	});

	test("cancelling a dialog aborts the walk", async () => {
		const ui = makeUi([{ type: "input", value: undefined }]);
		const answers: Record<string, unknown> = {};
		const changed = await walkSection(ui, serverSection, baseCfg, answers);
		expect(changed).toBe(false);
		expect(answers).toEqual({});
	});

	test("CLEAR_TOKEN clears an optional field to null", async () => {
		const ui = makeUi(keepAll(serverSection, { "server.apiKey": "-" }));
		const answers: Record<string, unknown> = {};
		const changed = await walkSection(ui, serverSection, baseCfg, answers);
		expect(changed).toBe(true);
		expect(answers).toEqual({ "server.apiKey": null });
	});

	test("boolean fields use the select dialog", async () => {
		const tiers = WIZARD_SECTIONS.find((s) => s.title === "Tiers")!;
		// Booleans and enums prompt through select; a cancelled select would
		// abort, so every boolean/enum in the section is answered with its
		// current value except the one under test.
		const script = keepAll(tiers, { adaptiveTierFloors: "false", adaptivePriceCeilings: "false" });
		for (const call of script) if (call.type === "select" && call.value === undefined) call.value = "false";
		const ui = makeUi(script);
		const answers: Record<string, unknown> = {};
		await walkSection(ui, tiers, { ...(baseCfg as object), adaptivePriceCeilings: false } as never, answers);
		expect(answers).toEqual({ adaptiveTierFloors: false });
	});

	test("an optional boolean can be cleared back to unset", async () => {
		const field: FieldSpec = { path: "tiers.hard.qualityNormalization", label: "norm", kind: "boolean", optional: true };
		const section = { title: "t", fields: [field] };
		const answers: Record<string, unknown> = {};
		await walkSection(makeUi([{ type: "select", value: "unset" }]), section, { tiers: { hard: { qualityNormalization: true } } } as never, answers);
		expect(answers).toEqual({ "tiers.hard.qualityNormalization": null });
		const none: Record<string, unknown> = {};
		await walkSection(makeUi([{ type: "select", value: "unset" }]), section, { tiers: { hard: {} } } as never, none);
		expect(none).toEqual({});
	});

	test("re-entering an unchanged array is not an edit", async () => {
		const field: FieldSpec = { path: "filters.deny", label: "deny", kind: "stringArray" };
		const section = { title: "t", fields: [field] };
		const answers: Record<string, unknown> = {};
		const changed = await walkSection(makeUi([{ type: "input", value: "a, b" }]), section, { filters: { deny: ["a", "b"] } } as never, answers);
		expect(changed).toBe(false);
		expect(answers).toEqual({});
	});

	test("a secret field is prompted with set/unset, never its value", async () => {
		const field: FieldSpec = { path: "openrouter.apiKey", label: "key", kind: "string", optional: true, secret: true };
		const placeholders: string[] = [];
		const ui: ConfigUi = {
			async select() { return undefined; },
			async input(_t, placeholder) { placeholders.push(placeholder ?? ""); return ""; },
			async confirm() { return false; },
			notify() {},
		};
		await walkSection(ui, { title: "t", fields: [field] }, { openrouter: { apiKey: "sk-secret" } } as never, {});
		expect(placeholders[0]).toStartWith("set  (");
		expect(placeholders[0]).not.toContain("sk-secret");
	});
});

describe("current value is visible in every dialog", () => {
	/** A UI that records what each dialog showed and answers from a script. */
	function recordingUi(script: Array<string | undefined>) {
		const shown: { title: string; options?: SelectOption[]; placeholder?: string }[] = [];
		const ui: ConfigUi = {
			async select(title, options) { shown.push({ title, options }); return script.shift(); },
			async input(title, placeholder) { shown.push({ title, ...(placeholder === undefined ? {} : { placeholder }) }); return script.shift(); },
			async confirm() { return false; },
			notify() {},
		};
		return { ui, shown };
	}
	const cfg = { server: { host: "127.0.0.1", port: 8788 }, budget: { onExceeded: "downgrade" }, cache: { injectBreakpoints: true } } as never;

	test("text prompts carry the current value in the title and placeholder", async () => {
		const { ui, shown } = recordingUi([""]);
		const field: FieldSpec = { path: "server.port", label: "Listen port", kind: "number", min: 1, max: 65535 };
		await walkSection(ui, { title: "Server", fields: [field] }, cfg, {});
		expect(shown[0]?.title).toBe("Listen port · current: 8788");
		expect(shown[0]?.placeholder).toContain("8788");
		expect(shown[0]?.placeholder).toContain("Enter keeps");
	});

	test("enum and boolean pickers mark the current option instead of relying on a preselect index", async () => {
		const { ui, shown } = recordingUi(["reject", "false"]);
		const en: FieldSpec = { path: "budget.onExceeded", label: "On exceeded", kind: "enum", options: ["downgrade", "reject"] };
		const bo: FieldSpec = { path: "cache.injectBreakpoints", label: "Inject cache breakpoints", kind: "boolean" };
		const answers: Record<string, unknown> = {};
		await walkSection(ui, { title: "t", fields: [en, bo] }, cfg, answers);
		expect(shown[0]?.title).toBe("On exceeded · current: downgrade");
		expect(shown[0]?.options).toEqual([{ label: "downgrade", description: "current" }, "reject"]);
		expect(shown[1]?.options).toEqual([{ label: "true", description: "current" }, "false"]);
		expect(answers).toEqual({ "budget.onExceeded": "reject", "cache.injectBreakpoints": false });
	});

	test("editSectionMenu lists every field with its current value, edits one, and marks it pending", async () => {
		const section = {
			title: "Server",
			fields: [
				{ path: "server.host", label: "Listen host", kind: "string" },
				{ path: "server.port", label: "Listen port", kind: "number", min: 1 },
			] as FieldSpec[],
		};
		// pick port → type 9000 → picker again → Back
		const { ui, shown } = recordingUi(["Listen port", "9000", "Back"]);
		const answers: Record<string, unknown> = {};
		const changed = await editSectionMenu(ui, section, cfg, answers);
		expect(changed).toBe(true);
		expect(answers).toEqual({ "server.port": 9000 });
		expect(shown[0]?.options).toEqual([
			{ label: "Listen host", description: "127.0.0.1" },
			{ label: "Listen port", description: "8788" },
			"Back",
		]);
		expect(shown[1]?.title).toBe("Listen port · current: 8788");
		// Second picker shows the pending edit, not the on-disk value.
		expect(shown[2]?.title).toBe("Server (edited)");
		expect(shown[2]?.options?.[1]).toEqual({ label: "Listen port", description: "9000  (pending)" });
	});

	test("cancelling a field dialog returns to the picker; cancelling the picker returns", async () => {
		const section = { title: "Server", fields: [{ path: "server.host", label: "Listen host", kind: "string" }] as FieldSpec[] };
		const { ui, shown } = recordingUi(["Listen host", undefined, undefined]);
		const changed = await editSectionMenu(ui, section, cfg, {});
		expect(changed).toBe(false);
		expect(shown).toHaveLength(3);
	});
});

describe("editProfile", () => {
	test("updates a whole profile record", async () => {
		const ui = makeUi([
			{ type: "input", value: "auto-cheap" }, // id
			{ type: "input", value: "Auto Cheap" }, // name
			{ type: "select", value: "trivial" }, // minTier
			{ type: "select", value: "simple" }, // maxTier
			{ type: "input", value: "" }, // contextWindow keep
			{ type: "input", value: "" }, // maxTokens keep
		]);
		const fields = [
			{ path: "id", label: "Model id", kind: "string" },
			{ path: "name", label: "Display name", kind: "string" },
			{ path: "minTier", label: "Floor", kind: "enum", options: ["trivial", "simple", "moderate", "hard"] },
			{ path: "maxTier", label: "Ceiling", kind: "enum", options: ["trivial", "simple", "moderate", "hard"] },
			{ path: "contextWindow", label: "Context", kind: "number", min: 1 },
			{ path: "maxTokens", label: "Max output", kind: "number", min: 1 },
		] as FieldSpec[];
		const out = await editProfile(ui, { id: "auto", name: "Auto", minTier: "trivial", maxTier: "hard", contextWindow: 400000, maxTokens: 32000 }, fields);
		expect(out).toMatchObject({ id: "auto-cheap", name: "Auto Cheap", minTier: "trivial", maxTier: "simple", contextWindow: 400000 });
	});

	test("cancelled profile edit returns null", async () => {
		const ui = makeUi([{ type: "input", value: undefined }]);
		const fields = [{ path: "id", label: "id", kind: "string" }] as FieldSpec[];
		const out = await editProfile(ui, { id: "auto" }, fields);
		expect(out).toBeNull();
	});
});
