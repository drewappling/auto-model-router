import { describe, expect, test } from "bun:test";

import { loadConfig } from "../src/config/load.ts";
import { createLedger } from "../src/cost/ledger.ts";
import { EMPTY_USAGE, type LedgerEntry } from "../src/cost/types.ts";
import { adjustPendingEstimate, DEFAULT_BYTES_PER_TOKEN, estimatePromptTokens, estimateTokens } from "../src/tokens/estimate.ts";
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

describe("calibration hygiene (review 2026-09-05 §8)", () => {
	function requestOf(text: string) {
		return parseChatRequest({ model: "auto", messages: [{ role: "user", content: text }] }, new Headers());
	}

	test("a provider reporting impossible token counts never calibrates its family", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			const req = requestOf("x".repeat(10_000));
			for (let i = 0; i < 30; i++) {
				estimatePromptTokens(req, "qwen3", ledger);
				// 0.4 bytes/token: ~8x what the bytes imply (seen live from one provider).
				ledger.record(entry({ conversationKey: req.conversationKey, usage: { ...EMPTY_USAGE, promptTokens: Math.round(req.promptBytes / 0.4) } }));
			}
			expect(ledger.tokenRatio("qwen3")).toBeNull();
			for (let i = 0; i < 30; i++) {
				estimatePromptTokens(req, "qwen3", ledger);
				ledger.record(entry({ conversationKey: req.conversationKey, usage: { ...EMPTY_USAGE, promptTokens: Math.round(req.promptBytes / 3.2) } }));
			}
			expect(ledger.tokenRatio("qwen3")).toBeCloseTo(3.2, 1);
		} finally {
			db.close();
		}
	});

	test("adjustPendingEstimate calibrates against the dispatched bytes, not the raw request", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			const req = requestOf("y".repeat(10_000));
			for (let i = 0; i < 30; i++) {
				estimatePromptTokens(req, "grok", ledger);
				// Compaction halved the prompt before dispatch; the upstream billed the half.
				adjustPendingEstimate(req.conversationKey, req.promptBytes / 2);
				ledger.record(entry({ conversationKey: req.conversationKey, usage: { ...EMPTY_USAGE, promptTokens: Math.round(req.promptBytes / 2 / 3.5) } }));
			}
			// Paired with the raw bytes this would have learned 7.0; the dispatched bytes give the true 3.5.
			expect(ledger.tokenRatio("grok")).toBeCloseTo(3.5, 1);
		} finally {
			db.close();
		}
	});
});

describe("ledger.escalationCost", () => {
	test("measures what escalated retries bill per prompt token, once enough exist", () => {
		const db = openDb(":memory:");
		try {
			const ledger = createLedger(db, cfg);
			for (let i = 0; i < 9; i++) {
				ledger.record(entry({ attempt: 1, reportedUsd: 0.02, usage: { ...EMPTY_USAGE, promptTokens: 1_000 } }));
			}
			expect(ledger.escalationCost?.(7)).toBeNull(); // 9 < the sample floor
			ledger.record(entry({ attempt: 1, reportedUsd: 0.02, usage: { ...EMPTY_USAGE, promptTokens: 1_000 } }));
			// Errored retries carry no usage and are excluded.
			ledger.record(entry({ attempt: 1, reportedUsd: null, error: "upstream_error: boom", usage: EMPTY_USAGE }));
			// Memoised: a fresh ledger reads through.
			const fresh = createLedger(db, cfg);
			const cost = fresh.escalationCost?.(7);
			expect(cost).not.toBeNull();
			expect(cost!.samples).toBe(10);
			expect(cost!.usdPerPromptToken).toBeCloseTo(0.02 / 1_000, 8);
		} finally {
			db.close();
		}
	});
});

