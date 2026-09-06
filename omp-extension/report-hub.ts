/**
 * Fullscreen report hub for `/router report`, drawn the way omp's `/models`
 * hub is: a titled two-column frame on the alternate screen, a sidebar of
 * views on the left, the selected view's table on the right, a divider and
 * a footer hint row. The sidebar holds the views, a Window
 * selector (24h / 7d / 30d / 90d) and, when the session has a harness id, a
 * scope toggle. Keys: ↑/↓ or j/k move, Enter applies a window or scope entry,
 * ←/→ also cycle the window, PgUp/PgDn scroll a long table, r reloads, Esc/q
 * close.
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
	confirm(data: string): boolean;
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

type SidebarEntry =
	| { kind: "view"; id: ViewId; label: string; icon: string }
	| { kind: "window"; days: number; label: string }
	| { kind: "scope" }
	| { kind: "label"; label: string }
	| { kind: "sep" };

const VIEWS: readonly Extract<SidebarEntry, { kind: "view" }>[] = [
	{ kind: "view", id: "overview", label: "Overview", icon: "◎" },
	{ kind: "view", id: "providers", label: "Providers", icon: "◈" },
	{ kind: "view", id: "models", label: "Models", icon: "◇" },
	{ kind: "view", id: "tiers", label: "Tiers", icon: "≡" },
	{ kind: "view", id: "days", label: "By day", icon: "▤" },
];

const WINDOW_LABELS: Record<number, string> = { 1: "24 hours", 7: "7 days", 30: "30 days", 90: "90 days" };

/** Sidebar in order: views, Window selector, scope toggle (when scoped), Status. */
function buildEntries(hasHarness: boolean): SidebarEntry[] {
	const entries: SidebarEntry[] = [...VIEWS, { kind: "sep" }, { kind: "label", label: "Window" }];
	for (const days of WINDOWS) entries.push({ kind: "window", days, label: WINDOW_LABELS[days] ?? `${days}d` });
	if (hasHarness) entries.push({ kind: "sep" }, { kind: "label", label: "Scope" }, { kind: "scope" });
	entries.push({ kind: "sep" }, { kind: "view", id: "status", label: "Status", icon: "●" });
	return entries;
}

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
	#entries: SidebarEntry[];
	/** Sidebar cursor (index into #entries). */
	#cursor = 0;
	#view: ViewId = "overview";
	#scroll = 0;
	#report: UsageReport | null = null;
	#data: ReportView | null = null;
	#status: string | null = null;
	#loading = false;
	#error: string | null = null;
	#generation = 0;
	#disposed = false;
	#bodyRows = 10;

	constructor(o: HubOptions) {
		this.#o = o;
		this.#req = { ...o.initial };
		this.#entries = buildEntries(o.harnessId !== "");
		void this.#load();
	}

	get request(): ReportRequest {
		return this.#req;
	}

	get activeView(): ViewId {
		return this.#view;
	}

	/** The sidebar entry under the cursor. */
	get cursorEntry(): SidebarEntry {
		return this.#entries[this.#cursor] ?? { kind: "sep" };
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
			this.#data = reportView(report);
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
		let next = this.#cursor;
		for (let i = 0; i < this.#entries.length; i++) {
			next = (next + delta + this.#entries.length) % this.#entries.length;
			const kind = this.#entries[next]?.kind;
			if (kind !== "sep" && kind !== "label") break;
		}
		this.#cursor = next;
		// Landing on a view shows it at once, as /models does for its scopes;
		// window and scope entries wait for Enter.
		const e = this.#entries[next];
		if (e?.kind === "view" && e.id !== this.#view) {
			this.#view = e.id;
			this.#scroll = 0;
		}
	}

	#setWindow(days: number): void {
		if (days === this.#req.windowDays) return;
		this.#req = { ...this.#req, windowDays: days };
		this.#scroll = 0;
		void this.#load();
	}

	/** Enter on the cursor entry: apply a window or flip the scope. */
	#activate(): void {
		const e = this.cursorEntry;
		if (e.kind === "window") this.#setWindow(e.days);
		else if (e.kind === "scope") this.#toggleScope();
	}

	#cycleWindow(delta: number): void {
		const i = WINDOWS.indexOf(this.#req.windowDays);
		const next = i < 0 ? 0 : (i + delta + WINDOWS.length) % WINDOWS.length;
		this.#setWindow(WINDOWS[next] ?? 7);
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
		else if (k.confirm(data) || data === " ") this.#activate();
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
		const v = this.#data;
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
		const heading = this.#data === null ? `last ${this.#req.windowDays}d · ${scope}` : `${this.#data.heading.replace(/ · harness [^·]+/, "")} · ${scope}`;
		const tail = this.#loading ? th.fg("warning", " · loading…") : "";
		return this.#o.text.truncateToWidth(th.fg("accent", ` ${heading}`) + tail, width);
	}

	#sidebarLines(width: number, rows: number): string[] {
		const th = this.#o.theme;
		const lines: string[] = [];
		this.#entries.forEach((e, i) => {
			const here = i === this.#cursor;
			const cursor = here ? th.fg("accent", th.nav.cursor) : " ";
			switch (e.kind) {
				case "sep":
					lines.push(th.fg("border", th.boxRound.horizontal.repeat(width)));
					return;
				case "label":
					lines.push(th.fg("dim", `  ${e.label}`));
					return;
				case "view": {
					const active = e.id === this.#view;
					const label = active ? th.bold(th.fg("accent", e.label)) : e.label;
					lines.push(`${cursor} ${th.fg(active ? "accent" : "dim", e.icon)} ${label}`);
					return;
				}
				case "window": {
					const on = e.days === this.#req.windowDays;
					lines.push(`${cursor} ${on ? th.fg("accent", "●") : th.fg("dim", "○")} ${on ? th.bold(e.label) : e.label}`);
					return;
				}
				case "scope": {
					const scoped = this.#req.harnessId !== "";
					const label = scoped ? `this harness` : "all harnesses";
					lines.push(`${cursor} ${th.fg("accent", scoped ? "◉" : "◎")} ${label}`);
					return;
				}
			}
		});
		while (lines.length < rows) lines.push("");
		return lines.slice(0, rows);
	}

	#footer(width: number): string {
		const th = this.#o.theme;
		const e = this.cursorEntry;
		const enter = e.kind === "window" ? "enter set window · " : e.kind === "scope" ? "enter toggle scope · " : "";
		return this.#o.text.truncateToWidth(th.fg("dim", `↑↓ move · ${enter}←→ window (${this.#req.windowDays}d) · pgup/pgdn scroll · r reload · esc close`), width);
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
