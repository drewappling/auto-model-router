/**
 * Context compaction (Phase 1): deterministic pruning of stale, low-value bulk
 * — chiefly old tool output — from a turn's history before dispatch.
 *
 * This module only DECIDES (a plan of per-message edits) from cheap NormMessage
 * metadata; `renderUpstreamBody` APPLIES the edits to the raw message bytes.
 * Every edit shrinks a single tool-result's CONTENT in place — never removes or
 * reorders a message — so tool_call↔result pairing, cache-breakpoint indices,
 * and the agentdox context-block append all stay valid. It is a pure function
 * of its inputs, so `explain` still replays a past decision offline.
 *
 * See docs/context-optimization.md.
 */

import type { CompactionConfig } from "../config/types.ts";
import type { CompactionEdit, NormMessage } from "../wire/types.ts";

export interface CompactionResult {
	edits: CompactionEdit[];
	/** Estimated prompt bytes removed by the plan. */
	savedBytes: number;
}

const EMPTY: CompactionResult = { edits: [], savedBytes: 0 };

/** Approximate byte cost of an elision breadcrumb; savings are net of it. */
const BREADCRUMB_BYTES = 120;

/**
 * Byte size a message ends up with once `edit` is applied — the size that
 * actually reaches the upstream. Cache-breakpoint placement walks these rather
 * than the raw `textBytes`, so its boundaries match the dispatched bytes.
 */
export function compactedBytes(originalBytes: number, edit: CompactionEdit | undefined): number {
	if (edit === undefined) return originalBytes;
	const kept = edit.mode === "stub" ? BREADCRUMB_BYTES : edit.keepHead + edit.keepTail + BREADCRUMB_BYTES;
	return Math.min(originalBytes, kept);
}

/**
 * Validates a persisted compaction plan against this turn's messages before it
 * is re-applied. Every edit must land on a tool-role message whose string
 * content still has the original byte length the edit was planned against.
 * A failed check means the client rewrote or truncated its history — the edit
 * is dropped rather than applied to the wrong bytes.
 */
export function validatePlan(
	plan: readonly CompactionEdit[],
	messages: readonly NormMessage[],
): CompactionEdit[] {
	const valid: CompactionEdit[] = [];
	for (const e of plan) {
		const m = messages[e.index];
		if (m === undefined || m.role !== "tool") continue;
		if (m.textBytes !== e.bytes) continue;
		valid.push(e);
	}
	return valid;
}

/**
 * First string value in a tool call's argument JSON — a schema-agnostic proxy
 * for the resource a call operates on (a `path`, `id`, `query`, ...). Used to
 * detect when a later call supersedes an earlier read of the same resource.
 */
function primaryArg(argsJson: string): string | null {
	try {
		const parsed: unknown = JSON.parse(argsJson);
		if (parsed !== null && typeof parsed === "object") {
			for (const value of Object.values(parsed)) if (typeof value === "string" && value.length > 0) return value;
		}
	} catch {
		// Malformed args carry no resource key; fall through.
	}
	return null;
}

/**
 * Index of the first message in the PROTECTED region: the last
 * `protectRecentTurns` user/assistant turns and everything after them (the
 * volatile tail). Messages before it are eligible for compaction. Returns 0
 * (protect everything) when the conversation is shorter than the window.
 */
function protectFromIndex(messages: readonly NormMessage[], protectRecentTurns: number): number {
	let turns = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const role = messages[i]?.role;
		if (role === "user" || role === "assistant") {
			turns++;
			if (turns >= protectRecentTurns) return i;
		}
	}
	return 0;
}

interface ToolResult {
	index: number;
	name: string;
	text: string;
	bytes: number;
	/** Primary argument of the originating call, for supersede detection. */
	key: string | null;
}

/**
 * Result for a turn that adds nothing: the carried plan alone, with its
 * savings recomputed against this turn's messages.
 */
function carriedOnly(carried: readonly CompactionEdit[]): CompactionResult {
	const edits = [...carried].sort((a, b) => a.index - b.index);
	const savedBytes = edits.reduce((sum, e) => sum + (e.bytes - compactedBytes(e.bytes, e)), 0);
	return { edits, savedBytes };
}

/**
 * Plans compaction for a turn's messages toward `targetBytes` of total prompt.
 * Duplicate and superseded elisions (pure stale-data wins) are always applied;
 * large-result truncation (more lossy) runs OLDEST-first only until the target
 * is met. `promptBytes` is the whole prompt (messages + system + tool schemas),
 * so the target is compared against the real dispatched size.
 *
 * Oldest-first is a prompt-cache requirement, not a preference. The truncated
 * set is then always an index-ordered PREFIX of the eligible results, so as a
 * conversation grows and the target tightens the set only ever EXTENDS FORWARD:
 * an edit already made keeps the same index and the same keep bytes, and a new
 * edit lands after every previous one. Selecting largest-first instead inserts
 * fresh edits at arbitrarily early indices on later turns, rewriting history
 * the upstream had already cached and collapsing cache reads to the system
 * prefix (measured: 61% cache read, bimodal, vs 76-82% before compaction).
 *
 * `carried` is the plan already applied to this conversation on a previous
 * dispatch (validated by `validatePlan`). It is re-emitted verbatim and its
 * savings count toward the target, so an existing edit is never re-derived
 * differently and the planner only ever ADDS. Re-applying it costs nothing:
 * the client re-sends the original bytes every turn, so the same edit produces
 * the same output.
 */
export function planCompaction(
	messages: readonly NormMessage[],
	cfg: CompactionConfig,
	targetBytes: number,
	promptBytes: number,
	carried: readonly CompactionEdit[] = [],
): CompactionResult {
	if (!cfg.enabled) return EMPTY;

	const protectStart = protectFromIndex(messages, cfg.protectRecentTurns);
	// Carried edits still apply even when nothing new is eligible this turn:
	// dropping them would re-inflate bytes the upstream has already cached.
	if (protectStart <= 0) return carriedOnly(carried);

	// Assistant tool_call id → name/args, to key tool results by their call.
	const callById = new Map<string, { name: string; args: string }>();
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		for (const tc of m.toolCalls) callById.set(tc.id, { name: tc.name, args: tc.argsJson });
	}

	const tools: ToolResult[] = [];
	for (let i = 0; i < protectStart; i++) {
		const m = messages[i];
		if (m === undefined || m.role !== "tool") continue;
		const call = m.toolCallId === undefined ? undefined : callById.get(m.toolCallId);
		tools.push({
			index: i,
			name: m.toolName ?? call?.name ?? "",
			text: m.text,
			bytes: m.textBytes,
			key: call === undefined ? null : primaryArg(call.args),
		});
	}
	if (tools.length === 0) return carriedOnly(carried);

	// Seed with the carried plan: those indices are settled, and their savings
	// already count against the target, so the target math asks "how much MORE
	// is needed" rather than re-deriving the whole plan.
	const edits: CompactionEdit[] = [...carried];
	const done = new Set<number>(carried.map((e) => e.index));
	let saved = carried.reduce((sum, e) => sum + (e.bytes - compactedBytes(e.bytes, e)), 0);
	const stub = (t: ToolResult, note: string): void => {
		if (done.has(t.index)) return;
		const gain = t.bytes - BREADCRUMB_BYTES;
		if (gain <= 0) return; // already smaller than a breadcrumb
		edits.push({ index: t.index, mode: "stub", keepHead: 0, keepTail: 0, note, bytes: t.bytes });
		done.add(t.index);
		saved += gain;
	};

	// Rule 1: collapse byte-identical duplicate results, keeping the LAST copy
	// (consistent with supersede below, so a result that is both never loses
	// every copy).
	if (cfg.collapseDuplicateResults) {
		const lastByContent = new Map<string, number>();
		for (const t of tools) lastByContent.set(`${t.name}\u0000${t.text}`, t.index);
		for (const t of tools) {
			if (lastByContent.get(`${t.name}\u0000${t.text}`) !== t.index) stub(t, `identical repeated ${t.name || "tool"} result`);
		}
	}

	// Rule 2: elide reads superseded by a newer call to the same resource,
	// keeping the LAST (authoritative) one.
	if (cfg.elideSupersededReads) {
		const lastIndexByResource = new Map<string, number>();
		for (const t of tools) if (t.key !== null) lastIndexByResource.set(`${t.name}\u0000${t.key}`, t.index);
		for (const t of tools) {
			if (t.key === null || done.has(t.index)) continue;
			const last = lastIndexByResource.get(`${t.name}\u0000${t.key}`);
			if (last !== undefined && last !== t.index) stub(t, `superseded by a newer ${t.name || "tool"} call`);
		}
	}

	// Rule 3: truncate large stale results, OLDEST first, until under target.
	// `tools` is already in message order, so the filter alone yields that order
	// and the selected set stays an extend-forward prefix across turns.
	const keepBudget = cfg.keepHeadBytes + cfg.keepTailBytes + BREADCRUMB_BYTES;
	const truncatable = tools.filter((t) => !done.has(t.index) && t.bytes > cfg.maxToolResultBytes && t.bytes > keepBudget);
	for (const t of truncatable) {
		if (promptBytes - saved <= targetBytes) break;
		edits.push({ index: t.index, mode: "truncate", keepHead: cfg.keepHeadBytes, keepTail: cfg.keepTailBytes, note: `large ${t.name || "tool"} result`, bytes: t.bytes });
		done.add(t.index);
		saved += t.bytes - keepBudget;
	}

	if (edits.length === 0) return EMPTY;
	edits.sort((a, b) => a.index - b.index);
	return { edits, savedBytes: saved };
}
