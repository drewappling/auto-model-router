/**
 * Complexity classification: a weighted heuristic over Features, with an
 * optional LLM adjudicator for turns the heuristic cannot call confidently.
 */

import type { CatalogSource } from "../catalog/types.ts";
import type { QualityAxis, RouterConfig } from "../config/types.ts";
import { forecast } from "../cost/forecast.ts";
import type { Ledger } from "../cost/types.ts";
import { estimateTokens } from "../tokens/estimate.ts";
import type { UpstreamClient } from "../upstream/types.ts";
import { sha256Hex } from "../util/hash.ts";
import type { NormRequest, ReasoningLevel } from "../wire/types.ts";
import type { Classification, Features, TaskType, Tier } from "./types.ts";

/**
 * Heuristic scorer: a weighted linear sum over Features, clamped to 0-1 and
 * bucketed into tiers. The weights encode two economic facts:
 *
 *  - A tool-result continuation is the cheapest kind of turn in agent traffic
 *    (read tool output, take the next mechanical step) and the largest cost
 *    lever, so it carries the dominant NEGATIVE weight.
 *  - Failure signals cost money twice: a cheap model that flounders gets
 *    escalated and the turn is paid for twice. So a failed tool result, a
 *    repeated tool call, complexity keywords, and an explicit reasoning
 *    request carry the dominant POSITIVE weights.
 */
const BASE = 0.3;
const W_TOOL_CONTINUATION = -0.28; // dominant negative
const W_COMPLEXITY_KEYWORD = 0.1;
const CAP_COMPLEXITY = 0.3;
const W_TRIVIALITY_KEYWORD = -0.09;
const CAP_TRIVIALITY = -0.27;
const W_TOOL_FAILED = 0.26; // dominant positive: retry loops are expensive
const W_CIRCULAR_LOOP = 0.24; // a re-issued (circular) tool call: the model is stuck
const W_TERSE = -0.1;
const W_CODE_BLOCK = 0.04;
const CAP_CODE = 0.08;
const W_DIFF = 0.05;
const W_QUESTION = 0.03;
const CAP_QUESTION = 0.06;
const W_LARGE_CONTENT = 0.05;
const W_HUGE_CONTENT = 0.1;
const W_TURN_DEPTH = 0.004; // long conversations accumulate entangled context
const CAP_TURN_DEPTH = 0.08;
const W_LOOP_DEPTH = -0.008; // a single deep step is mechanical
const CAP_LOOP_DEPTH = -0.06;
// A sustained autonomous loop is the signal the underlying task is substantial:
// the agent keeps grinding without human input. Unlike the mechanical-step
// penalty above, this term ACCUMULATES with depth past the agentic threshold so
// long loops climb out of trivial. The ramp slope is calibrated on recorded
// coding turns; the cap governs the ceiling.
//
// The cap was briefly 0.70, which let pure depth reach `hard`. That was aimed at
// a real problem — a distinct-read loop grinding at depth 27+ on
// deepseek-v4-flash (coding 69.1), which clears the moderate floor, so escalating
// to moderate swapped nothing. But it overcorrected: on live data 152 of 155
// `hard` dispatches were depth-driven and carried 63.5% of ALL spend, and those
// same rows also carry the `-0.28 tool-result continuation (mechanical)` term —
// the classifier already knew the work was mechanical and the depth bonus
// overrode it. `hard` (floor 72, no price ceiling) forces gemini-3.7-flash at
// roughly 8x the cost of the model moderate picks.
//
// The original grinding failure is now covered independently: windowed latency
// scoring inflates a chronically slow model's effective cost, and it removed
// deepseek-v4-flash from selection entirely. So depth alone tops out at
// `moderate` again, and `hard` stays reachable via a CORROBORATING stuck signal
// (circular call, tool failure, keywords) — which is what should buy a $2/Mtok
// model, not depth by itself.
const W_AUTONOMOUS_LOOP = 0.06; // base bonus at the threshold
const W_AUTONOMOUS_LOOP_PER_DEPTH = 0.018; // added per loop step beyond the threshold
const CAP_AUTONOMOUS_LOOP = 0.45; // pure depth ramps into moderate, never alone into hard
const W_IMAGES = 0.04;
const W_TOOLS_OFFERED = 0.03;

/** Score bucket boundaries: [trivial, simple, moderate, hard]. */
const BOUNDARIES: readonly [number, number, number] = [0.25, 0.5, 0.75];

/**
 * Score for a client-stated reasoning effort. The premise is that asking for
 * reasoning states expected difficulty — true when a harness raises the level
 * for a hard turn, false when it pins one level for the whole session, where the
 * "signal" is a constant that lifts every turn's score. Weights are therefore
 * configurable per deployment; see ClassifierConfig.reasoningWeights.
 */
function reasoningWeight(level: ReasoningLevel | undefined, cfg: RouterConfig): number {
	const w = cfg.classifier.reasoningWeights;
	switch (level) {
		case "medium":
			return w.medium;
		case "high":
			return w.high;
		case "xhigh":
			return w.xhigh;
		case "max":
			return w.max;
		default:
			// off/minimal/low/undefined: no stated difficulty above the baseline.
			return 0;
	}
}

export function scoreHeuristic(f: Features, cfg: RouterConfig): Classification {
	const reasons: string[] = [];
	let score = BASE;
	const add = (delta: number, why: string): void => {
		if (delta === 0) return;
		score += delta;
		reasons.push(`${delta > 0 ? "+" : ""}${delta.toFixed(2)} ${why}`);
	};

	if (f.isToolResultContinuation) add(W_TOOL_CONTINUATION, "tool-result continuation (mechanical next step)");
	add(
		Math.min(f.complexityKeywords.length * W_COMPLEXITY_KEYWORD, CAP_COMPLEXITY),
		`complexity keywords [${f.complexityKeywords.join(", ")}]`,
	);
	add(
		Math.max(f.trivialityKeywords.length * W_TRIVIALITY_KEYWORD, CAP_TRIVIALITY),
		`triviality keywords [${f.trivialityKeywords.join(", ")}]`,
	);
	if (f.lastToolFailed) add(W_TOOL_FAILED, "last tool result failed");
	if (f.circularToolCall) add(W_CIRCULAR_LOOP, "circular tool call (re-issued a prior call; stuck)");
	const rw = reasoningWeight(f.requestedReasoning, cfg);
	if (rw > 0) add(rw, `client requested reasoning=${f.requestedReasoning ?? ""}`);
	if (f.isTerseInstruction) add(W_TERSE, "terse instruction");
	add(Math.min(f.codeBlocks * W_CODE_BLOCK, CAP_CODE), `${f.codeBlocks} code block(s) in new content`);
	if (f.looksLikeDiff) add(W_DIFF, "diff in new content");
	add(Math.min(f.questionCount * W_QUESTION, CAP_QUESTION), `${f.questionCount} question(s)`);
	if (f.newContentTokens > 8000) add(W_HUGE_CONTENT, "very large new content");
	else if (f.newContentTokens > 2000) add(W_LARGE_CONTENT, "large new content");
	add(Math.min(f.turnDepth * W_TURN_DEPTH, CAP_TURN_DEPTH), `conversation depth ${f.turnDepth}`);
	add(Math.max(f.toolLoopDepth * W_LOOP_DEPTH, CAP_LOOP_DEPTH), `tool loop depth ${f.toolLoopDepth}`);
	if (f.toolLoopDepth >= cfg.classifier.agenticLoopDepth && f.toolLoopDepth > 0) {
		const excessDepth = f.toolLoopDepth - cfg.classifier.agenticLoopDepth;
		add(
			Math.min(W_AUTONOMOUS_LOOP + excessDepth * W_AUTONOMOUS_LOOP_PER_DEPTH, CAP_AUTONOMOUS_LOOP),
			`autonomous loop depth ${f.toolLoopDepth} (sustained task)`,
		);
	}
	if (f.hasImages) add(W_IMAGES, "image input");
	if (f.toolCount > 0) add(W_TOOLS_OFFERED, `${f.toolCount} tools offered`);

	score = Math.min(1, Math.max(0, score));
	const tier: Tier = score < BOUNDARIES[0] ? "trivial" : score < BOUNDARIES[1] ? "simple" : score < BOUNDARIES[2] ? "moderate" : "hard";

	// Near a bucket boundary the heuristic is guessing; confidence is the
	// distance to the nearest boundary, scaled so half a bucket of clearance
	// reads as fully confident. Low confidence ⇒ eligible for LLM adjudication.
	let dist = 1;
	for (const b of BOUNDARIES) dist = Math.min(dist, Math.abs(score - b));
	const confidence = Math.min(1, dist / 0.125);

	return { tier, task: classifyTask(f), confidence, source: "heuristic", reasons, score };
}

/** Quality axis rule: deep loops → agentic; tools offered → toolAxis; chat → chatAxis. */
export function pickQualityAxis(f: Features, cfg: RouterConfig): QualityAxis {
	if (f.toolLoopDepth >= cfg.classifier.agenticLoopDepth) return "agentic";
	if (f.toolCount > 0) return cfg.classifier.toolAxis;
	return cfg.classifier.chatAxis;
}

/**
 * Task-type classification: the KIND of work, orthogonal to complexity tier.
 * Cheap and deterministic — no tokenizer, no model call. A freshly supplied
 * image is the only hard signal (vision); the rest are keyword/structural
 * heuristics over the newest user content. The task selects the quality axis
 * and capability filters; the tier still bounds cost.
 */
export function classifyTask(f: Features): TaskType {
	// Vision is the KIND of work only when the human just supplied an image. A
	// stale screenshot lingering in a long agent loop must not pin every
	// mechanical tool-continuation to the vision (intelligence) axis, which
	// systematically underscores cheap coding models and, at the moderate/hard
	// floors, excludes them entirely in favour of frontier models. Capability
	// (the payload still carries the image) is enforced separately via
	// req.hasImages in buildCandidates, independent of the task axis.
	if (f.hasNewImage) return "vision";
	// Coding: code blocks, diffs, a tool loop, or tools offered — agent tool use
	// is coding work. Bare chat (no tools, no code) falls through.
	if (f.codeBlocks > 0 || f.looksLikeDiff || f.toolLoopDepth > 0 || f.toolCount > 0) return "coding";
	// Data: tabular/structured analysis language.
	if (f.complexityKeywords.some((k) => k === "optimize" || k === "migrate")) return "data";
	// Documentation: prose-heavy, explanatory language, no code.
	if (f.complexityKeywords.some((k) => k === "design" || k === "architecture")) return "documentation";
	return "chat";
}

export interface ClassifyDeps {
	upstream: UpstreamClient;
	ledger: Ledger | null;
	catalog: CatalogSource | null;
}

const ADJUDICATOR_SYSTEM = [
	"You classify one turn of a coding-agent conversation into a complexity tier.",
	"trivial: mechanical step, rename, typo, formatting, reading a successful tool result.",
	"simple: small localized change, single-file edit, straightforward question.",
	"moderate: multi-file change, debugging, non-obvious design decision.",
	"hard: architecture, subtle concurrency or correctness bug, security, large refactor.",
	"Reply with exactly one word: trivial, simple, moderate, or hard.",
].join("\n");

// The adjudicator answers with one token; a small completion budget is plenty.
const ADJUDICATOR_COMPLETION_TOKENS = 4;
// Rough completion size of the turn being classified, for the cost-fraction guard.
const EST_TURN_COMPLETION_TOKENS = 1024;
// Hard cap on the user-content excerpt sent to the adjudicator.
const DIGEST_EXCERPT_CHARS = 400;

/**
 * Verdict caches are keyed by the config object so separate routers (and
 * separate tests) never share verdicts. Bounded LRU per config.
 */
const verdictCaches = new WeakMap<RouterConfig, Map<string, Tier>>();

function verdictCache(cfg: RouterConfig): Map<string, Tier> {
	let cache = verdictCaches.get(cfg);
	if (cache === undefined) {
		cache = new Map();
		verdictCaches.set(cfg, cache);
	}
	return cache;
}

function lruGet(cache: Map<string, Tier>, key: string): Tier | undefined {
	const hit = cache.get(key);
	if (hit !== undefined) {
		// Refresh recency: Map preserves insertion order.
		cache.delete(key);
		cache.set(key, hit);
	}
	return hit;
}

function lruSet(cache: Map<string, Tier>, key: string, value: Tier, maxSize: number): void {
	cache.delete(key);
	cache.set(key, value);
	while (cache.size > maxSize) {
		const oldest = cache.keys().next();
		if (oldest.done) break;
		cache.delete(oldest.value);
	}
}

/**
 * Compact digest of the request for the adjudicator. Never the whole
 * conversation: shipping full history to the judge would cost more than the
 * turn it is classifying.
 */
function buildDigest(req: NormRequest, f: Features): string {
	const toolNames = req.tools.length === 0 ? "none" : req.tools.map((t) => t.name).slice(0, 24).join(", ");
	let excerpt = "(no user content yet)";
	for (let i = req.messages.length - 1; i >= 0; i--) {
		const m = req.messages[i];
		if (m?.role === "user") {
			excerpt = m.text.length > DIGEST_EXCERPT_CHARS ? `${m.text.slice(0, DIGEST_EXCERPT_CHARS)}...` : m.text;
			break;
		}
	}
	return [
		`tools_offered: ${toolNames}`,
		`tool_result_continuation: ${f.isToolResultContinuation}`,
		`tool_loop_depth: ${f.toolLoopDepth}`,
		`last_tool_failed: ${f.lastToolFailed}`,
		`prompt_tokens_estimate: ${f.promptTokens}`,
		`newest_user_content: """${excerpt}"""`,
	].join("\n");
}

export async function classify(
	req: NormRequest,
	f: Features,
	cfg: RouterConfig,
	deps: ClassifyDeps,
): Promise<Classification> {
	const heuristic = scoreHeuristic(f, cfg);
	const cc = cfg.classifier;
	if (cc.ambiguityThreshold <= 0 || heuristic.confidence >= cc.ambiguityThreshold) return heuristic;

	const digest = buildDigest(req, f);
	const cache = verdictCache(cfg);
	const fingerprint = sha256Hex(digest);
	const cached = lruGet(cache, fingerprint);
	if (cached !== undefined) {
		return {
			tier: cached,
			task: heuristic.task,
			confidence: 0.9,
			source: "llm",
			score: heuristic.score,
			reasons: [...heuristic.reasons, `adjudicator: ${cached} (cached verdict)`],
		};
	}

	// Cost guard: adjudication must be cheap relative to the turn it classifies.
	const blend = deps.ledger?.blendedRate(cfg.ledger.blendWindowDays) ?? null;
	const inputRate = (blend?.inputPerMtok ?? cfg.ledger.fallbackBlend.inputPerMtok) / 1e6;
	const outputRate = (blend?.outputPerMtok ?? cfg.ledger.fallbackBlend.outputPerMtok) / 1e6;
	const judge = deps.catalog?.find(cc.model);
	const digestTokens = estimateTokens(Buffer.byteLength(ADJUDICATOR_SYSTEM) + Buffer.byteLength(digest), "unknown", deps.ledger);
	const adjudicatorUsd =
		judge !== undefined
			? forecast(judge, {
					promptTokens: digestTokens,
					completionTokens: ADJUDICATOR_COMPLETION_TOKENS,
					cacheHitRate: 0,
					images: 0,
				}).expectedUsd
			: // Judge slug missing from the catalog: price it at the blend so the guard still bites.
				digestTokens * inputRate + ADJUDICATOR_COMPLETION_TOKENS * outputRate;
	const pendingTurnUsd = f.promptTokens * inputRate + EST_TURN_COMPLETION_TOKENS * outputRate;
	if (adjudicatorUsd > cc.maxCostUsd || adjudicatorUsd > pendingTurnUsd * cc.maxCostFraction) {
		return {
			...heuristic,
			reasons: [...heuristic.reasons, `adjudicator skipped: est $${adjudicatorUsd.toFixed(6)} breaches cost guard`],
		};
	}

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		// Reject even if the upstream implementation ignores the abort signal.
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(`timed out after ${cc.timeoutMs}ms`));
		}, cc.timeoutMs);
	});
	try {
		const { text } = await Promise.race([
			deps.upstream.complete(
				{
					model: cc.model,
					stream: false,
					max_tokens: ADJUDICATOR_COMPLETION_TOKENS,
					temperature: 0,
					messages: [
						{ role: "system", content: ADJUDICATOR_SYSTEM },
						{ role: "user", content: digest },
					],
				},
				controller.signal,
			),
			timeout,
		]);
		const word = text.trim().toLowerCase();
		if (word === "trivial" || word === "simple" || word === "moderate" || word === "hard") {
			lruSet(cache, fingerprint, word, cc.cacheSize);
			return {
				tier: word,
				task: heuristic.task,
				confidence: 0.9,
				source: "llm",
				score: heuristic.score,
				reasons: [...heuristic.reasons, `adjudicator: ${word}`],
			};
		}
		return {
			...heuristic,
			reasons: [...heuristic.reasons, `adjudicator reply not a tier word; kept heuristic ${heuristic.tier}`],
		};
	} catch (err) {
		const why = err instanceof Error ? err.message : String(err);
		return {
			...heuristic,
			reasons: [...heuristic.reasons, `adjudicator failed (${why}); kept heuristic ${heuristic.tier}`],
		};
	} finally {
		clearTimeout(timer);
	}
}
