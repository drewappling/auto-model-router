/**
 * Fullscreen report hub for `/router report`, drawn the way omp's `/models`
 * hub is: a titled two-column frame on the alternate screen, a sidebar of
 * views on the left, the selected view's table on the right, a divider and
 * a footer hint row. Keys: ↑/↓ or j/k pick a view, ←/→ or w cycle the time
 * window, a toggles harness scope, PgUp/PgDn scroll a long table, r reloads,
 * Esc/q close.
 *
 * The component is pure: styling comes through the `HubTheme` seam (omp's
 * `Theme` in production, identity functions in tests), data through
 * `HubSource`, and terminal size through `rows()`. Nothing here imports omp.
 */

import { formatTable, type ReportView, reportView, type UsageReport } from "../src/cost/report.ts";
import type { ReportRequest } from "./report-logic.ts";

/** The slice of omp's Theme the hub paints with. */
export interface HubTheme {
	fg(color: "accent" | "border" | "dim" | "muted" | "success" | "warning" | "error" | "text", text: string): string;
	bg(color: "selectedBg", text: string): string;
	bold(text: string): string;
	boxRound: {
		topLeft: string;
		topRight: string;
		bottomLeft: string;
		bottomRight: string;
		horizontal: string;
		vertical: string;
		teeDown: string;
		teeUp: string;
		teeLeft: string;
		teeRight: string;
	};
	nav: { cursor: string };
}

/** Terminal text helpers (pi-tui's in production; ASCII stand-ins in tests). */
export interface HubText {
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number): string;
}

/** Key matching against omp's keybinding ids, so user remaps are honoured. */
export interface HubKeys {
	up(data: string): boolean;
	down(data: string): boolean;
	left(data: string): boolean;
	right(data: string): boolean;
	pageUp(data: string): boolean;
	pageDown(data: string): boolean;
	cancel(data: string): boolean;
}

export interface HubSource {
	report(req: ReportRequest): Promise<UsageReport>;
	status(): Promise<string>;
}

export interface HubOptions {
	theme: HubTheme;
	text: HubText;
	keys: HubKeys;
	source: HubSource;
	/** Terminal height in rows at render time. */
	rows(): number;
	/** Ask the host to repaint (data arrived). */
	requestRender(): void;
	/** Close the overlay. */
	close(): void;
	initial: ReportRequest;
	/** The harness this session belongs to; empty ⇒ no scope toggle. */
	harnessId: string;
}

export const WINDOWS: readonly number[] = [1, 7, 30, 90];

type ViewId = "overview" | "providers" | "models" | "tiers" | "days" | "status";

interface SidebarEntry {
	id: ViewId | "sep";
	label: string;
	icon: string;
}

const ENTRIES: readonly SidebarEntry[] = [
	{ id: "overview", label: "Overview", icon: "◎" },
	{ id: "providers", label: "Providers", icon: "◈" },
	{ id: "models", label: "Models", icon: "◇" },
	{ id: "tiers", label: "Tiers", icon: "≡" },
	{ id: "days", label: "By day", icon: "▤" },
	{ id: "sep", label: "", icon: "" },
	{ id: "status", label: "Status", icon: "●" },
];

const SIDEBAR_WIDTH = 18;

/** Pad or truncate a (possibly styled) string to exactly `width` columns. */
function fit(text: string, width: number, t: HubText): string {
	if (width <= 0) return "";
	const w = t.visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + " ".repeat(width - w);
	const cut = t.truncateToWidth(text, width);
	const cw = t.visibleWidth(cut);
	return cw < width ? cut + " ".repeat(width - cw) : cut;
}

export class ReportHub {
	#o: HubOptions;
	#req: ReportRequest;
	#active = 0;
	#scroll = 0;
	#report: UsageReport | null = null;
	#view: ReportView | null = null;
	#status: string | null = null;
	#loading = false;
	#error: string | null = null;
	#generation = 0;
	#disposed = false;
	#bodyRows = 10;

	constructor(o: HubOptions) {
		this.#o = o;
		this.#req = { ...o.initial };
		void this.#load();
	}

	get request(): ReportRequest {
		return this.#req;
	}

	get activeView(): ViewId {
		return (ENTRIES[this.#active]?.id ?? "overview") as ViewId;
	}

	async #load(): Promise<void> {
		const gen = ++this.#generation;
		this.#loading = true;
		this.#error = null;
		this.#o.requestRender();
		try {
			const [report, status] = await Promise.all([
				this.#o.source.report(this.#req),
				this.#o.source.status().catch((err: unknown) => `status unavailable: ${err instanceof Error ? err.message : String(err)}`),
			]);
			if (gen !== this.#generation || this.#disposed) return;
			this.#report = report;
			this.#view = reportView(report);
			this.#status = status;
		} catch (err) {
			if (gen !== this.#generation || this.#disposed) return;
			this.#error = err instanceof Error ? err.message : String(err);
		} finally {
			if (gen === this.#generation) {
				this.#loading = false;
				this.#o.requestRender();
			}
		}
	}

	#move(delta: number): void {
		let next = this.#active;
		for (let i = 0; i < ENTRIES.length; i++) {
			next = (next + delta + ENTRIES.length) % ENTRIES.length;
			if (ENTRIES[next]?.id !== "sep") break;
		}
		this.#active = next;
		this.#scroll = 0;
	}

	#cycleWindow(delta: number): void {
		const i = WINDOWS.indexOf(this.#req.windowDays);
		const next = i < 0 ? 0 : (i + delta + WINDOWS.length) % WINDOWS.length;
		this.#req = { ...this.#req, windowDays: WINDOWS[next] ?? 7 };
		this.#scroll = 0;
		void this.#load();
	}

	#toggleScope(): void {
		if (this.#o.harnessId === "") return;
		this.#req = { ...this.#req, harnessId: this.#req.harnessId === "" ? this.#o.harnessId : "" };
		this.#scroll = 0;
		void this.#load();
	}

	handleInput(data: string): void {
		const k = this.#o.keys;
		if (k.cancel(data) || data === "q") {
			this.#o.close();
			return;
		}
		if (k.up(data) || data === "k") this.#move(-1);
		else if (k.down(data) || data === "j") this.#move(1);
		else if (k.right(data) || data === "w") this.#cycleWindow(1);
		else if (k.left(data)) this.#cycleWindow(-1);
		else if (data === "a") this.#toggleScope();
		else if (data === "r") void this.#load();
		else if (k.pageDown(data)) this.#scroll += Math.max(1, this.#bodyRows - 2);
		else if (k.pageUp(data)) this.#scroll = Math.max(0, this.#scroll - Math.max(1, this.#bodyRows - 2));
		else return;
		this.#o.requestRender();
	}

	invalidate(): void {}

	dispose(): void {
		this.#disposed = true;
	}

	/** Body lines for the active view, unstyled except headers. */
	#bodyLines(width: number): string[] {
		const th = this.#o.theme;
		if (this.#error !== null) return [th.fg("error", `could not load: ${this.#error}`), "", th.fg("dim", "r retries")];
		if (this.activeView === "status") {
			if (this.#status === null) return [th.fg("dim", "loading…")];
			return this.#status.split("\n");
		}
		const v = this.#view;
		const r = this.#report;
		if (v === null || r === null) return [th.fg("dim", "loading…")];
		if (r.totals.dispatches === 0) {
			return [th.fg("dim", `no routed turns in the last ${r.windowDays}d${r.harnessId === "" ? "" : ` for harness ${r.harnessId}`}`)];
		}
		const styledTable = (headers: string[], rows: string[][]): string[] => {
			const lines = formatTable(headers, rows);
			return lines.map((line, i) => (i === 0 ? th.bold(th.fg("accent", line)) : i === 1 ? th.fg("border", line) : line));
		};
		if (this.activeView === "overview") {
			const out: string[] = [...v.summary.map((s) => th.fg("text", s)), ""];
			for (const t of v.tables) {
				if (t.id === "days") continue;
				out.push(th.bold(t.title), ...styledTable(t.headers, t.rows.slice(0, t.id === "models" ? 6 : t.rows.length)), "");
			}
			return out.map((l) => this.#o.text.truncateToWidth(l, width));
		}
		const table = v.tables.find((t) => t.id === this.activeView);
		if (table === undefined) return [th.fg("dim", "nothing in this window")];
		return [th.bold(table.title), ...styledTable(table.headers, table.rows)].map((l) => this.#o.text.truncateToWidth(l, width));
	}

	#statusRow(width: number): string {
		const th = this.#o.theme;
		const scope = this.#req.harnessId === "" ? "all harnesses" : `harness ${this.#req.harnessId}`;
		const heading = this.#view === null ? `last ${this.#req.windowDays}d · ${scope}` : `${this.#view.heading.replace(/ · harness [^·]+/, "")} · ${scope}`;
		const tail = this.#loading ? th.fg("warning", " · loading…") : "";
		return this.#o.text.truncateToWidth(th.fg("accent", ` ${heading}`) + tail, width);
	}

	#sidebarLines(width: number, rows: number): string[] {
		const th = this.#o.theme;
		const lines: string[] = [];
		ENTRIES.forEach((e, i) => {
			if (e.id === "sep") {
				lines.push(th.fg("border", th.boxRound.horizontal.repeat(width)));
				return;
			}
			const active = i === this.#active;
			const cursor = active ? th.fg("accent", th.nav.cursor) : " ";
			const label = active ? th.bold(th.fg("accent", e.label)) : e.label;
			lines.push(`${cursor} ${th.fg(active ? "accent" : "dim", e.icon)} ${label}`);
		});
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footer(width: number): string {
		const th = this.#o.theme;
		const scope = this.#o.harnessId === "" ? "" : " · a scope";
		return this.#o.text.truncateToWidth(th.fg("dim", `↑↓ view · ←→ window (${this.#req.windowDays}d)${scope} · pgup/pgdn scroll · r reload · esc close`), width);
	}

	render(width: number): string[] {
		const th = this.#o.theme;
		const t = this.#o.text;
		const box = th.boxRound;
		const paint = (s: string): string => th.fg("border", s);
		const height = Math.max(16, this.#o.rows());
		const contentRows = Math.max(10, height - 4);
		const sidebarWidth = SIDEBAR_WIDTH;
		const dividerCol = sidebarWidth + 3;
		const bodyWidth = Math.max(0, width - sidebarWidth - 7);
		this.#bodyRows = contentRows - 1;

		const all = this.#bodyLines(bodyWidth);
		const maxScroll = Math.max(0, all.length - this.#bodyRows);
		if (this.#scroll > maxScroll) this.#scroll = maxScroll;
		const body = [this.#statusRow(bodyWidth), ...all.slice(this.#scroll, this.#scroll + this.#bodyRows)];
		if (maxScroll > 0 && this.#scroll < maxScroll) {
			body[body.length - 1] = th.fg("dim", `… ${all.length - this.#scroll - this.#bodyRows} more (pgdn)`);
		}
		const side = this.#sidebarLines(sidebarWidth, contentRows);

		// Frame, matching overlay-box.ts: title inset in the top rule, a ┬ over
		// the column divider, ┴ closing it above the footer.
		const title = " Router report ";
		const leftLen = Math.max(0, dividerCol - 1);
		const rightLen = Math.max(0, width - 2 - dividerCol);
		const fillWidth = Math.max(0, leftLen - 1 - t.visibleWidth(title));
		const out: string[] = [];
		out.push(
			paint(box.topLeft + box.horizontal) +
				th.bold(th.fg("accent", title)) +
				paint(box.horizontal.repeat(fillWidth) + box.teeDown + box.horizontal.repeat(rightLen) + box.topRight),
		);
		const bar = paint(box.vertical);
		for (let i = 0; i < contentRows; i++) {
			out.push(`${bar} ${fit(side[i] ?? "", sidebarWidth, t)} ${bar} ${fit(body[i] ?? "", bodyWidth, t)} ${bar}`);
		}
		out.push(paint(box.teeRight + box.horizontal.repeat(leftLen) + box.teeUp + box.horizontal.repeat(rightLen) + box.teeLeft));
		out.push(`${bar} ${fit(this.#footer(width - 4), Math.max(0, width - 4), t)} ${bar}`);
		out.push(paint(box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight));
		return out;
	}
}
