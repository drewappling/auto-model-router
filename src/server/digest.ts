/**
 * Tool-result digest: a cheap model condenses a large tool output before it
 * reaches an expensive one.
 *
 * Prompt anatomy showed tool results are the bulk of every prompt, and a
 * prompt is ~96% of spend. A 60KB file read on a hard-tier turn is re-read
 * by that model on every later turn of the conversation, cached or not.
 * When the omp extension sees a large read/grep/glob/bash result while the
 * session's current model sits at or above `digest.fromTier`, it sends the
 * text here; a simple-tier model rewrites it to what the task needs — exact
 * paths, line numbers, names, errors, code that would be edited — and the
 * digest replaces the tool result. The marker on top says how to get the
 * full output back (re-run the tool, or read a line range), so nothing is
 * lost, only deferred.
 *
 * Guarded: never on errors, never below `minBytes`, never above `maxBytes`,
 * never past `maxCostUsd`, and every digest is a ledger row
 * (requestedModel "digest") so the report shows what it cost and saved.
 */

import type { CatalogModel, CatalogSource } from "../catalog/types.ts";
import type { DigestConfig, RouterConfig } from "../config/types.ts";
import { computeCost, forecast } from "../cost/forecast.ts";
import type { AsyncLedger, LedgerEntry } from "../cost/types.ts";
import { buildCandidates } from "../router/candidates.ts";
import { primaryArg } from "../router/compaction.ts";
import { extractFeatures } from "../router/features.ts";
import { TIER_ORDER, type Tier } from "../router/types.ts";
import { estimateTokens } from "../tokens/estimate.ts";
import type { UpstreamClient } from "../upstream/types.ts";
import type { Logger } from "../util/log.ts";
import type { NormRequest } from "../wire/types.ts";

export interface DigestRequest {
	ompSessionId: string;
	harnessId: string;
	toolName: string;
	/** The tool's arguments, echoed into the marker so the model can re-run it. */
	input: Record<string, unknown>;
	content: string;
	/** The user's current ask, so the digest keeps what matters for it. */
	query: string;
	/** The tier to judge `digest.fromTier` against; default: the session's last routed tier. */
	tier?: string;
	/**
	 * Who asked. `tool_result` (default) is the omp extension and is gated on
	 * `digest.enabled`; `compaction` is summarising compaction inside a turn
	 * and is gated on `compaction.digestToolResults` instead.
	 */
	source?: "tool_result" | "compaction";
}

export type DigestResult =
	| { digested: true; text: string; model: string; usd: number; inputBytes: number; outputChars: number; ms: number }
	| { digested: false; reason: string };

export interface DigesterDeps {
	cfg: RouterConfig;
	catalog: CatalogSource;
	ledger: AsyncLedger;
	upstream: UpstreamClient;
	log: Logger;
}

const DIGEST_SYSTEM = `You condense tool output for a coding agent that is mid-task. Keep everything the task could need: exact file paths, line numbers, identifiers, signatures, error text, counts and values. Quote verbatim, with line numbers, any code the agent is likely to edit or reference. Drop repetition, boilerplate, generated noise and unrelated regions. Never invent content. Plain text only, no preamble. First line: one sentence saying what was omitted and roughly how much.`;

const tierIdx = (t: string): number => TIER_ORDER.indexOf(t as Tier);

/** Whether a session's current model is expensive enough for a digest to pay off. */
/** The canonical tool name a harness-specific one maps to (`digest.toolAliases`); lower-cased. */
export function canonicalTool(cfg: Pick<DigestConfig, "toolAliases">, toolName: string): string {
	const lower = toolName.toLowerCase();
	return cfg.toolAliases[lower] ?? lower;
}

export function digestApplies(cfg: DigestConfig, toolName: string, bytes: number, isError: boolean, currentTier: string | null): { ok: true } | { ok: false; reason: string } {
	if (!cfg.enabled) return { ok: false, reason: "digest disabled" };
	if (isError) return { ok: false, reason: "error results are never digested" };
	if (!cfg.tools.includes(canonicalTool(cfg, toolName))) return { ok: false, reason: `tool ${toolName} not in digest.tools` };
	if (bytes < cfg.minBytes) return { ok: false, reason: `${bytes} bytes < minBytes ${cfg.minBytes}` };
	if (bytes > cfg.maxBytes) return { ok: false, reason: `${bytes} bytes > maxBytes ${cfg.maxBytes}` };
	if (currentTier === null) return { ok: false, reason: "no routed turn in this session yet" };
	if (tierIdx(currentTier) < tierIdx(cfg.fromTier)) return { ok: false, reason: `session is on ${currentTier}, below digest.fromTier ${cfg.fromTier}` };
	return { ok: true };
}

/** The line that replaces the raw output's head: what happened and how to undo it. */
export function digestMarker(toolName: string, input: Record<string, unknown>, model: string, inputBytes: number, outputChars: number): string {
	const args = JSON.stringify(input);
	const shownArgs = args.length > 160 ? `${args.slice(0, 159)}…` : args;
	return `[digest: ${toolName} output ${inputBytes.toLocaleString("en-US")} bytes → ${outputChars.toLocaleString("en-US")} chars by ${model}. Full output: re-run ${toolName} ${shownArgs}${toolName === "read" ? " (offset/limit for a range)" : ""}]`;
}

function syntheticRequest(req: DigestRequest, promptText: string): NormRequest {
	const bytes = Buffer.byteLength(promptText);
	return {
		protocol: "openai-chat",
		conversationKey: `digest:${req.ompSessionId}`,
		harnessId: req.harnessId,
		ompSessionId: req.ompSessionId,
		agentdoxScope: "",
		agentdoxGroup: "",
		agentdoxPersonal: "",
		agentdoxOrigin: "",
		isSubagent: true,
		requestedModel: "digest",
		messages: [
			{ role: "system", text: DIGEST_SYSTEM, images: 0, textBytes: Buffer.byteLength(DIGEST_SYSTEM), toolCalls: [] },
			{ role: "user", text: promptText, images: 0, textBytes: bytes, toolCalls: [] },
		],
		tools: [],
		forcedToolChoice: false,
		stream: false,
		hasImages: false,
		promptBytes: bytes + Buffer.byteLength(DIGEST_SYSTEM),
		renderUpstreamBody: () => ({}),
	};
}

/** A digest the agent may still go back on: same tool, same primary argument, within RERUN_WINDOW_MS. */
interface RecentDigest {
	tool: string;
	arg: string | null;
	atMs: number;
	ledgerId: string;
	rerun: boolean;
	/**
	 * Whether the call that PRODUCED this digest has been seen. A tool_result
	 * digest is made before the next request, and that request's last
	 * assistant message carries the producing call; it must not count as a
	 * re-run. A compaction digest covers a call already in history, so its
	 * origin counts as seen from the start.
	 */
	originSeen: boolean;
}
const RERUN_WINDOW_MS = 2 * 3_600_000;
const RECENT_PER_SESSION = 50;

export interface Digester {
	digest(req: DigestRequest): Promise<DigestResult>;
	/**
	 * Quality signal: the tool calls a session just made. One that repeats a
	 * recent digest (same tool, same primary argument) means the agent went
	 * back for the full output; that digest's ledger row is marked wasted and
	 * the report shows the re-run rate. Returns how many were marked.
	 */
	noteToolCalls(ompSessionId: string, calls: readonly { name: string; argsJson: string }[], nowMs?: number): Promise<number>;
}

export function createDigester(deps: DigesterDeps): Digester {
	const { cfg, catalog, ledger, upstream, log } = deps;
	const recent = new Map<string, RecentDigest[]>();

	/** Cheapest simple-tier model that fits the prompt, or the configured one. */
	async function pickModel(req: NormRequest, promptTokens: number): Promise<CatalogModel | null> {
		const snapshot = await catalog.get();
		if (cfg.digest.model !== "") return snapshot.models.find((m) => m.slug === cfg.digest.model) ?? null;
		const features = extractFeatures(req, promptTokens);
		for (const relaxLevel of [0, 1, 2]) {
			const built = buildCandidates({
				req,
				features,
				tier: cfg.digest.tier,
				task: "documentation",
				snapshot,
				cfg,
				expectedCompletionTokens: cfg.digest.maxOutputTokens,
				warmSlug: null,
				relaxLevel,
			});
			const first = built.candidates[0];
			if (first !== undefined) return first.model;
		}
		return null;
	}

	return {
		async digest(req) {
			const inputBytes = Buffer.byteLength(req.content);
			const source = req.source ?? "tool_result";
			const currentTier = req.tier ?? (await ledger.latestForSession(req.ompSessionId))?.tier ?? null;
			const gate = source === "compaction" ? { ...cfg.digest, enabled: cfg.compaction.digestToolResults } : cfg.digest;
			const applies = digestApplies(gate, req.toolName, inputBytes, false, currentTier);
			if (!applies.ok) return { digested: false, reason: applies.reason };

			const promptText = `Task: ${req.query === "" ? "(unknown)" : req.query}\nTool: ${req.toolName} ${JSON.stringify(req.input)}\n--- output ---\n${req.content}`;
			const synthetic = syntheticRequest(req, promptText);
			const promptTokens = estimateTokens(synthetic.promptBytes, "unknown", null);
			const model = await pickModel(synthetic, promptTokens);
			if (model === null) return { digested: false, reason: "no digest model available" };
			const est = forecast(model, { promptTokens, completionTokens: cfg.digest.maxOutputTokens, cacheHitRate: 0, images: 0 });
			if (est.coldUsd > cfg.digest.maxCostUsd) {
				return { digested: false, reason: `estimated $${est.coldUsd.toFixed(4)} on ${model.slug} exceeds digest.maxCostUsd $${cfg.digest.maxCostUsd}` };
			}

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), cfg.digest.timeoutMs);
			const startedAt = Date.now();
			let text = "";
			let costUsd: number | null = null;
			let error: string | null = null;
			try {
				const out = await upstream.complete(
					{
						model: model.slug,
						stream: false,
						max_tokens: cfg.digest.maxOutputTokens,
						temperature: 0,
						messages: [
							{ role: "system", content: DIGEST_SYSTEM },
							{ role: "user", content: promptText },
						],
					},
					controller.signal,
				);
				text = out.text.trim();
				costUsd = out.costUsd;
			} catch (err) {
				error = err instanceof Error ? err.message : String(err);
			} finally {
				clearTimeout(timer);
			}
			const ms = Date.now() - startedAt;
			const completionTokens = estimateTokens(Buffer.byteLength(text), model.tokenizer, null);
			const usage = { promptTokens, cachedTokens: 0, cacheWriteTokens: 0, completionTokens, reasoningTokens: 0, images: 0 };
			const usd = costUsd ?? computeCost(model, usage).total;

			// Every digest is a ledger row: the report shows its cost beside the
			// prompt tokens it kept out of the expensive model.
			const entry: LedgerEntry = {
				id: crypto.randomUUID(),
				createdAtMs: startedAt,
				conversationKey: synthetic.conversationKey,
				sessionId: `digest-${req.ompSessionId}`,
				turn: 1,
				requestedModel: "digest",
				harnessId: req.harnessId,
				ompSessionId: req.ompSessionId,
				slug: model.slug,
				servedSlug: model.slug,
				tier: cfg.digest.tier,
				classificationSource: "forced",
				reasons: [`digest (${source}): ${req.toolName} ${inputBytes} bytes → ${text.length} chars for a ${currentTier} ${source === "compaction" ? "turn" : "session"}`],
				features: null,
				score: null,
				confidence: null,
				task: "documentation",
				classifierReasons: null,
				exploredFrom: null,
				holdArm: null,
				predictedUsd: est.expectedUsd,
				reportedUsd: error === null ? usd : null,
				usage,
				attempt: 0,
				escalationSignal: null,
				latencyMs: ms,
				ttftMs: null,
				finishReason: error === null ? "stop" : null,
				wasted: false,
				upstreamGenerationId: null,
				error,
				promptTokensSaved: 0,
				priceModel: model,
			};
			try {
				await ledger.record(entry);
			} catch (err) {
				log.debug("digest ledger record failed", { error: err instanceof Error ? err.message : String(err) });
			}
			if (error !== null) return { digested: false, reason: `digest model failed: ${error}` };
			if (text === "" || text.length >= inputBytes * 0.9) return { digested: false, reason: "digest did not shrink the output" };
			if (req.ompSessionId !== "") {
				const list = recent.get(req.ompSessionId) ?? [];
				list.push({ tool: req.toolName.toLowerCase(), arg: primaryArg(JSON.stringify(req.input)), atMs: startedAt, ledgerId: entry.id, rerun: false, originSeen: source === "compaction" });
				recent.set(req.ompSessionId, list.slice(-RECENT_PER_SESSION));
			}
			return {
				digested: true,
				text: `${digestMarker(req.toolName, req.input, model.slug, inputBytes, text.length)}\n${text}`,
				model: model.slug,
				usd,
				inputBytes,
				outputChars: text.length,
				ms,
			};
		},
		async noteToolCalls(ompSessionId, calls, nowMs = Date.now()) {
			const list = recent.get(ompSessionId);
			if (list === undefined || list.length === 0) return 0;
			let marked = 0;
			for (const c of calls) {
				const tool = c.name.toLowerCase();
				const arg = primaryArg(c.argsJson);
				if (arg === null) continue;
				for (const d of list) {
					if (d.rerun || d.tool !== tool || d.arg !== arg || nowMs - d.atMs > RERUN_WINDOW_MS) continue;
					if (!d.originSeen) {
						// The producing call, arriving in the next request's history.
						d.originSeen = true;
						continue;
					}
					d.rerun = true;
					marked++;
					try {
						await ledger.markWasted(d.ledgerId);
					} catch (err) {
						log.debug("digest re-run mark failed", { error: err instanceof Error ? err.message : String(err) });
					}
					log.info("digest re-run: the agent fetched the full output after all", { tool, arg: arg.slice(0, 80) });
				}
			}
			const kept = list.filter((d) => nowMs - d.atMs <= RERUN_WINDOW_MS);
			if (kept.length === 0) recent.delete(ompSessionId);
			else recent.set(ompSessionId, kept);
			return marked;
		},
	};
}
