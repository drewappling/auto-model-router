import { describe, expect, test } from "bun:test";

import { WIZARD_SECTIONS } from "../src/cli/config-wizard.ts";
import type { FieldSpec } from "../src/cli/config-wizard.ts";

import { editProfile, walkSection, type ConfigUi } from "../omp-extension/configure-logic.ts";

function makeUi(script: Array<{ type: "select" | "input" | "confirm"; value?: string | boolean | undefined }>): ConfigUi {
	const calls = script.slice();
	return {
		async select(_title, _options) {
			const call = calls.shift();
			if (call?.type !== "select") throw new Error("expected select, got " + JSON.stringify(call));
			if (call.value === undefined) return undefined;
			return call.value as string;
		},
		async input(_title, _placeholder, _initial) {
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
		expect(placeholders).toEqual(["set"]);
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
