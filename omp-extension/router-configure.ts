/**
 * omp extension: `/router configure` — edit omp-router's settings through
 * omp's native UI dialogs.
 *
 * The command walks the same sections and fields as `omp-router config`
 * (reusing `WIZARD_SECTIONS` / `PROFILE_FIELDS` from the router's CLI) but
 * prompts through `ctx.ui` select/input/confirm dialogs instead of stdin.
 * Edits are persisted through the router's own validated merge
 * (`writeRouterConfig`), so the on-disk config.yml is schema-checked and
 * backed up exactly as the CLI wizard does.
 *
 * Install alongside router-embed.ts:
 *
 *   # ~/.omp/agent/config.yml
 *   extensions:
 *     - /path/to/omp-router/omp-extension/router-embed.ts
 *     - /path/to/omp-router/omp-extension/router-configure.ts
 *
 * Run `/router configure` in an omp session to pick a section, edit its
 * fields, and save.
 */

import { loadConfig } from "../src/config/load.ts";
import { applyAnswers, PROFILE_FIELDS, WIZARD_SECTIONS } from "../src/cli/config-wizard.ts";
import { writeRouterConfig, routerConfigPath } from "../src/cli/config-cmd.ts";
import type { RouterConfig } from "../src/config/types.ts";

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { editProfile, sectionTitles, walkSection, type ConfigUi } from "./configure-logic.ts";

export default function (pi: ExtensionAPI): void {
	pi.setLabel("omp-router configure");

	pi.registerCommand("router configure", {
		description: "Configure omp-router settings through the native UI",
		handler: async (_args, ctx) => {
			const ui = ctx.ui;
			const cfg = loadConfig();
			const answers: Record<string, unknown> = {};

			for (;;) {
				const options = [...sectionTitles(WIZARD_SECTIONS), "Profiles", "Save and exit", "Quit without saving"];
				const chosen = await ui.select("omp-router configure", options);
				if (chosen === undefined) return;
				if (chosen === "Quit without saving") return;
				if (chosen === "Save and exit") break;

				if (chosen === "Profiles") {
					await editProfiles(ui, cfg, answers);
					continue;
				}

				const section = WIZARD_SECTIONS.find((s) => s.title === chosen);
				if (section === undefined) continue;
				await walkSection(ui, section, cfg, answers);
			}

			if (Object.keys(answers).length === 0) {
				ui.notify("no changes made", "info");
				return;
			}

			try {
				const target = routerConfigPath();
				const partial = applyAnswers(answers);
				const backup = writeRouterConfig(target, partial);
				ui.notify(`wrote ${target}${backup ? ` (backup: ${backup})` : ""}`, "info");
			} catch (err) {
				ui.notify(err instanceof Error ? err.message : String(err), "error");
			}
		},
	});
}

/** Edits the profiles array as whole elements, mirroring the CLI wizard. */
async function editProfiles(
	ui: ConfigUi,
	cfg: RouterConfig,
	answers: Record<string, unknown>,
): Promise<void> {
	// Work over the profiles as plain records (the shape the wizard's merge
	// expects), converting at the boundary to/from ProfileConfig.
	const list: Record<string, unknown>[] = cfg.profiles.map((p) => ({ ...p }));
	const names = list.map((p, i) => `${i + 1}) ${p.id} (${p.name})`);
	const choice = await ui.select("Profiles", [...names, "+ Add profile", "Back"]);
	if (choice === undefined || choice === "Back") return;

	if (choice === "+ Add profile") {
		const blank: Record<string, unknown> = {
			id: "",
			name: "",
			minTier: "trivial",
			maxTier: "hard",
			contextWindow: 400000,
			maxTokens: 32000,
		};
		const updated = await editProfile(ui, blank, PROFILE_FIELDS);
		if (updated === null || updated.id === "" || updated.name === "") return;
		answers.profiles = [...list, updated];
		return;
	}

	const idx = names.indexOf(choice);
	if (idx < 0) return;
	const updated = await editProfile(ui, list[idx] ?? {}, PROFILE_FIELDS);
	if (updated === null) return;
	const next = list.slice();
	next[idx] = updated;
	answers.profiles = next;
}
