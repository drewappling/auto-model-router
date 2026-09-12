import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateStore } from "../src/util/schema.ts";
import { num, openSqlDb } from "../src/util/sql.ts";

import { loadConfig } from "../src/config/load.ts";
import { createSqlLedger } from "../src/cost/ledger-sql.ts";
import { EMPTY_USAGE, type LedgerEntry } from "../src/cost/types.ts";
import { adjustPendingEstimate, DEFAULT_BYTES_PER_TOKEN, estimatePromptTokens, estimateTokens } from "../src/tokens/estimate.ts";
import { parseChatRequest } from "../src/wire/openai/request.ts";

const cfg = loadConfig({});

function entry(over: Partial<LedgerEntry>): LedgerEntry {
	return {
		id: crypto.randomUUID(),
		createdAtMs: Date.now(),
		conversationKey: "k",
		sessionId: "omp-k",
		turn: 1,
		requestedModel: "auto",
		harnessId: "",
		ompSessionId: "",
		slug: "openai/gpt-5-mini",
		servedSlug: "openai/gpt-5-mini",
		tier: "simple",
		classificationSource: "heuristic",
		reasons: [],
		features: null,
		score: null,
		confidence: null,
		task: null,
		classifierReasons: null,
		exploredFrom: null,
		holdArm: null,
		predictedUsd: 0.001,
		reportedUsd: 0.001,
		usage: EMPTY_USAGE,
		attempt: 0,
		escalationSignal: null,
		latencyMs: 100,
		ttftMs: 50,
		finishReason: "stop",
		wasted: false,
		upstreamGenerationId: null,
		error: null,
		promptTokensSaved: 0,
		...over,
	};
}

describe("estimateTokens", () => {
	test("uses the default ratio for an unknown tokenizer family", async () => {
		expect(estimateTokens(3600, "no-such-tokenizer", null)).toBe(Math.ceil(3600 / DEFAULT_BYTES_PER_TOKEN));
	});

	test("scales linearly with byte count and never goes negative", async () => {
		expect(estimateTokens(0, "gpt", null)).toBe(0);
		const small = estimateTokens(1000, "gpt", null);
		const large = estimateTokens(10_000, "gpt", null);
		expect(large).toBeGreaterThan(small);
	});

	test("a code-dense family estimates more tokens for the same bytes", async () => {
		// BPE tokenizers emit more tokens per character on code than on prose,
		// so a lower bytes-per-token ratio must yield a higher token count.
		expect(estimateTokens(10_000, "deepseek", null)).toBeGreaterThan(estimateTokens(10_000, "gpt", null));
	});

	test("is case-insensitive about the tokenizer name", async () => {
		expect(estimateTokens(5000, "Claude", null)).toBe(estimateTokens(5000, "claude", null));
	});
});

describe("ledger calibration", () => {
	test("a calibrated ratio replaces the family default once enough samples land", async () => {
		const db = openSqlDb(join(tmpdir(), `t-tokens.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			expect(await ledger.tokenRatio("claude")).toBeNull();

			const req = parseChatRequest(
				{ model: "auto", messages: [{ role: "user", content: "x".repeat(4000) }] },
				new Headers(),
			);

			// The real prompt turned out to be far more token-dense than 3.6
			// bytes/token; the ledger must converge on the measurement.
			const observedTokens = Math.round(req.promptBytes / 2);
			for (let i = 0; i < 30; i++) {
				estimatePromptTokens(req, "claude", null);
				await ledger.record(
					entry({
						conversationKey: req.conversationKey,
						usage: { ...EMPTY_USAGE, promptTokens: observedTokens, completionTokens: 10 },
					}),
				);
			}

			const ratio = await ledger.tokenRatio("claude");
			expect(ratio).not.toBeNull();
			if (ratio === null) return;
			expect(ratio).toBeCloseTo(2, 1);

			// And the estimate follows the measurement, not the family default.
			const calibrated = estimateTokens(4000, "claude", ratio);
			expect(calibrated).toBeGreaterThan(estimateTokens(4000, "claude", null));
		} finally {
			await db.close();
		}
	});

	test("an uncalibrated family still falls back to its default", async () => {
		const db = openSqlDb(join(tmpdir(), `t-tokens.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			expect(await ledger.tokenRatio("gemini")).toBeNull();
			// An uncalibrated family reads null, which is exactly the default path.
			expect(estimateTokens(3600, "gemini", await ledger.tokenRatio("gemini"))).toBe(estimateTokens(3600, "gemini", null));
		} finally {
			await db.close();
		}
	});
});

describe("estimatePromptTokens", () => {
	test("counts tool schemas, not just message text", async () => {
		const bare = parseChatRequest({ model: "auto", messages: [{ role: "user", content: "hi" }] }, new Headers());
		const withTools = parseChatRequest(
			{
				model: "auto",
				messages: [{ role: "user", content: "hi" }],
				tools: [
					{
						type: "function",
						function: {
							name: "bash",
							description: "Run a shell command and return its output",
							parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
						},
					},
				],
			},
			new Headers(),
		);
		expect(estimatePromptTokens(withTools, "gpt", null)).toBeGreaterThan(estimatePromptTokens(bare, "gpt", null));
	});

	test("charges a per-image allowance on top of text", async () => {
		const text = parseChatRequest(
			{ model: "auto", messages: [{ role: "user", content: [{ type: "text", text: "describe" }] }] },
			new Headers(),
		);
		const withImage = parseChatRequest(
			{
				model: "auto",
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: "describe" },
							{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
						],
					},
				],
			},
			new Headers(),
		);
		// An image costs far more than the handful of bytes its URL adds.
		expect(estimatePromptTokens(withImage, "gpt", null)).toBeGreaterThan(estimatePromptTokens(text, "gpt", null) + 500);
	});
});

describe("calibration hygiene (review 2026-09-05 §8)", () => {
	function requestOf(text: string) {
		return parseChatRequest({ model: "auto", messages: [{ role: "user", content: text }] }, new Headers());
	}

	test("a provider reporting impossible token counts never calibrates its family", async () => {
		const db = openSqlDb(join(tmpdir(), `t-tokens.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			const req = requestOf("x".repeat(10_000));
			for (let i = 0; i < 30; i++) {
				estimatePromptTokens(req, "qwen3", null);
				// 0.4 bytes/token: ~8x what the bytes imply (seen live from one provider).
				await ledger.record(entry({ conversationKey: req.conversationKey, usage: { ...EMPTY_USAGE, promptTokens: Math.round(req.promptBytes / 0.4) } }));
			}
			expect(await ledger.tokenRatio("qwen3")).toBeNull();
			for (let i = 0; i < 30; i++) {
				estimatePromptTokens(req, "qwen3", null);
				await ledger.record(entry({ conversationKey: req.conversationKey, usage: { ...EMPTY_USAGE, promptTokens: Math.round(req.promptBytes / 3.2) } }));
			}
			expect(await ledger.tokenRatio("qwen3")).toBeCloseTo(3.2, 1);
		} finally {
			await db.close();
		}
	});

	test("adjustPendingEstimate calibrates against the dispatched bytes, not the raw request", async () => {
		const db = openSqlDb(join(tmpdir(), `t-tokens.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			const req = requestOf("y".repeat(10_000));
			for (let i = 0; i < 30; i++) {
				estimatePromptTokens(req, "grok", null);
				// Compaction halved the prompt before dispatch; the upstream billed the half.
				adjustPendingEstimate(req.conversationKey, req.promptBytes / 2);
				await ledger.record(entry({ conversationKey: req.conversationKey, usage: { ...EMPTY_USAGE, promptTokens: Math.round(req.promptBytes / 2 / 3.5) } }));
			}
			// Paired with the raw bytes this would have learned 7.0; the dispatched bytes give the true 3.5.
			expect(await ledger.tokenRatio("grok")).toBeCloseTo(3.5, 1);
		} finally {
			await db.close();
		}
	});
});

describe("ledger.escalationCost", () => {
	test("measures what escalated retries bill per prompt token, once enough exist", async () => {
		const db = openSqlDb(join(tmpdir(), `t-tokens.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			for (let i = 0; i < 9; i++) {
				await ledger.record(entry({ attempt: 1, reportedUsd: 0.02, usage: { ...EMPTY_USAGE, promptTokens: 1_000 } }));
			}
			expect(await ledger.escalationCost(7)).toBeNull(); // 9 < the sample floor
			await ledger.record(entry({ attempt: 1, reportedUsd: 0.02, usage: { ...EMPTY_USAGE, promptTokens: 1_000 } }));
			// Errored retries carry no usage and are excluded.
			await ledger.record(entry({ attempt: 1, reportedUsd: null, error: "upstream_error: boom", usage: EMPTY_USAGE }));
			// Memoised: a fresh ledger reads through.
			const fresh = createSqlLedger(db, cfg, { findModel: () => null });
			const cost = await fresh.escalationCost(7);
			expect(cost).not.toBeNull();
			expect(cost?.samples).toBe(10);
			expect(cost?.usdPerPromptToken).toBeCloseTo(0.02 / 1_000, 8);
		} finally {
			await db.close();
		}
	});
});


describe("ledger.softFailureSpikes", () => {
	test("flags a model whose last-hour failure rate is a spike against its own 7-day baseline", async () => {
		const db = openSqlDb(join(tmpdir(), `t-tokens.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			const now = 1_800_000_000_000;
			const H = 3_600_000;
			// Baseline: 100 dispatches over the prior week at 5% soft failures.
			for (let i = 0; i < 100; i++) {
				await ledger.record(entry({ createdAtMs: now - 2 * H - i * 60 * 60_000, escalationSignal: i % 20 === 0 ? "empty_completion" : null, wasted: i % 20 === 0 }));
			}
			// Last hour: 10 dispatches, 4 soft failures (40%): a spike.
			for (let i = 0; i < 10; i++) {
				await ledger.record(entry({ createdAtMs: now - 5 * 60_000 - i * 60_000, escalationSignal: i < 4 ? "repeat_tool_call" : null, wasted: i < 4 }));
			}
			// A second model with plenty of failures but a matching baseline is not spiking.
			for (let i = 0; i < 100; i++) {
				await ledger.record(entry({ slug: "x/steady", servedSlug: "x/steady", createdAtMs: now - 2 * H - i * 60 * 60_000, error: i % 2 === 0 ? "upstream_error: 502" : null }));
			}
			for (let i = 0; i < 10; i++) {
				await ledger.record(entry({ slug: "x/steady", servedSlug: "x/steady", createdAtMs: now - 5 * 60_000 - i * 60_000, error: i % 2 === 0 ? "upstream_error: 502" : null }));
			}
			// Aborted and quota errors are not attributable; digest rows are side calls.
			for (let i = 0; i < 10; i++) {
				await ledger.record(entry({ slug: "x/aborted", servedSlug: "x/aborted", createdAtMs: now - 5 * 60_000 - i * 60_000, error: "aborted: client closed" }));
				await ledger.record(entry({ slug: "x/digest", servedSlug: "x/digest", requestedModel: "digest", createdAtMs: now - 5 * 60_000 - i * 60_000, error: "upstream_error: 500" }));
			}
			const spikes = await ledger.softFailureSpikes(now);
			expect(spikes.map((s) => s.slug)).toEqual(["openai/gpt-5-mini"]);
			const s = spikes[0]!;
			expect(s.recentDispatches).toBe(10);
			expect(s.recentFailures).toBe(4);
			expect(s.recentRate).toBeCloseTo(0.4, 6);
			expect(s.baselineDispatches).toBe(100);
			expect(s.baselineFailures).toBe(5);
			expect(s.baselineRate).toBeCloseTo(0.05, 6);
			// Too few recent dispatches: nothing spikes, however high the rate.
			expect(await ledger.softFailureSpikes(now, 3 * 60_000)).toEqual([]);
		} finally {
			await db.close();
		}
	});
});

describe("ledger.prune and markWasted", () => {
	test("prune deletes rows past retention and 0 keeps everything; markWasted flips one row", async () => {
		const db = openSqlDb(join(tmpdir(), `t-tokens.test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
		try {
			const ledger = createSqlLedger(db, cfg, { findModel: () => null });
			const now = 1_800_000_000_000;
			const DAY = 86_400_000;
			for (let i = 0; i < 5; i++) await ledger.record(entry({ createdAtMs: now - i * 100 * DAY }));
			expect(await ledger.prune(0, now)).toEqual({ deleted: 0, oldestKeptMs: now - 400 * DAY });
			expect(await ledger.recentEntries(10)).toHaveLength(5);
			for (const atMs of [now - 400 * DAY, now - DAY]) {
				await db.sql`INSERT INTO ollama_meter_samples (at_ms, meter_usd, ledger_usd) VALUES (${atMs}, 1, 1)`;
			}
			expect((await ledger.prune(365, now))?.deleted).toBe(1); // only the 400-day-old row
			const samples = await db.one<{ n: unknown }>("SELECT COUNT(*) AS n FROM ollama_meter_samples");
			expect(num(samples?.n)).toBe(1);
			expect(await ledger.recentEntries(10)).toHaveLength(4);
			expect((await ledger.prune(150, now))?.deleted).toBe(2); // 200 and 300 days old
			const left = await ledger.recentEntries(10);
			expect(left).toHaveLength(2);
			expect(left.every((e) => e.wasted === false)).toBe(true);
			await ledger.markWasted(left[0]!.id);
			expect((await ledger.recentEntries(10)).find((e) => e.id === left[0]!.id)?.wasted).toBe(true);
		} finally {
			await db.close();
		}
	});
});
