/**
 * Feature extraction: the cheap signals that drive classification.
 *
 * Everything here is a pure function of the normalized request. No tokenizer,
 * no I/O, no model call — this runs on every agent turn, so the work is a few
 * linear scans over the message list and at most one pass over the newest
 * user-authored text.
 */

import type { NormMessage, NormRequest } from "../wire/types.ts";
import type { Features } from "./types.ts";

/**
 * Complexity signals. Deliberately small: each hit pushes the turn toward a
 * more expensive tier, so precision beats recall. Word-boundary matches,
 * evaluated only against the newest user-authored content — never history.
 */
const COMPLEXITY_KEYWORDS: ReadonlyArray<readonly [string, RegExp]> = [
	["architecture", /\barchitecture\b/i],
	["refactor", /\brefactor\w*/i],
	["debug", /\bdebug\w*/i],
	// "race" (condition); inflected forms are too rare in agent traffic to matter.
	["race", /\brace\b/i],
	["deadlock", /\bdeadlock\w*/i],
	// Causal "why" questions demand reasoning, not retrieval.
	["why", /\bwhy\b/i],
	["root cause", /\broot cause\b/i],
	["design", /\bdesign\w*/i],
	["optimize", /\boptimi[sz]\w*/i],
	["security", /\bsecurity\b/i],
	["migrate", /\bmigrat\w*/i],
	["concurrency", /\bconcurren\w*/i],
	["invariant", /\binvariant\w*/i],
	["proof", /\bproof\w*/i],
];

/** Triviality signals: mechanical edits a small model cannot fumble. */
const TRIVIALITY_KEYWORDS: ReadonlyArray<readonly [string, RegExp]> = [
	["rename", /\brename\w*/i],
	["typo", /\btypos?\b/i],
	["format", /\bformat\w*/i],
	// Dependency/version bumps.
	["bump", /\bbump\w*/i],
	["comment", /\bcomments?\b/i],
	["changelog", /\bchangelogs?\b/i],
	["add a test", /\badd (?:a|an|some) tests?\b/i],
	["lint", /\blint(?:ing|ed)?\b/i],
];

/**
 * Error markers scanned in tail tool results. Kept short and literal on
 * purpose: a false positive escalates a turn that was actually fine, which
 * costs real money; a false negative merely routes like a clean continuation.
 */
const TOOL_FAILURE_MARKERS: ReadonlyArray<RegExp> = [
	// "error:"/"Error:" at a line start — the near-universal tool error prefix.
	/(?:^|\n)\s*(?:error|Error):/,
	// Python crash dump.
	/Traceback \(most recent call last\)/,
	// Shell: missing binary.
	/command not found/,
	// Non-zero process exit. "exit code 0" is success and never matches.
	/exit(?:ed with)? code [1-9]\d*/i,
	// GNU make: "make: *** [target] Error 2". "Error" sits mid-line so the
	// prefix rule above misses it, and the "*** " literal is distinctive
	// enough that successful builds never produce it.
	/(?:^|\n)[^\n]*\*\*\* \[[^\]]*\] Error \d+/,
];

// Unified-diff headers. Plain "--- "/"+++ " are excluded: markdown rules and
// lists would false-positive. `diff --git`, hunks, and a/ b/ paths are real diffs.
const DIFF_RE = /(?:^|\n)(?:diff --git |@@ -\d|\+{3} b\/|-{3} a\/)/;

// A "terse instruction" is one short sentence; longer text carries real requirements.
const TERSE_MAX_BYTES = 128;

/** Index after the last message of the trailing run matching `pred`. */
function trailingRunStart(messages: NormMessage[], pred: (m: NormMessage) => boolean): number {
	let i = messages.length - 1;
	while (i >= 0) {
		const m = messages[i];
		if (m === undefined || !pred(m)) break;
		i--;
	}
	return i + 1;
}

export function extractFeatures(req: NormRequest, promptTokens: number): Features {
	const messages = req.messages;
	const tail = messages[messages.length - 1];

	// The volatile tail: either the newest user-authored content (a trailing
	// run of user messages — what the human just supplied) or, when the tail is
	// tool output, a mechanical agent-loop continuation with no new user content.
	const isToolResultContinuation = tail?.role === "tool";
	let newContentBytes = 0;
	let newestUserText = "";
	if (isToolResultContinuation) {
		const start = trailingRunStart(messages, (m) => m.role === "tool");
		for (let i = start; i < messages.length; i++) newContentBytes += messages[i]?.textBytes ?? 0;
	} else if (tail?.role === "user") {
		const start = trailingRunStart(messages, (m) => m.role === "user");
		const parts: string[] = [];
		for (let i = start; i < messages.length; i++) {
			const m = messages[i];
			if (m === undefined) continue;
			newContentBytes += m.textBytes;
			parts.push(m.text);
		}
		newestUserText = parts.join("\n");
	}
	// Proportional share of the caller's prompt estimate, so this inherits
	// whatever tokenizer calibration the estimate already applied.
	const newContentTokens =
		req.promptBytes > 0 && newContentBytes > 0
			? Math.max(1, Math.round(promptTokens * (newContentBytes / req.promptBytes)))
			: 0;

	// Depth of the current agent loop: trailing tool results plus the assistant
	// tool-call turns interleaved with them.
	let toolLoopDepth = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m === undefined) break;
		if (m.role === "tool" || (m.role === "assistant" && m.toolCalls.length > 0)) toolLoopDepth++;
		else break;
	}

	let turnDepth = 0;
	let toolSchemaBytes = 0;
	const toolNames = new Set<string>();
	for (const t of req.tools) toolSchemaBytes += t.schemaBytes;
	for (const m of messages) {
		if (m.role === "user" || m.role === "assistant") turnDepth++;
		if (m.role === "assistant") for (const tc of m.toolCalls) toolNames.add(tc.name);
		if (m.toolName !== undefined) toolNames.add(m.toolName);
	}

	// The last two assistant tool calls, in conversation order.
	let lastName: string | null = null;
	let lastArgs = "";
	let prevName: string | null = null;
	let prevArgs = "";
	scanCalls: for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m === undefined || m.role !== "assistant") continue;
		for (let j = m.toolCalls.length - 1; j >= 0; j--) {
			const tc = m.toolCalls[j];
			if (tc === undefined) continue;
			if (lastName === null) {
				lastName = tc.name;
				lastArgs = tc.argsJson;
			} else {
				prevName = tc.name;
				prevArgs = tc.argsJson;
				break scanCalls;
			}
		}
	}
	const repeatedToolCall = lastName !== null && lastName === prevName && lastArgs === prevArgs;

	let lastToolFailed = false;
	if (isToolResultContinuation) {
		scanResults: for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m === undefined || m.role !== "tool") break;
			for (const re of TOOL_FAILURE_MARKERS) {
				if (re.test(m.text)) {
					lastToolFailed = true;
					break scanResults;
				}
			}
		}
	}

	// Fenced code blocks: odd segments of a ``` split. Byte count includes the
	// language tag line — close enough for a signal, and allocation-free per block.
	let codeBlocks = 0;
	let codeBytes = 0;
	if (newestUserText.includes("```")) {
		const parts = newestUserText.split("```");
		codeBlocks = (parts.length - 1) >> 1;
		for (let i = 1; i + 1 < parts.length; i += 2) codeBytes += Buffer.byteLength(parts[i] ?? "");
	}

	let questionCount = 0;
	for (let i = 0; i < newestUserText.length; i++) {
		if (newestUserText.charCodeAt(i) === 63) questionCount++;
	}

	const complexityKeywords: string[] = [];
	for (const [id, re] of COMPLEXITY_KEYWORDS) if (re.test(newestUserText)) complexityKeywords.push(id);
	const trivialityKeywords: string[] = [];
	for (const [id, re] of TRIVIALITY_KEYWORDS) if (re.test(newestUserText)) trivialityKeywords.push(id);

	const trimmed = newestUserText.trim();
	const terminators = trimmed.match(/[.!?]+(?:\s|$)/g);
	const isTerseInstruction =
		trimmed.length > 0 &&
		Buffer.byteLength(trimmed) <= TERSE_MAX_BYTES &&
		codeBlocks === 0 &&
		(terminators === null ? 0 : terminators.length) <= 1;

	return {
		promptTokens,
		newContentTokens,
		turnDepth,
		toolCount: req.tools.length,
		toolSchemaBytes,
		isToolResultContinuation,
		toolLoopDepth,
		distinctToolsUsed: toolNames.size,
		lastToolFailed,
		repeatedToolCall,
		hasImages: req.hasImages,
		codeBlocks,
		codeBytes,
		looksLikeDiff: DIFF_RE.test(newestUserText),
		complexityKeywords,
		trivialityKeywords,
		requestedReasoning: req.reasoning,
		questionCount,
		isTerseInstruction,
	};
}
