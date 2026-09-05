/**
 * Token estimation: bytes → tokens without a tokenizer. The ratio is
 * self-calibrating: `estimatePromptTokens` remembers the bytes it estimated
 * from (keyed by conversation), and the ledger folds those bytes against the
 * ACTUAL billed prompt tokens when the turn is recorded, converging
 * `token_calibration` per tokenizer family on measurement.
 */

import type { Ledger } from "../cost/types.ts";
import type { NormRequest } from "../wire/types.ts";

/** Chars-per-token when nothing better is known. Conservative-ish for mixed prose+code. */
export const DEFAULT_BYTES_PER_TOKEN = 3.6;

/**
 * Flat per-image allowance. Vision encoders tile images; a typical tile budget
 * lands around 1100 tokens per image across OpenAI/Anthropic/Gemini.
 */
export const IMAGE_TOKEN_ALLOWANCE = 1100;

/**
 * Per-family defaults, keyed by lowercased `architecture.tokenizer`. DeepSeek
 * traffic is code-dominant, and BPE tokenizers emit more tokens per character
 * on code than on prose, so its ratio sits below the prose-oriented default.
 */
const FAMILY_BYTES_PER_TOKEN: Record<string, number> = {
	claude: 3.6,
	gpt: 3.6,
	gemini: 3.6,
	llama: 3.6,
	qwen: 3.6,
	qwen3: 3.6,
	grok: 3.6,
	mistral: 3.6,
	deepseek: 3.4,
};

function familyKey(tokenizer: string): string {
	return tokenizer.trim().toLowerCase();
}

export function estimateTokens(bytes: number, tokenizer: string, ledger: Ledger | null): number {
	const ratio = ledger?.tokenRatio(tokenizer) ?? FAMILY_BYTES_PER_TOKEN[familyKey(tokenizer)] ?? DEFAULT_BYTES_PER_TOKEN;
	return Math.max(0, Math.ceil(bytes / ratio));
}

/**
 * Pending estimates, keyed by conversation. The router estimates before
 * dispatch; the ledger consumes the estimate when recording the turn, pairing
 * estimated bytes with actual billed tokens for calibration. In-memory only:
 * the data is statistical, so a restart losing it costs nothing.
 */
const PENDING_CAP = 1024;
const pendingEstimates = new Map<string, { tokenizer: string; bytes: number }>();

export function estimatePromptTokens(req: NormRequest, tokenizer: string, ledger: Ledger | null): number {
	let images = 0;
	for (const message of req.messages) images += message.images;
	const tokens = estimateTokens(req.promptBytes, tokenizer, ledger) + images * IMAGE_TOKEN_ALLOWANCE;
	if (pendingEstimates.size >= PENDING_CAP && !pendingEstimates.has(req.conversationKey)) {
		// Map iteration order is insertion order: drop the eldest.
		const eldest = pendingEstimates.keys().next();
		if (!eldest.done) pendingEstimates.delete(eldest.value);
	}
	pendingEstimates.set(req.conversationKey, { tokenizer, bytes: req.promptBytes });
	return tokens;
}

/**
 * Replaces the byte count the pending estimate will be calibrated against.
 *
 * The estimate is taken from the RAW request, but what the upstream bills is
 * the prompt after compaction shrank it and the context block was appended.
 * Pairing raw bytes with billed tokens taught every family a ratio that had
 * compaction baked in (measured: the compacted estimate ran 33% under the
 * billed count). The turn orchestrator calls this with the dispatched size
 * once it knows it, so the ratio describes the tokenizer and nothing else.
 */
export function adjustPendingEstimate(conversationKey: string, dispatchedBytes: number): void {
	const pending = pendingEstimates.get(conversationKey);
	if (pending === undefined || dispatchedBytes <= 0) return;
	pending.bytes = dispatchedBytes;
}

/** Internal: called by cost/ledger.ts when recording a turn. */
export function consumePendingEstimate(conversationKey: string): { tokenizer: string; bytes: number } | null {
	const pending = pendingEstimates.get(conversationKey) ?? null;
	pendingEstimates.delete(conversationKey);
	return pending;
}
