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
		const ui = makeUi([
			{ type: "input", value: "" }, // keep host
			{ type: "input", value: "" }, // keep port
			{ type: "input", value: "" }, // keep apiKey
			{ type: "input", value: "" }, // keep harnessId
		]);
		const answers: Record<string, unknown> = {};
		const changed = await walkSection(ui, serverSection, baseCfg, answers);
		expect(changed).toBe(false);
		expect(answers).toEqual({});
	});

	test("an edit is collected under its dotted path", async () => {
		const ui = makeUi([
			{ type: "input", value: "127.0.0.2" }, // host
			{ type: "input", value: "" }, // keep port
			{ type: "input", value: "" }, // keep apiKey
			{ type: "input", value: "" }, // keep harnessId
		]);
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
		const ui = makeUi([
			{ type: "input", value: "" }, // host
			{ type: "input", value: "" }, // port
			{ type: "input", value: "-" }, // clear apiKey
			{ type: "input", value: "" }, // harnessId
		]);
		const answers: Record<string, unknown> = {};
		const changed = await walkSection(ui, serverSection, baseCfg, answers);
		expect(changed).toBe(true);
		expect(answers).toEqual({ "server.apiKey": null });
	});

	test("boolean fields use the select dialog", async () => {
		const adaptive = WIZARD_SECTIONS.find((s) => s.title === "Tiers")!;
		const ui = makeUi([
			{ type: "select", value: "false" }, // adaptiveTierFloors
			{ type: "input", value: "" }, // trivial minQuality
			{ type: "input", value: "" }, // trivial maxInputPerMtok
			{ type: "input", value: "" }, // simple minQuality
			{ type: "input", value: "" }, // simple maxInputPerMtok
			{ type: "input", value: "" }, // moderate minQuality
			{ type: "input", value: "" }, // moderate maxInputPerMtok
			{ type: "input", value: "" }, // hard minQuality
			{ type: "input", value: "" }, // hard maxInputPerMtok
		]);
		const answers: Record<string, unknown> = {};
		await walkSection(ui, adaptive, baseCfg, answers);
		expect(answers).toEqual({ adaptiveTierFloors: false });
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
