import { describe, expect, test } from "bun:test";

import { fetchReport, parseReportArgs, renderStatus, type HealthSnapshot } from "../omp-extension/report-logic.ts";

describe("parseReportArgs", () => {
	test("defaults to 7 days scoped to the harness", () => {
		expect(parseReportArgs("", "omp")).toEqual({ windowDays: 7, harnessId: "omp" });
	});

	test("accepts bare numbers and d/h/w suffixes", () => {
		expect(parseReportArgs("30", "")).toEqual({ windowDays: 30, harnessId: "" });
		expect(parseReportArgs("14d", "")).toEqual({ windowDays: 14, harnessId: "" });
		expect(parseReportArgs("24h", "")).toEqual({ windowDays: 1, harnessId: "" });
		expect(parseReportArgs("36h", "")).toEqual({ windowDays: 2, harnessId: "" });
		expect(parseReportArgs("2w", "")).toEqual({ windowDays: 14, harnessId: "" });
	});

	test("--all drops the harness scope and --harness= sets one", () => {
		expect(parseReportArgs("7d --all", "omp").harnessId).toBe("");
		expect(parseReportArgs("--harness=hermes", "omp").harnessId).toBe("hermes");
	});

	test("ignores junk and clamps the window", () => {
		expect(parseReportArgs("bogus 0 -3", "x")).toEqual({ windowDays: 7, harnessId: "x" });
		expect(parseReportArgs("9999", "").windowDays).toBe(365);
	});
});

describe("fetchReport", () => {
	test("builds the query and returns the JSON body", async () => {
		const seen: string[] = [];
		const fake = async (url: string, init?: RequestInit): Promise<Response> => {
			seen.push(url);
			expect((init?.headers as Record<string, string>).authorization).toBe("Bearer k");
			return new Response(JSON.stringify({ totals: { dispatches: 3 } }), { status: 200 });
		};
		const r = await fetchReport("http://127.0.0.1:1", { windowDays: 3, harnessId: "omp" }, { authorization: "Bearer k" }, fake);
		expect(r.totals.dispatches).toBe(3);
		expect(seen).toEqual(["http://127.0.0.1:1/v1/router/report?days=3&harness=omp"]);
	});

	test("omits the harness param when unscoped and throws on a non-2xx", async () => {
		const seen: string[] = [];
		const fake = async (url: string): Promise<Response> => {
			seen.push(url);
			return new Response("nope", { status: 503 });
		};
		await expect(fetchReport("http://h", { windowDays: 7, harnessId: "" }, {}, fake)).rejects.toThrow("503");
		expect(seen).toEqual(["http://h/v1/router/report?days=7"]);
	});
});

describe("renderStatus", () => {
	test("summarises keys, catalog, ollama and agentdox", () => {
		const now = 1_000_000_000;
		const h: HealthSnapshot = {
			status: "ok",
			apiKeyConfigured: true,
			apiKeySource: "omp",
			agentdox: { url: "http://localhost:3003", defaultScope: "omp-router", recordTurns: true },
			ollama: {
				models: 12,
				available: false,
				cooldownUntilMs: now + 60_000,
				apiKeySource: "omp",
				lastTrip: { kind: "quota", atMs: now - 120_000, message: "402" },
				usage: { monthlyUsedFraction: 0.42, activityCostUsd: 3.1, fetchedAtMs: now },
				meter: { usedUsd: 25.2, creditsUsd: 60, plan: "pro" },
				calibration: { factor: 1.25, meterDeltaUsd: 5, ledgerDeltaUsd: 4, spanHours: 48 },
				runway: { dailyBurnUsd: 1.5, creditsLeftUsd: 34.8, days: 23.2 },
				costBias: { configured: 0.1, effective: 0.1, biasUntilUsage: 0.9 },
			},
			catalog: { models: 240, ageMs: 5 * 60_000, keyScoped: true, shrink: { fromModels: 300, toModels: 120, atMs: now } },
		};
		const text = renderStatus("http://127.0.0.1:8788", h, now);
		expect(text).toContain("configured (omp)");
		expect(text).toContain("240 models");
		expect(text).toContain("refreshed 5m ago");
		expect(text).toContain("SHRANK 300 -> 120");
		expect(text).toContain("COOLING DOWN");
		expect(text).toContain("pro plan usage 42.0% ($25.20 of $60)");
		expect(text).toContain("ollama billing: ledger estimate ×1.25 to match the meter (48h span) · burn $1.50/day · ~23 days of credits left");
		expect(text).toContain("cost bias ×0.1 (until 90%)");
		expect(text).toContain("last trip quota 2m ago");
		expect(text).toContain("scope omp-router");
		expect(text).toContain("recording turns");
	});

	test("degrades cleanly when sections are absent", () => {
		const text = renderStatus("http://h", { status: "ok", apiKeyConfigured: false });
		expect(text).toContain("key MISSING");
		expect(text).toContain("catalog: not fetched yet");
		expect(text).toContain("ollama cloud: disabled");
		expect(text).toContain("agentdox: off");
	});
});
