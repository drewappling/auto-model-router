/**
 * Summarising compaction: when the compaction plan gains new edits, a cheap
 * model digests the tool results those edits would otherwise truncate or stub,
 * and the digest rides in the persisted plan in place of the breadcrumb.
 *
 * Plain compaction keeps a head and a tail of a stale tool result; a digest
 * keeps what the task needs from all of it (paths, identifiers, errors, the
 * code the agent will edit) in a few hundred chars. The digest is stored on
 * the edit, so the bytes sent stay identical on every later turn until the
 * plan changes — the same byte-stability plain edits have, which is what keeps
 * the prompt cache warm.
 *
 * Bounded: at most `compaction.digestMaxPerTurn` digests per turn, each under
 * the digest's own cost guard and timeout, largest results first. A digest
 * that fails or declines leaves the plain edit in place; nothing is lost.
 */

import type { RouterConfig } from "../config/types.ts";
import { compactedBytes } from "../router/compaction.ts";
import type { Logger } from "../util/log.ts";
import type { CompactionEdit, NormRequest } from "../wire/types.ts";
import type { DigestRequest, DigestResult } from "./digest.ts";

export interface CompactionDigester {
	digest(req: DigestRequest): Promise<DigestResult>;
	/** See Digester.noteToolCalls; optional so a fake need not implement it. */
	noteToolCalls?(ompSessionId: string, calls: readonly { name: string; argsJson: string }[], nowMs?: number): Promise<number>;
}

export interface DigestCompactionArgs {
	req: NormRequest;
	/** The plan this turn dispatches with; edits gain `digest` in place. */
	plan: CompactionEdit[];
	/** The tier this turn routed to: the digest pays off only above `digest.fromTier`. */
	tier: string;
	cfg: RouterConfig;
	digester: CompactionDigester;
	/** Per-turn memo (index:bytes → digest) so a retry does not pay twice. */
	memo: Map<string, string>;
	/** The user's current ask, steering what the digest keeps. */
	query: string;
	log: Logger;
}

/** Tool name and parsed arguments for a tool-result message, via its call id. */
function toolOf(req: NormRequest, index: number): { name: string; input: Record<string, unknown> } | null {
	const m = req.messages[index];
	if (m === undefined || m.role !== "tool") return null;
	let name = m.toolName ?? "";
	let input: Record<string, unknown> = {};
	if (m.toolCallId !== undefined) {
		for (const a of req.messages) {
			if (a.role !== "assistant") continue;
			const tc = a.toolCalls.find((c) => c.id === m.toolCallId);
			if (tc === undefined) continue;
			if (name === "") name = tc.name;
			try {
				const parsed: unknown = JSON.parse(tc.argsJson);
				if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
			} catch {
				// Unparseable args: the marker just names the tool.
			}
			break;
		}
	}
	return name === "" ? null : { name, input };
}

/**
 * Digests the plan's new (undigested) edits, largest first, up to the per-turn
 * cap. Returns the change in bytes saved versus the plain edits: positive when
 * the digests are smaller than what truncation would have kept, negative when
 * a digest keeps more than head+tail did (it usually does, and that is the point).
 */
export async function digestCompactionEdits(args: DigestCompactionArgs): Promise<number> {
	const { req, plan, tier, cfg, digester, memo, query, log } = args;
	const max = cfg.compaction.digestMaxPerTurn;
	if (max <= 0) return 0;
	const pending = plan.filter((e) => e.digest === undefined).sort((a, b) => b.bytes - a.bytes);
	let delta = 0;
	const work: CompactionEdit[] = [];
	for (const e of pending) {
		const key = `${e.index}:${e.bytes}`;
		const remembered = memo.get(key);
		if (remembered !== undefined) {
			delta += compactedBytes(e.bytes, e) - Buffer.byteLength(remembered);
			e.digest = remembered;
			continue;
		}
		if (work.length >= max) break;
		work.push(e);
	}
	if (work.length === 0) return delta;

	const results = await Promise.all(
		work.map(async (e): Promise<{ edit: CompactionEdit; result: DigestResult }> => {
			const tool = toolOf(req, e.index);
			const m = req.messages[e.index];
			if (tool === null || m === undefined) return { edit: e, result: { digested: false, reason: "tool result has no tool name" } };
			try {
				const result = await digester.digest({
					ompSessionId: req.ompSessionId,
					harnessId: req.harnessId,
					toolName: tool.name,
					input: tool.input,
					content: m.text,
					query,
					tier,
					source: "compaction",
				});
				return { edit: e, result };
			} catch (err) {
				return { edit: e, result: { digested: false, reason: err instanceof Error ? err.message : String(err) } };
			}
		}),
	);
	for (const { edit, result } of results) {
		if (!result.digested) {
			log.debug("compaction digest declined", { index: edit.index, bytes: edit.bytes, reason: result.reason });
			continue;
		}
		const plain = compactedBytes(edit.bytes, edit);
		edit.digest = result.text;
		memo.set(`${edit.index}:${edit.bytes}`, result.text);
		delta += plain - Buffer.byteLength(result.text);
		log.info("compaction digest", { index: edit.index, bytes: edit.bytes, chars: result.outputChars, model: result.model, usd: result.usd });
	}
	return delta;
}
