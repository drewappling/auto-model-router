import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config/load.ts";
import { createLedger } from "../src/cost/ledger.ts";
import { EMPTY_USAGE, type LedgerEntry } from "../src/cost/types.ts";
import { DEFAULT_BYTES_PER_TOKEN, estimatePromptTokens, estimateTokens } from "../src/tokens/estimate.ts";
import { openDb } from "../src/util/sqlite.ts";
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
		slug: "openai/gpt-5-mini",
		servedSlug: "openai/gpt-5-mini",
		tier: "simple",
		classificationSource: "heuristic",
		reasons: [],
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
		...over,
	};
}

describe("estimateTokens", () => {
	test("uses the default ratio for an unknown tokenizer family", () => {
		expect(estimateTokens(3600, "no-such-tokenizer", null)).toBe(Math.ceil(3600 / DEFAULT_BYTES_PER_TOKEN));
	});

	test("scales linearly with byte count and never goes negative", () => {
		expect(estimateTokens(0, "gpt", null)).toBe(0);
		const small = estimateTokens(1000, "gpt", null);
		const large = estimateTokens(10_000, "gpt", null);
		expect(large).toBeGreaterThan(small);
	});

	test("a code-dense family estimates more tokens for the same bytes", () => {
		// BPE tokenizers emit more tokens per character on code than on prose,
		// so a lower bytes-per-token ratio must yield a higher token count.
		expect(estimateTokens(10_000, "deepseek", null)).toBeGreaterThan(estimateTokens(10_000, "gpt", null));
	});

	test("is case-insensitive about the tokenizer name", () => {
		expect(estimateTokens(5000, "Claude", null)).toBe(estimateTokens(5000, "claude", null));
	});
});

describe("ledger calibration", () => {
	test("a calibrated ratio replaces the family default once enough samples land", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			expect(ledger.tokenRatio("claude")).toBeNull();

			const req = parseChatRequest(
				{ model: "auto", messages: [{ role: "user", content: "x".repeat(4000) }] },
				new Headers(),
			);

			// The real prompt turned out to be far more token-dense than 3.6
			// bytes/token; the ledger must converge on the measurement.
			const observedTokens = Math.round(req.promptBytes / 2);
			for (let i = 0; i < 30; i++) {
				estimatePromptTokens(req, "claude", ledger);
				ledger.record(
					entry({
						conversationKey: req.conversationKey,
						usage: { ...EMPTY_USAGE, promptTokens: observedTokens, completionTokens: 10 },
					}),
				);
			}

			const ratio = ledger.tokenRatio("claude");
			expect(ratio).not.toBeNull();
			if (ratio === null) return;
			expect(ratio).toBeCloseTo(2, 1);

			// And the estimate now follows the measurement, not the default.
			const calibrated = estimateTokens(4000, "claude", ledger);
			expect(calibrated).toBeGreaterThan(estimateTokens(4000, "claude", null));
		} finally {
			db.close();
		}
	});

	test("an uncalibrated family still falls back to its default", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			expect(ledger.tokenRatio("gemini")).toBeNull();
			expect(estimateTokens(3600, "gemini", ledger)).toBe(estimateTokens(3600, "gemini", null));
		} finally {
			db.close();
		}
	});
});

describe("estimatePromptTokens", () => {
	test("counts tool schemas, not just message text", () => {
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

	test("charges a per-image allowance on top of text", () => {
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
