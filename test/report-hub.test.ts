import { describe, expect, test } from "bun:test";

import { type HubKeys, type HubTheme, ReportHub, WINDOWS } from "../omp-extension/report-hub.ts";
import type { UsageReport } from "../src/cost/report.ts";

/**
 * The hub is a pure component: identity styling, ASCII box glyphs and raw
 * key names stand in for omp's theme, pi-tui and keybindings. These pin the
 * frame geometry, navigation, window/scope cycling and the async load path.
 */

const theme: HubTheme = {
	fg: (_c, t) => t,
	bg: (_c, t) => t,
	bold: (t) => t,
	boxRound: {
		topLeft: "+",
		topRight: "+",
		bottomLeft: "+",
		bottomRight: "+",
		horizontal: "-",
		vertical: "|",
		teeDown: "T",
		teeUp: "U",
		teeLeft: "<",
		teeRight: ">",
	},
	nav: { cursor: ">" },
};

const text = {
	visibleWidth: (s: string) => s.length,
	truncateToWidth: (s: string, w: number) => (s.length <= w ? s : s.slice(0, w)),
};

const keys: HubKeys = {
	up: (d) => d === "UP",
	down: (d) => d === "DOWN",
	left: (d) => d === "LEFT",
	right: (d) => d === "RIGHT",
	pageUp: (d) => d === "PGUP",
	pageDown: (d) => d === "PGDN",
	cancel: (d) => d === "ESC",
	confirm: (d) => d === "ENTER",
};

function report(over: Partial<UsageReport> = {}): UsageReport {
	const row = (key: string, spend: number) => ({
		key,
		dispatches: 10,
		spendUsd: spend,
		share: 0.5,
		cacheHitRate: 0.8,
		cacheEstimated: false,
		avgPromptTokens: 1000,
		avgTtftMs: 900,
		tokensPerSec: 120,
		escalations: 1,
		errors: 0,
	});
	return {
		generatedAtMs: Date.UTC(2026, 8, 6, 12),
		windowDays: 7,
		sinceMs: 0,
		harnessId: "",
		totals: {
			dispatches: 20,
			conversations: 2,
			spendUsd: 3,
			cacheHitRate: 0.8,
			promptTokens: 20000,
			completionTokens: 2000,
			escalations: 2,
			failovers: 0,
			errors: 0,
			aborted: 0,
			modelSwitches: 1,
			cacheEstimated: false,
		},
		providers: [row("openrouter", 2), row("ollama", 1)],
		models: [
			{ ...row("z-ai/glm", 2), provider: "openrouter", tiers: { simple: 6, moderate: 4 } },
			{ ...row("ollama/kimi", 1), provider: "ollama", tiers: { hard: 10 } },
		],
		tiers: [row("simple", 2), row("hard", 1)],
		days: [
			{ day: "2026-09-05", dispatches: 10, spendUsd: 1.5, cacheHitRate: 0.8 },
			{ day: "2026-09-06", dispatches: 10, spendUsd: 1.5, cacheHitRate: 0.8 },
		],
		anatomy: null,
		...over,
	};
}

interface Harness {
	hub: ReportHub;
	renders: number;
	closed: boolean;
	requests: { windowDays: number; harnessId: string }[];
	settle(): Promise<void>;
}

function mount(opts: { harnessId?: string; initialHarness?: string; fail?: boolean; rows?: number } = {}): Harness {
	const h: Harness = {
		hub: undefined as unknown as ReportHub,
		renders: 0,
		closed: false,
		requests: [],
		settle: async () => {
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
		},
	};
	h.hub = new ReportHub({
		theme,
		text,
		keys,
		source: {
			report: async (req) => {
				h.requests.push({ ...req });
				if (opts.fail === true) throw new Error("boom");
				return report({ windowDays: req.windowDays, harnessId: req.harnessId });
			},
			status: async () => "auto-model-router at http://h: ok\nopenrouter: key configured (omp)",
		},
		rows: () => opts.rows ?? 30,
		requestRender: () => {
			h.renders++;
		},
		close: () => {
			h.closed = true;
		},
		initial: { windowDays: 7, harnessId: opts.initialHarness ?? "" },
		harnessId: opts.harnessId ?? "",
	});
	return h;
}

describe("ReportHub frame", () => {
	test("draws a titled two-column frame sized to the terminal", async () => {
		const h = mount({ rows: 30 });
		await h.settle();
		const lines = h.hub.render(100);
		// 1 top + (rows-4) content + divider + footer + bottom
		expect(lines).toHaveLength(30);
		expect(lines[0]).toMatch(/^\+- Router report -+T-+\+$/);
		expect(lines[lines.length - 1]).toMatch(/^\+-+\+$/);
		expect(lines[lines.length - 3]).toMatch(/^>-+U-+<$/);
		for (const l of lines) expect(l.length).toBe(100);
		// Every content row is | sidebar | body |.
		expect(lines[1]).toMatch(/^\| .{18} \| .* \|$/);
	});

	test("overview shows the summary, provider and model tables, and the status row", async () => {
		const h = mount();
		await h.settle();
		const body = h.hub.render(120).join("\n");
		expect(body).toContain("> ◎ Overview");
		expect(body).toContain("last 7d");
		expect(body).toContain("all harnesses");
		expect(body).toContain("spend $3.00 over 20 dispatches");
		expect(body).toContain("providers");
		expect(body).toContain("openrouter");
		expect(body).toContain("z-ai/glm");
		expect(body).toContain("window (7d)");
	});

	test("shows loading before data arrives and the error when the load fails", async () => {
		const h = mount({ fail: true });
		expect(h.hub.render(100).join("\n")).toContain("loading…");
		await h.settle();
		const out = h.hub.render(100).join("\n");
		expect(out).toContain("could not load: boom");
		expect(h.renders).toBeGreaterThanOrEqual(2);
	});
});

describe("ReportHub navigation", () => {
	test("up/down move through views, window entries and status, skipping rules and labels, and wrap", async () => {
		const h = mount();
		await h.settle();
		expect(h.hub.activeView).toBe("overview");
		h.hub.handleInput("DOWN");
		expect(h.hub.activeView).toBe("providers");
		for (let i = 0; i < 3; i++) h.hub.handleInput("DOWN");
		expect(h.hub.activeView).toBe("days");
		// Over the rule and the "Window" label onto the first window entry:
		// the view stays put until Enter picks something.
		h.hub.handleInput("DOWN");
		expect(h.hub.cursorEntry).toEqual({ kind: "window", days: 1, label: "24 hours" });
		expect(h.hub.activeView).toBe("days");
		for (let i = 0; i < 3; i++) h.hub.handleInput("DOWN");
		expect(h.hub.cursorEntry).toEqual({ kind: "window", days: 90, label: "90 days" });
		h.hub.handleInput("DOWN"); // over the rule to Status (no scope entry without a harness id)
		expect(h.hub.activeView).toBe("status");
		expect(h.hub.render(100).join("\n")).toContain("openrouter: key configured (omp)");
		h.hub.handleInput("DOWN"); // wraps
		expect(h.hub.activeView).toBe("overview");
		h.hub.handleInput("UP");
		expect(h.hub.activeView).toBe("status");
	});

	test("the sidebar shows the window selector with the active window marked", async () => {
		const h = mount();
		await h.settle();
		const side = h.hub.render(100).join("\n");
		expect(side).toContain("  Window");
		expect(side).toContain("○ 24 hours");
		expect(side).toContain("● 7 days");
		expect(side).toContain("○ 30 days");
		expect(side).toContain("○ 90 days");
		expect(side).not.toContain("Scope");
	});

	test("enter on a window entry applies it and reloads; the view is unchanged", async () => {
		const h = mount();
		await h.settle();
		// Moving down passes every view (each shows as the cursor lands on it)
		// and stops on the 30-day entry; Enter there changes the window only.
		for (let i = 0; i < 7; i++) h.hub.handleInput("j");
		expect(h.hub.cursorEntry).toEqual({ kind: "window", days: 30, label: "30 days" });
		expect(h.hub.activeView).toBe("days");
		h.hub.handleInput("ENTER");
		expect(h.hub.request.windowDays).toBe(30);
		expect(h.hub.activeView).toBe("days");
		h.hub.handleInput("ENTER"); // same window again: no reload
		await h.settle();
		expect(h.requests.map((r) => r.windowDays)).toEqual([7, 30]);
		expect(h.hub.render(100).join("\n")).toContain("● 30 days");
		expect(h.hub.render(100).join("\n")).toContain("enter set window");
	});

	test("j/k are aliases and a chosen view renders only its table", async () => {
		const h = mount();
		await h.settle();
		h.hub.handleInput("j");
		h.hub.handleInput("j");
		expect(h.hub.activeView).toBe("models");
		const out = h.hub.render(120).join("\n");
		expect(out).toContain("models (top 2 of 2 by spend)");
		expect(out).toContain("simple:6 moderate:4");
		expect(out).not.toContain("spend $3.00 over");
		h.hub.handleInput("k");
		expect(h.hub.activeView).toBe("providers");
	});

	test("left/right cycle the window and reload", async () => {
		const h = mount();
		await h.settle();
		h.hub.handleInput("RIGHT");
		expect(h.hub.request.windowDays).toBe(30);
		h.hub.handleInput("RIGHT");
		expect(h.hub.request.windowDays).toBe(90);
		h.hub.handleInput("RIGHT");
		expect(h.hub.request.windowDays).toBe(WINDOWS[0]!);
		h.hub.handleInput("LEFT");
		expect(h.hub.request.windowDays).toBe(90);
		await h.settle();
		expect(h.requests.map((r) => r.windowDays)).toEqual([7, 30, 90, 1, 90]);
		expect(h.hub.render(100).join("\n")).toContain("last 90d");
	});

	test("the scope entry exists only with a harness id; enter (or a) toggles it", async () => {
		const none = mount();
		await none.settle();
		none.hub.handleInput("a");
		expect(none.hub.request.harnessId).toBe("");

		const h = mount({ harnessId: "omp", initialHarness: "omp" });
		await h.settle();
		let side = h.hub.render(100).join("\n");
		expect(side).toContain("  Scope");
		expect(side).toContain("◉ this harness");
		expect(side).toContain("harness omp");
		// views(5) + window(4) → the scope entry is the 10th selectable.
		for (let i = 0; i < 9; i++) h.hub.handleInput("DOWN");
		expect(h.hub.cursorEntry).toEqual({ kind: "scope" });
		h.hub.handleInput("ENTER");
		expect(h.hub.request.harnessId).toBe("");
		side = h.hub.render(100).join("\n");
		expect(side).toContain("◎ all harnesses");
		expect(side).toContain("enter toggle scope");
		h.hub.handleInput("a");
		expect(h.hub.request.harnessId).toBe("omp");
		await h.settle();
		expect(h.requests.map((r) => r.harnessId)).toEqual(["omp", "", "omp"]);
	});

	test("esc and q close; r reloads", async () => {
		const h = mount();
		await h.settle();
		h.hub.handleInput("r");
		await h.settle();
		expect(h.requests).toHaveLength(2);
		h.hub.handleInput("ESC");
		expect(h.closed).toBe(true);
		const h2 = mount();
		h2.hub.handleInput("q");
		expect(h2.closed).toBe(true);
	});

	test("page down scrolls a table longer than the pane and shows the remainder", async () => {
		const h = mount({ rows: 16 });
		await h.settle();
		// 12 body rows; the overview is longer than that.
		const first = h.hub.render(100).join("\n");
		expect(first).toContain("more (pgdn)");
		h.hub.handleInput("PGDN");
		const second = h.hub.render(100).join("\n");
		expect(second).not.toBe(first);
		h.hub.handleInput("PGUP");
		expect(h.hub.render(100).join("\n")).toBe(first);
	});

	test("a stale load never overwrites a newer one", async () => {
		let resolveSlow: ((r: UsageReport) => void) | undefined;
		const seen: number[] = [];
		const hub = new ReportHub({
			theme,
			text,
			keys,
			source: {
				report: (req) => {
					seen.push(req.windowDays);
					if (req.windowDays === 7) return new Promise<UsageReport>((r) => (resolveSlow = r));
					return Promise.resolve(report({ windowDays: req.windowDays }));
				},
				status: async () => "ok",
			},
			rows: () => 30,
			requestRender: () => {},
			close: () => {},
			initial: { windowDays: 7, harnessId: "" },
			harnessId: "",
		});
		hub.handleInput("RIGHT"); // 30d, resolves immediately
		await new Promise((r) => setTimeout(r, 0));
		resolveSlow?.(report({ windowDays: 7, totals: { ...report().totals, dispatches: 999 } }));
		await new Promise((r) => setTimeout(r, 0));
		expect(seen).toEqual([7, 30]);
		expect(hub.render(100).join("\n")).toContain("last 30d");
		expect(hub.render(100).join("\n")).not.toContain("999");
	});
});
