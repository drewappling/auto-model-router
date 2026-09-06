/**
 * omp extension: `/router` — configure auto-model-router and pull usage
 * reports without leaving the session.
 *
 *   /router                 menu: Configure / Report / Status
 *   /router config          edit any section of the router's config.yml
 *   /router report [7d] [--all]
 *                           usage analytics in a fullscreen hub styled like
 *                           /models: views for overview, providers, models,
 *                           tiers, by day and status; ←/→ cycle the window,
 *                           a toggles harness scope. Scoped to this harness
 *                           when OMP_HARNESS_ID is set; `--all` widens it.
 *                           Headless sessions get the text in the transcript.
 *   /router status          the router's /health: keys, catalog, Ollama
 *                           availability and plan usage, agentdox.
 *
 * Configuration walks the same sections and fields as `auto-model-router
 * config` (reusing `WIZARD_SECTIONS` / `PROFILE_FIELDS` from the router's
 * CLI) but prompts through `ctx.ui` select/input dialogs. Edits are persisted
 * through the router's own validated merge (`writeRouterConfig`), so the
 * on-disk config.yml is schema-checked and backed up exactly as the CLI
 * wizard does.
 *
 * Reports and status are fetched from the running router
 * (`GET /v1/router/report`, `GET /health`) and posted into the transcript as
 * a custom message, so they scroll with the conversation and the model can
 * answer questions about them. If the router is unreachable the report falls
 * back to reading the ledger directly.
 *
 * Install alongside router-embed.ts:
 *
 *   # ~/.omp/agent/config.yml
 *   extensions:
 *     - /path/to/auto-model-router/omp-extension/router-embed.ts
 *     - /path/to/auto-model-router/omp-extension/router-configure.ts
 */

import { existsSync } from "node:fs";

import { applyAnswers, PROFILE_FIELDS, WIZARD_SECTIONS } from "../src/cli/config-wizard.ts";
import { routerConfigPath, writeRouterConfig } from "../src/cli/config-cmd.ts";
import { loadConfig } from "../src/config/load.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { buildUsageReport, renderUsageReport, type UsageReport } from "../src/cost/report.ts";
import { openDb } from "../src/util/sqlite.ts";

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import { matchesKey, truncateToWidth, visibleWidth } from "@oh-my-pi/pi-tui";

import { editProfile, editSectionMenu, type ConfigUi, type SelectOption } from "./configure-logic.ts";
import { ReportHub } from "./report-hub.ts";
import { fetchReport, parseReportArgs, renderStatus, type HealthSnapshot, type ReportRequest } from "./report-logic.ts";
import { routerAuthHeaders, routerBaseUrl } from "./router-url.ts";

// This harness's id, matching the X-Omp-Harness header the router records.
// Empty ⇒ reports cover every harness (single-harness default).
const HARNESS_ID = process.env.OMP_HARNESS_ID ?? "";

/** Custom message type for report/status output in the transcript. */
const MESSAGE_TYPE = "auto-model-router";

export default function (pi: ExtensionAPI): void {
	pi.setLabel("auto-model-router");

	pi.registerCommand("router", {
		description: "auto-model-router: configure, usage report, status (/router report 7d)",
		handler: async (args, ctx) => {
			const [verb = "", ...rest] = args.trim().split(/\s+/).filter((t) => t !== "");
			const tail = rest.join(" ");
			switch (verb.toLowerCase()) {
				case "config":
				case "configure":
					return configure(ctx);
				case "report":
					return report(pi, ctx, tail);
				case "status":
				case "health":
					return status(pi, ctx);
				case "":
					break;
				default:
					ctx.ui.notify(`unknown /router subcommand "${verb}" (config | report [7d] [--all] | status)`, "warn");
					return;
			}

			const chosen = await ctx.ui.select("auto-model-router", [
				"Configure",
				"Report: last 24h",
				"Report: last 7 days",
				"Report: last 30 days",
				"Status",
			]);
			if (chosen === undefined) return;
			if (chosen === "Configure") return configure(ctx);
			if (chosen === "Status") return status(pi, ctx);
			if (chosen.startsWith("Report")) {
				const days = chosen.includes("24h") ? "1d" : chosen.includes("30") ? "30d" : "7d";
				return report(pi, ctx, days);
			}
		},
	});
}

/** Posts a block of text into the transcript without triggering a turn. */
function post(pi: ExtensionAPI, text: string): void {
	pi.sendMessage({ customType: MESSAGE_TYPE, content: `\`\`\`text\n${text}\n\`\`\``, display: true }, { triggerTurn: false });
}

/** Loads a report: the running router first, the ledger directly if it is down. */
async function loadReport(req: ReportRequest): Promise<UsageReport> {
	try {
		return await fetchReport(routerBaseUrl(), req, routerAuthHeaders());
	} catch (err) {
		// Router not reachable (standalone `serve` not running, or embed still
		// starting): read the ledger directly so the report still comes back.
		const cfg = loadConfig();
		if (!existsSync(cfg.ledger.path)) {
			throw new Error(`router unreachable (${err instanceof Error ? err.message : String(err)}) and no ledger at ${cfg.ledger.path}`);
		}
		const db = openDb(cfg.ledger.path);
		try {
			return buildUsageReport(db, req);
		} finally {
			db.close();
		}
	}
}

async function loadStatus(): Promise<string> {
	const baseUrl = routerBaseUrl();
	const res = await fetch(`${baseUrl}/health`, { headers: routerAuthHeaders(), signal: AbortSignal.timeout(5_000) });
	if (!res.ok) throw new Error(`router returned ${res.status}`);
	return renderStatus(baseUrl, (await res.json()) as HealthSnapshot);
}

async function report(pi: ExtensionAPI, ctx: ExtensionContext, argText: string): Promise<void> {
	const req = parseReportArgs(argText, HARNESS_ID);
	// Interactive sessions get the fullscreen hub (the /models look); headless
	// and print modes get the text posted into the transcript.
	if (ctx.hasUI && typeof ctx.ui.custom === "function") {
		await ctx.ui.custom<void>(
			(tui, theme, keybindings, done) =>
				new ReportHub({
					theme,
					text: { visibleWidth, truncateToWidth },
					keys: {
						up: (d) => keybindings.matches(d, "tui.select.up"),
						down: (d) => keybindings.matches(d, "tui.select.down"),
						pageUp: (d) => keybindings.matches(d, "tui.select.pageUp"),
						pageDown: (d) => keybindings.matches(d, "tui.select.pageDown"),
						cancel: (d) => keybindings.matches(d, "tui.select.cancel"),
						left: (d) => matchesKey(d, "left"),
						right: (d) => matchesKey(d, "right"),
					},
					source: { report: loadReport, status: loadStatus },
					rows: () => tui.terminal?.rows ?? process.stdout.rows ?? 40,
					requestRender: () => tui.requestRender(),
					close: () => done(undefined),
					initial: req,
					harnessId: HARNESS_ID,
				}),
			{ overlay: true, overlayOptions: { fullscreen: true, width: "100%", maxHeight: "100%", anchor: "center" } },
		);
		return;
	}
	let data: UsageReport;
	try {
		data = await loadReport(req);
	} catch (err) {
		ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
		return;
	}
	if (data.totals.dispatches === 0) {
		ctx.ui.notify(`no routed turns in the last ${req.windowDays}d${req.harnessId === "" ? "" : ` for harness ${req.harnessId}`}`, "info");
		return;
	}
	post(pi, renderUsageReport(data));
}

async function status(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	try {
		post(pi, await loadStatus());
	} catch (err) {
		ctx.ui.notify(`router unreachable at ${routerBaseUrl()}: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

async function configure(ctx: ExtensionContext): Promise<void> {
	const ui = ctx.ui;
	const cfg = loadConfig();
	const answers: Record<string, unknown> = {};

	for (;;) {
		// Each section shows how many of its fields have pending edits.
		const options: SelectOption[] = WIZARD_SECTIONS.map((s) => {
			const touched = s.fields.filter((f) => f.path in answers).length;
			return touched > 0 ? { label: s.title, description: `${touched} pending` } : { label: s.title, description: `${s.fields.length} settings` };
		});
		options.push("profiles" in answers ? { label: "Profiles", description: "pending" } : { label: "Profiles", description: `${cfg.profiles.length} profiles` }, "Save and exit", "Quit without saving");
		const pending = Object.keys(answers).length;
		const chosen = await ui.select(`auto-model-router configure${pending > 0 ? ` (${pending} pending)` : ""}`, options);
		if (chosen === undefined) return;
		if (chosen === "Quit without saving") return;
		if (chosen === "Save and exit") break;

		if (chosen === "Profiles") {
			await editProfiles(ui, cfg, answers);
			continue;
		}

		const section = WIZARD_SECTIONS.find((s) => s.title === chosen);
		if (section === undefined) continue;
		await editSectionMenu(ui, section, cfg, answers);
	}

	if (Object.keys(answers).length === 0) {
		ui.notify("no changes made", "info");
		return;
	}

	try {
		const target = routerConfigPath();
		const partial = applyAnswers(answers);
		const backup = writeRouterConfig(target, partial);
		ui.notify(`wrote ${target}${backup ? ` (backup: ${backup})` : ""} — restart omp for server/upstream/ledger changes`, "info");
	} catch (err) {
		ui.notify(err instanceof Error ? err.message : String(err), "error");
	}
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
	const items: SelectOption[] = list.map((p, i) => ({ label: names[i] ?? "", description: `${p.minTier}..${p.maxTier} · ctx ${p.contextWindow} · out ${p.maxTokens}` }));
	const choice = await ui.select("Profiles", [...items, "+ Add profile", "Back"]);
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
