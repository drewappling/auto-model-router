/**
 * Interactive configuration wizard for `omp-router config`.
 *
 * Edits the router's OWN config (`~/.omp-router/config.yml`), covering every
 * section: server, openrouter, tiers, tasks, filters, classifier, escalation,
 * hysteresis, cache, budget, ledger, logging.
 *
 * Only fields the user actually changes are written, as a deep-merge partial,
 * so untouched defaults and hand-edited values survive.
 *
 * Input conventions at a field prompt:
 *   - Enter (blank)  keep the current value (nothing written)
 *   - `-`            clear the field (writes null, reverting to no value)
 *   - anything else  parsed per the field kind, validated, re-prompted if bad
 *
 * The terminal plumbing is behind `WizardIo` so the whole flow is testable by
 * feeding a scripted list of answers. We deliberately do NOT use
 * `node:readline/promises`: under Bun, `question()` only resolves the first
 * call when stdin is a pipe, which hangs any scripted or piped run.
 */

import type { RouterConfig } from "../config/types.ts";

/** A pull-based source of input lines. `null` means end of input. */
export interface LineSource {
	next(): Promise<string | null>;
}

/** Terminal plumbing for the wizard: line input plus a write sink. */
export interface WizardIo {
	read: LineSource;
	write(text: string): void;
}

/** A single configurable field. `path` is dotted, e.g. `budget.perDayUsd`. */
export interface FieldSpec {
	path: string;
	label: string;
	kind: "string" | "number" | "boolean" | "enum" | "stringArray";
	/** For `enum`: the allowed values. */
	options?: readonly string[];
	/** For `number`: inclusive bounds. */
	min?: number;
	max?: number;
	/** Whether the field may be cleared to "no value". */
	optional?: boolean;
	/** Short hint shown with the label. */
	hint?: string;
}

/** A wizard section: a titled group of fields. */
export interface SectionSpec {
	title: string;
	fields: readonly FieldSpec[];
}

const AXES = ["coding", "agentic", "intelligence"] as const;

/** Every field the wizard can edit, grouped into the menu's sections. */
export const WIZARD_SECTIONS: readonly SectionSpec[] = [
	{
		title: "Server",
		fields: [
			{ path: "server.host", label: "Listen host", kind: "string" },
			{ path: "server.port", label: "Listen port", kind: "number", min: 1, max: 65535 },
			{ path: "server.apiKey", label: "Client bearer token", kind: "string", optional: true },
			{ path: "server.harnessId", label: "Default harness id", kind: "string", optional: true },
		],
	},
	{
		title: "OpenRouter",
		fields: [
			{ path: "openrouter.baseUrl", label: "Base URL", kind: "string" },
			{ path: "openrouter.title", label: "Attribution title", kind: "string" },
			{ path: "openrouter.timeoutMs", label: "Request timeout", kind: "number", min: 1, hint: "ms" },
			{ path: "openrouter.catalogTtlMs", label: "Catalog TTL", kind: "number", min: 1, hint: "ms" },
			{ path: "openrouter.catalogRefreshMs", label: "Catalog refresh", kind: "number", min: 0, hint: "ms, 0=off" },
		],
	},
	{
		title: "Tiers",
		fields: [
			{
				path: "adaptiveTierFloors",
				label: "Adaptive floors from available models",
				kind: "boolean",
				hint: "keeps every tier populated",
			},
			{ path: "tiers.trivial.minQuality", label: "trivial: min quality", kind: "number", min: 0, max: 100 },
			{ path: "tiers.trivial.maxInputPerMtok", label: "trivial: max input $/Mtok", kind: "number", min: 0, optional: true },
			{ path: "tiers.simple.minQuality", label: "simple: min quality", kind: "number", min: 0, max: 100 },
			{ path: "tiers.simple.maxInputPerMtok", label: "simple: max input $/Mtok", kind: "number", min: 0, optional: true },
			{ path: "tiers.moderate.minQuality", label: "moderate: min quality", kind: "number", min: 0, max: 100 },
			{ path: "tiers.moderate.maxInputPerMtok", label: "moderate: max input $/Mtok", kind: "number", min: 0, optional: true },
			{ path: "tiers.hard.minQuality", label: "hard: min quality", kind: "number", min: 0, max: 100 },
			{ path: "tiers.hard.maxInputPerMtok", label: "hard: max input $/Mtok", kind: "number", min: 0, optional: true },
		],
	},
	{
		title: "Tasks",
		fields: [
			{ path: "tasks.coding.axis", label: "coding: axis", kind: "enum", options: AXES },
			{ path: "tasks.coding.minQuality", label: "coding: quality floor", kind: "number", min: 0, max: 100, optional: true },
			{ path: "tasks.vision.axis", label: "vision: axis", kind: "enum", options: AXES },
			{ path: "tasks.vision.minQuality", label: "vision: quality floor", kind: "number", min: 0, max: 100, optional: true },
			{ path: "tasks.documentation.axis", label: "documentation: axis", kind: "enum", options: AXES },
			{ path: "tasks.documentation.minQuality", label: "documentation: quality floor", kind: "number", min: 0, max: 100, optional: true },
			{ path: "tasks.data.axis", label: "data: axis", kind: "enum", options: AXES },
			{ path: "tasks.data.minQuality", label: "data: quality floor", kind: "number", min: 0, max: 100, optional: true },
			{ path: "tasks.chat.axis", label: "chat: axis", kind: "enum", options: AXES },
			{ path: "tasks.chat.minQuality", label: "chat: quality floor", kind: "number", min: 0, max: 100, optional: true },
		],
	},
	{
		title: "Filters",
		fields: [
			{ path: "filters.allow", label: "Allow globs", kind: "stringArray", hint: "comma-separated" },
			{ path: "filters.deny", label: "Deny globs", kind: "stringArray", hint: "comma-separated" },
			{ path: "filters.includeFree", label: "Include free models", kind: "boolean" },
			{ path: "filters.requireToolSupport", label: "Require tool support", kind: "boolean" },
			{ path: "filters.minTrust", label: "Min trust", kind: "number", min: 0, max: 1 },
			{ path: "filters.minTrustSamples", label: "Min trust samples", kind: "number", min: 0 },
			{ path: "filters.trustScopedByHarness", label: "Scope trust per harness", kind: "boolean" },
			{ path: "filters.contextHeadroom", label: "Context headroom", kind: "number", min: 1 },
		],
	},
	{
		title: "Classifier",
		fields: [
			{ path: "classifier.ambiguityThreshold", label: "Ambiguity threshold", kind: "number", min: 0, max: 1 },
			{ path: "classifier.model", label: "Adjudicator model", kind: "string", optional: true },
			{ path: "classifier.maxCostFraction", label: "Max cost fraction", kind: "number", min: 0, max: 1 },
			{ path: "classifier.timeoutMs", label: "Adjudicator timeout", kind: "number", min: 1, hint: "ms" },
			{ path: "classifier.toolAxis", label: "Tool-call axis", kind: "enum", options: AXES },
			{ path: "classifier.chatAxis", label: "Chat axis", kind: "enum", options: AXES },
		],
	},
	{
		title: "Escalation",
		fields: [
			{ path: "escalation.enabled", label: "Enable mid-stream escalation", kind: "boolean" },
			{ path: "escalation.probeTokens", label: "Probe tokens", kind: "number", min: 1 },
			{ path: "escalation.maxHoldMs", label: "Max hold", kind: "number", min: 1, hint: "ms" },
			{ path: "escalation.maxAttempts", label: "Max attempts", kind: "number", min: 1 },
		],
	},
	{
		title: "Hysteresis",
		fields: [
			{ path: "hysteresis.holdTurns", label: "Hold turns", kind: "number", min: 0 },
			{ path: "hysteresis.switchMargin", label: "Switch margin", kind: "number", min: 0 },
			{ path: "hysteresis.cacheWarmTtlMs", label: "Cache-warm TTL", kind: "number", min: 0, hint: "ms" },
		],
	},
	{
		title: "Cache",
		fields: [
			{ path: "cache.injectBreakpoints", label: "Inject cache breakpoints", kind: "boolean" },
			{ path: "cache.maxBreakpoints", label: "Max breakpoints", kind: "number", min: 1 },
			{ path: "cache.minPromptTokens", label: "Min prompt tokens", kind: "number", min: 0 },
		],
	},
	{
		title: "Budget",
		fields: [
			{ path: "budget.perTurnUsd", label: "Per-turn cap $", kind: "number", min: 0, optional: true },
			{ path: "budget.perConversationUsd", label: "Per-conversation cap $", kind: "number", min: 0, optional: true },
			{ path: "budget.perDayUsd", label: "Per-day cap $", kind: "number", min: 0, optional: true },
			{ path: "budget.onExceeded", label: "On exceeded", kind: "enum", options: ["downgrade", "reject"] },
		],
	},
	{
		title: "Ledger",
		fields: [
			{ path: "ledger.blendWindowDays", label: "Blend window", kind: "number", min: 1, hint: "days" },
			{ path: "ledger.blendMinSamples", label: "Blend min samples", kind: "number", min: 0 },
			{ path: "ledger.conversationTtlMs", label: "Conversation TTL", kind: "number", min: 1, hint: "ms" },
		],
	},
	{
		title: "Logging",
		fields: [
			{ path: "logLevel", label: "Log level", kind: "enum", options: ["silent", "error", "warn", "info", "debug"] },
		],
	},
];

/** Reads a dotted path out of a nested object. */
export function getPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split(".")) {
		if (typeof cur !== "object" || cur === null) return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

/** Sets a dotted path, creating intermediate objects as needed. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	const last = parts.length - 1;
	let cur = target;
	for (let i = 0; i < last; i++) {
		const part = parts[i] ?? "";
		const next = cur[part];
		if (typeof next !== "object" || next === null || Array.isArray(next)) {
			const fresh: Record<string, unknown> = {};
			cur[part] = fresh;
			cur = fresh;
		} else {
			cur = next as Record<string, unknown>;
		}
	}
	cur[parts[last] ?? ""] = value;
}

/** Result of validating one raw answer against a field spec. */
export type FieldResult =
	| { ok: true; value: unknown }
	| { ok: false; error: string };

/** The sentinel a user types to clear an optional field. */
export const CLEAR_TOKEN = "-";

/** Parses and validates one raw answer for a field. */
export function validateField(field: FieldSpec, raw: string): FieldResult {
	const text = raw.trim();

	if (text === CLEAR_TOKEN) {
		if (field.optional !== true) return { ok: false, error: `${field.label} cannot be cleared` };
		return { ok: true, value: null };
	}

	switch (field.kind) {
		case "string":
			return { ok: true, value: text };

		case "number": {
			const n = Number(text);
			if (!Number.isFinite(n)) return { ok: false, error: `not a number: ${text}` };
			if (field.min !== undefined && n < field.min) return { ok: false, error: `must be >= ${field.min}` };
			if (field.max !== undefined && n > field.max) return { ok: false, error: `must be <= ${field.max}` };
			return { ok: true, value: n };
		}

		case "boolean": {
			const lower = text.toLowerCase();
			if (["y", "yes", "true", "1", "on"].includes(lower)) return { ok: true, value: true };
			if (["n", "no", "false", "0", "off"].includes(lower)) return { ok: true, value: false };
			return { ok: false, error: `answer y or n, got: ${text}` };
		}

		case "enum": {
			const options = field.options ?? [];
			if (!options.includes(text)) return { ok: false, error: `one of: ${options.join(", ")}` };
			return { ok: true, value: text };
		}

		case "stringArray": {
			const items = text.split(",").map((s) => s.trim()).filter((s) => s !== "");
			return { ok: true, value: items };
		}
	}
}

/**
 * Turns a flat `dotted.path -> value` map of edits into the nested partial
 * object to merge into the config file.
 */
export function applyAnswers(answers: Record<string, unknown>): Record<string, unknown> {
	const partial: Record<string, unknown> = {};
	for (const [path, value] of Object.entries(answers)) {
		setPath(partial, path, value);
	}
	return partial;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges a wizard partial into the on-disk config object.
 *
 * A `null` leaf means "clear this setting": the key is DELETED rather than
 * written as null, so the loader falls back to its default and the schema
 * (which types optional fields as absent, not nullable) still accepts the
 * file. Empty objects left behind by a clear are pruned.
 */
export function mergeConfigPartial(
	base: Record<string, unknown>,
	partial: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };

	for (const [key, value] of Object.entries(partial)) {
		if (value === null) {
			delete out[key];
			continue;
		}

		if (isPlainRecord(value)) {
			const existing = out[key];
			const merged = mergeConfigPartial(isPlainRecord(existing) ? existing : {}, value);
			if (Object.keys(merged).length === 0) delete out[key];
			else out[key] = merged;
			continue;
		}

		out[key] = Array.isArray(value) ? value.slice() : value;
	}

	return out;
}

/** Renders a config value the way the prompt shows the current setting. */
export function formatValue(value: unknown): string {
	if (value === undefined || value === null) return "unset";
	if (Array.isArray(value)) return value.length === 0 ? "empty" : value.join(", ");
	if (typeof value === "boolean") return value ? "y" : "n";
	return String(value);
}

/** Builds the field prompt line, e.g. `  Listen port [8788]: `. */
function fieldPrompt(field: FieldSpec, current: unknown): string {
	const hint = field.hint !== undefined ? ` (${field.hint})` : "";
	return `  ${field.label}${hint} [${formatValue(current)}]: `;
}

/** Renders the top-level section menu. */
function renderMenu(edits: Record<string, unknown>): string {
	const lines: string[] = ["", "omp-router config", ""];
	WIZARD_SECTIONS.forEach((section, i) => {
		const touched = Object.keys(edits).filter((p) =>
			section.fields.some((f) => f.path === p),
		).length;
		const mark = touched > 0 ? ` (${touched} changed)` : "";
		lines.push(`  ${String(i + 1).padStart(2)}) ${section.title}${mark}`);
	});
	lines.push("");
	const profilesMark = "profiles" in edits ? " (changed)" : "";
	lines.push(`   p) Profiles${profilesMark}`);
	lines.push("   a) walk every section");
	lines.push("   s) save and exit");
	lines.push("   q) quit without saving");
	lines.push("");
	const pending = Object.keys(edits).length;
	lines.push(`select${pending > 0 ? ` (${pending} pending)` : ""}: `);
	return lines.join("\n");
}

/**
 * Walks one section, prompting for each field. Invalid answers re-prompt.
 * Returns false if input ended (treated as an abort by the caller).
 */
async function editSection(
	section: SectionSpec,
	cfg: RouterConfig,
	edits: Record<string, unknown>,
	io: WizardIo,
): Promise<boolean> {
	io.write(`\n== ${section.title} ==\n`);
	io.write(`   Enter keeps current, "${CLEAR_TOKEN}" clears an optional field\n`);

	for (const field of section.fields) {
		// Show the pending edit if this field was already touched this session.
		const current = field.path in edits ? edits[field.path] : getPath(cfg, field.path);

		for (;;) {
			io.write(fieldPrompt(field, current));
			const raw = await io.read.next();
			if (raw === null) return false;
			if (raw.trim() === "") break; // keep current, next field

			const result = validateField(field, raw);
			if (!result.ok) {
				io.write(`    ! ${result.error}\n`);
				continue;
			}
			edits[field.path] = result.value;
			break;
		}
	}
	return true;
}

const TIERS = ["trivial", "simple", "moderate", "hard"] as const;

/**
 * Fields of one virtual profile. Paths are relative to the profile record,
 * because profiles live in an ARRAY and are edited as whole elements.
 */
export const PROFILE_FIELDS: readonly FieldSpec[] = [
	{ path: "id", label: "Model id (as clients see it)", kind: "string" },
	{ path: "name", label: "Display name", kind: "string" },
	{ path: "minTier", label: "Floor tier", kind: "enum", options: TIERS },
	{ path: "maxTier", label: "Ceiling tier", kind: "enum", options: TIERS },
	{ path: "contextWindow", label: "Context window", kind: "number", min: 1, hint: "tokens" },
	{ path: "maxTokens", label: "Max output tokens", kind: "number", min: 1 },
];

/** A brand-new profile, pre-filled so every field has a sane starting value. */
function blankProfile(): Record<string, unknown> {
	return {
		id: "",
		name: "",
		minTier: "trivial",
		maxTier: "hard",
		contextWindow: 400000,
		maxTokens: 32000,
	};
}

/**
 * Prompts for each field of a single profile, mutating `profile` in place.
 *
 * When `requireAll` is set (a newly added profile) a blank answer is refused
 * for fields that are still empty, so we never persist a nameless profile.
 */
async function editProfileFields(
	profile: Record<string, unknown>,
	io: WizardIo,
	requireAll: boolean,
): Promise<boolean> {
	for (const field of PROFILE_FIELDS) {
		for (;;) {
			io.write(fieldPrompt(field, profile[field.path]));
			const raw = await io.read.next();
			if (raw === null) return false;

			if (raw.trim() === "") {
				if (requireAll && profile[field.path] === "") {
					io.write(`    ! ${field.label} is required\n`);
					continue;
				}
				break; // keep current
			}

			const result = validateField(field, raw);
			if (!result.ok) {
				io.write(`    ! ${result.error}\n`);
				continue;
			}
			profile[field.path] = result.value;
			break;
		}
	}
	return true;
}

/** Renders the profile list menu. */
function renderProfileMenu(list: readonly Record<string, unknown>[]): string {
	const lines: string[] = ["", "== Profiles ==", ""];
	if (list.length === 0) lines.push("  (none)");
	list.forEach((profile, i) => {
		const id = String(profile["id"] ?? "");
		const name = String(profile["name"] ?? "");
		const span = `${String(profile["minTier"] ?? "?")}..${String(profile["maxTier"] ?? "?")}`;
		lines.push(`  ${String(i + 1).padStart(2)}) ${id}  "${name}"  [${span}]`);
	});
	lines.push("");
	lines.push("   n) add a profile");
	lines.push("  x<N>) delete profile N");
	lines.push("   b) back");
	lines.push("");
	lines.push("select: ");
	return lines.join("\n");
}

/**
 * Edits the `profiles` array. Because arrays are replaced wholesale on merge,
 * any change records the ENTIRE new array as one edit.
 */
async function editProfiles(
	cfg: RouterConfig,
	edits: Record<string, unknown>,
	io: WizardIo,
): Promise<boolean> {
	const pending = edits["profiles"];
	const list: Record<string, unknown>[] = Array.isArray(pending)
		? pending.map((p) => ({ ...(p as Record<string, unknown>) }))
		: cfg.profiles.map((p) => ({ ...p }));

	for (;;) {
		io.write(renderProfileMenu(list));
		const choice = await io.read.next();
		if (choice === null) return false;
		const answer = choice.trim().toLowerCase();

		if (answer === "b") return true;

		if (answer === "n") {
			const fresh = blankProfile();
			const ok = await editProfileFields(fresh, io, true);
			if (!ok) return false;
			list.push(fresh);
			edits["profiles"] = list;
			continue;
		}

		const del = /^x\s*(\d+)$/.exec(answer);
		if (del !== null) {
			const index = Number(del[1]);
			if (index < 1 || index > list.length) {
				io.write(`  ! no profile ${index}\n`);
				continue;
			}
			if (list.length === 1) {
				io.write("  ! cannot delete the last profile\n");
				continue;
			}
			list.splice(index - 1, 1);
			edits["profiles"] = list;
			continue;
		}

		const index = Number(answer);
		const profile = Number.isInteger(index) ? list[index - 1] : undefined;
		if (profile === undefined) {
			io.write(`  ! not a choice: ${choice.trim()}\n`);
			continue;
		}
		const ok = await editProfileFields(profile, io, false);
		if (!ok) return false;
		edits["profiles"] = list;
	}
}

/** Outcome of a wizard run. */
export interface WizardResult {
	/** The partial config to merge, or null when the user quit without saving. */
	partial: Record<string, unknown> | null;
	/** Count of fields the user changed. */
	changed: number;
}

/**
 * Runs the menu-driven wizard. Returns the partial config to write, or a null
 * partial when the user quit (or input ended) without saving.
 */
export async function runWizard(cfg: RouterConfig, io: WizardIo): Promise<WizardResult> {
	const edits: Record<string, unknown> = {};

	for (;;) {
		io.write(renderMenu(edits));
		const choice = await io.read.next();
		if (choice === null) return { partial: null, changed: 0 };

		const answer = choice.trim().toLowerCase();

		if (answer === "q") return { partial: null, changed: 0 };

		if (answer === "s") {
			const changed = Object.keys(edits).length;
			if (changed === 0) return { partial: null, changed: 0 };
			return { partial: applyAnswers(edits), changed };
		}

		if (answer === "p") {
			const ok = await editProfiles(cfg, edits, io);
			if (!ok) return { partial: null, changed: 0 };
			continue;
		}

		if (answer === "a") {
			for (const section of WIZARD_SECTIONS) {
				const ok = await editSection(section, cfg, edits, io);
				if (!ok) return { partial: null, changed: 0 };
			}
			const ok = await editProfiles(cfg, edits, io);
			if (!ok) return { partial: null, changed: 0 };
			continue;
		}

		const index = Number(answer);
		const section = Number.isInteger(index) ? WIZARD_SECTIONS[index - 1] : undefined;
		if (section === undefined) {
			io.write(`  ! not a choice: ${choice.trim()}\n`);
			continue;
		}
		const ok = await editSection(section, cfg, edits, io);
		if (!ok) return { partial: null, changed: 0 };
	}
}

/**
 * A `LineSource` over a byte stream (stdin). Buffers chunks and splits on
 * newlines, so it behaves identically for a TTY and for piped input.
 */
export class StreamLineSource implements LineSource {
	private buffer = "";
	private ended = false;
	private readonly decoder = new TextDecoder();
	private readonly iterator: AsyncIterator<Uint8Array>;

	constructor(stream: AsyncIterable<Uint8Array>) {
		this.iterator = stream[Symbol.asyncIterator]();
	}

	async next(): Promise<string | null> {
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				return line.endsWith("\r") ? line.slice(0, -1) : line;
			}
			if (this.ended) {
				if (this.buffer.length === 0) return null;
				const rest = this.buffer;
				this.buffer = "";
				return rest;
			}
			const chunk = await this.iterator.next();
			if (chunk.done === true) {
				this.ended = true;
				continue;
			}
			this.buffer += this.decoder.decode(chunk.value, { stream: true });
		}
	}
}

/** A `LineSource` over a fixed script of answers; for tests. */
export class ScriptedLineSource implements LineSource {
	private index = 0;

	constructor(private readonly lines: readonly string[]) {}

	async next(): Promise<string | null> {
		if (this.index >= this.lines.length) return null;
		const line = this.lines[this.index] ?? null;
		this.index += 1;
		return line;
	}
}
