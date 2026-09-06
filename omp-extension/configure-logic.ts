/**
 * Pure configuration-driving logic for the `/router config` slash command.
 *
 * Reuses the router's existing wizard field definitions and validation
 * (`src/cli/config-wizard.ts`) so the in-omp UI edits exactly the same set of
 * settings as `auto-model-router config`, and persists them through the same
 * validated merge (`writeRouterConfig`). The only thing this module adds is a
 * UI-adapter seam so the command can drive omp's native dialogs (`ctx.ui`)
 * while remaining unit-testable with a fake UI.
 */

import type { FieldSpec, SectionSpec } from "../src/cli/config-wizard.ts";
import { CLEAR_TOKEN, displayValue, validateField } from "../src/cli/config-wizard.ts";
import type { RouterConfig } from "../src/config/types.ts";

/** A selector entry: omp renders the description dimmed beside the label and returns the label. */
export type SelectOption = string | { label: string; description?: string };

export interface ConfigUi {
	/** Show a selector, return the chosen option label, or undefined on cancel. */
	select(title: string, options: SelectOption[]): Promise<string | undefined>;
	/** Show a text input with a placeholder, or undefined on cancel. */
	input(title: string, placeholder?: string): Promise<string | undefined>;
	/** Yes/no confirmation. */
	confirm(title: string, message: string): Promise<boolean>;
	/** Surface a status/result line. */
	notify(text: string, level?: "info" | "warn" | "error"): void;
}


/** `Listen port (ms) · current: 8788` — every dialog names the value it would replace. */
function promptTitle(field: FieldSpec, current: unknown): string {
	const hint = field.hint !== undefined ? ` (${field.hint})` : "";
	return `${field.label}${hint} · current: ${displayValue(field, current)}`;
}

/**
 * Prompts for one field, returning the parsed value or null when the user kept
 * the current value. The current value is shown in the dialog title, marked
 * in select pickers, and used as the input placeholder; an empty answer keeps
 * it and CLEAR_TOKEN clears an optional field. Returns `undefined` when the
 * user cancelled the dialog.
 */
export async function promptField(
	ui: ConfigUi,
	field: FieldSpec,
	current: unknown,
): Promise<{ value: unknown; changed: boolean } | undefined> {
	const title = promptTitle(field, current);
	const mark = (label: string, isCurrent: boolean): SelectOption => (isCurrent ? { label, description: "current" } : label);

	if (field.kind === "boolean") {
		// An optional boolean can also be cleared back to "unset" (its default).
		const unset = current === undefined || current === null;
		const options: SelectOption[] = [mark("true", current === true), mark("false", current === false)];
		if (field.optional === true) options.push(mark("unset", unset));
		const chosen = await ui.select(title, options);
		if (chosen === undefined) return undefined;
		if (chosen === "unset") return { value: null, changed: !unset };
		const value = chosen === "true";
		return { value, changed: value !== current };
	}

	if (field.kind === "enum") {
		const options = (field.options ?? []).map((o) => mark(o, o === current));
		const chosen = await ui.select(title, options);
		if (chosen === undefined) return undefined;
		return { value: chosen, changed: chosen !== current };
	}

	// string | number | stringArray | numberArray: free-text input. Secrets
	// show set/unset rather than the value.
	const placeholder = `${displayValue(field, current)}  (Enter keeps${field.optional === true ? `, ${CLEAR_TOKEN} clears` : ""})`;
	const answer = await ui.input(title, placeholder);
	if (answer === undefined) return undefined;
	if (answer.trim() === "") return { value: current, changed: false }; // keep
	if (answer.trim() === CLEAR_TOKEN) {
		if (field.optional !== true) return { value: current, changed: false };
		return { value: null, changed: true };
	}

	const result = validateField(field, answer);
	if (!result.ok) {
		ui.notify(`invalid: ${result.error}`, "warn");
		return { value: current, changed: false };
	}
	// Arrays are re-parsed from text every time, so compare by content or an
	// unchanged list would register as an edit.
	const changed = Array.isArray(result.value) && Array.isArray(current)
		? JSON.stringify(result.value) !== JSON.stringify(current)
		: result.value !== current;
	return { value: result.value, changed };
}

/**
 * Section editor for the omp command: a picker listing every field of the
 * section with its current value (or the pending edit, marked), so the user
 * sees the settings before choosing which one to change. Picking a field
 * prompts for it; "Back" returns. Returns true if any field changed.
 */
export async function editSectionMenu(
	ui: ConfigUi,
	section: SectionSpec,
	cfg: RouterConfig,
	answers: Record<string, unknown>,
): Promise<boolean> {
	let any = false;
	for (;;) {
		const options: SelectOption[] = section.fields.map((field) => {
			const pending = field.path in answers;
			const current = pending ? answers[field.path] : getPathValue(cfg, field.path);
			return { label: field.label, description: `${displayValue(field, current)}${pending ? "  (pending)" : ""}` };
		});
		options.push("Back");
		const chosen = await ui.select(`${section.title}${any ? " (edited)" : ""}`, options);
		if (chosen === undefined || chosen === "Back") return any;
		const field = section.fields.find((f) => f.label === chosen);
		if (field === undefined) continue;
		const current = field.path in answers ? answers[field.path] : getPathValue(cfg, field.path);
		const result = await promptField(ui, field, current);
		if (result === undefined) continue; // cancelled the field dialog: back to the picker
		if (result.changed) {
			answers[field.path] = result.value;
			any = true;
		}
	}
}

/**
 * Walks a section's fields, prompting the user for each and collecting edits
 * into `answers`. Returns true if any field changed, false if the walk was
 * cancelled (a dialog returned undefined).
 */
export async function walkSection(
	ui: ConfigUi,
	section: SectionSpec,
	cfg: RouterConfig,
	answers: Record<string, unknown>,
): Promise<boolean> {
	let any = false;
	for (const field of section.fields) {
		const current = field.path in answers ? answers[field.path] : getPathValue(cfg, field.path);
		const result = await promptField(ui, field, current);
		if (result === undefined) return false;
		if (result.changed) {
			answers[field.path] = result.value;
			any = true;
		}
	}
	return any;
}

/** Reads a dotted path from the config, with `undefined` for missing keys. */
function getPathValue(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split(".")) {
		if (typeof cur !== "object" || cur === null) return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

/** Section titles in menu order, mirroring `omp config`'s menu. */
export function sectionTitles(sections: readonly SectionSpec[]): string[] {
	return sections.map((s) => s.title);
}

/**
 * Edits one virtual profile (a whole array element) through the UI. Returns
 * the updated profile record, or null when cancelled.
 */
export async function editProfile(
	ui: ConfigUi,
	profile: Record<string, unknown>,
	fields: readonly FieldSpec[],
): Promise<Record<string, unknown> | null> {
	const next: Record<string, unknown> = { ...profile };
	for (const field of fields) {
		const result = await promptField(ui, field, next[field.path]);
		if (result === undefined) return null;
		if (result.changed) next[field.path] = result.value;
	}
	return next;
}
