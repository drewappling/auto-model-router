/**
 * Pure configuration-driving logic for the `/router configure` slash command.
 *
 * Reuses the router's existing wizard field definitions and validation
 * (`src/cli/config-wizard.ts`) so the in-omp UI edits exactly the same set of
 * settings as `auto-model-router config`, and persists them through the same
 * validated merge (`writeRouterConfig`). The only thing this module adds is a
 * UI-adapter seam so the command can drive omp's native dialogs (`ctx.ui`)
 * while remaining unit-testable with a fake UI.
 */

import type { FieldSpec, SectionSpec } from "../src/cli/config-wizard.ts";
import { CLEAR_TOKEN, formatValue, validateField } from "../src/cli/config-wizard.ts";
import type { RouterConfig } from "../src/config/types.ts";

export interface ConfigUi {
	/** Show a selector, return the chosen option label, or undefined on cancel. */
	select(title: string, options: string[], selected?: number): Promise<string | undefined>;
	/** Show a text input with a placeholder, or undefined on cancel. */
	input(title: string, placeholder?: string, initial?: string): Promise<string | undefined>;
	/** Yes/no confirmation. */
	confirm(title: string, message: string): Promise<boolean>;
	/** Surface a status/result line. */
	notify(text: string, level?: "info" | "warn" | "error"): void;
}


/**
 * Prompts for one field, returning the parsed value or null when the user kept
 * the current value. An empty answer keeps the current; CLEAR_TOKEN clears an
 * optional field. Returns `undefined` when the user cancelled the dialog.
 */
export async function promptField(
	ui: ConfigUi,
	field: FieldSpec,
	current: unknown,
): Promise<{ value: unknown; changed: boolean } | undefined> {
	const label = field.hint !== undefined ? `${field.label} (${field.hint})` : field.label;

	if (field.kind === "boolean") {
		const chosen = await ui.select(label, ["true", "false"], current === true ? 0 : 1);
		if (chosen === undefined) return undefined;
		const value = chosen === "true";
		return { value, changed: value !== current };
	}

	if (field.kind === "enum") {
		const options = field.options ?? [];
		const idx = options.indexOf(String(current));
		const chosen = await ui.select(label, [...options], idx >= 0 ? idx : 0);
		if (chosen === undefined) return undefined;
		return { value: chosen, changed: chosen !== current };
	}

	// string | number | stringArray: free-text input.
	const placeholder = formatValue(current);
	const answer = await ui.input(label, placeholder, "");
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
	return { value: result.value, changed: result.value !== current };
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
