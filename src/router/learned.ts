/**
 * A learned escalation-risk model over the recorded classifier features.
 *
 * The heuristic classifier's weights are hand-set. The ledger holds, for
 * every served turn, the exact feature vector the classifier saw and whether
 * the turn escalated (a cheaper attempt was probe-rejected). That is a
 * labelled dataset — ~13k rows, ~1% positive — and this module is the
 * smallest honest learner for it: standardised features, L2-regularised
 * logistic regression by full-batch gradient descent, evaluated by AUC on a
 * time-ordered holdout so the future is never trained on.
 *
 * Advisory by design. `tools/train-classifier.ts` fits and writes a model
 * file; with `classifier.learnedModelPath` set, `classify()` scores each
 * turn and records `learned: p(escalate)=…` in the decision trail so the
 * signal can be judged against outcomes (and replayed) before it is ever
 * allowed to move a tier.
 */

import type { Features } from "./types.ts";

export const LEARNED_MODEL_VERSION = 1;

/** Feature names in vector order. Adding one is a model-version change. */
export const FEATURE_NAMES: readonly string[] = [
	"log_prompt_tokens",
	"log_new_content_tokens",
	"turn_depth",
	"tool_count",
	"log_tool_schema_bytes",
	"is_tool_result_continuation",
	"tool_loop_depth",
	"distinct_tools_used",
	"last_tool_failed",
	"repeated_tool_call",
	"circular_tool_call",
	"has_images",
	"has_new_image",
	"code_blocks",
	"log_code_bytes",
	"looks_like_diff",
	"complexity_keywords",
	"triviality_keywords",
	"requested_reasoning",
	"question_count",
	"is_terse_instruction",
];

const REASONING_ORDINAL: Record<string, number> = { off: 0, minimal: 0.5, low: 1, medium: 2, high: 3, xhigh: 4, max: 5 };

const log1p = (v: number): number => Math.log1p(Math.max(0, v));
const b = (v: boolean | undefined): number => (v === true ? 1 : 0);

/** The numeric vector for one turn, in FEATURE_NAMES order. Tolerates old rows missing fields. */
export function learnedVector(f: Partial<Features>): number[] {
	return [
		log1p(f.promptTokens ?? 0),
		log1p(f.newContentTokens ?? 0),
		f.turnDepth ?? 0,
		f.toolCount ?? 0,
		log1p(f.toolSchemaBytes ?? 0),
		b(f.isToolResultContinuation),
		f.toolLoopDepth ?? 0,
		f.distinctToolsUsed ?? 0,
		b(f.lastToolFailed),
		b(f.repeatedToolCall),
		b(f.circularToolCall),
		b(f.hasImages),
		b(f.hasNewImage),
		f.codeBlocks ?? 0,
		log1p(f.codeBytes ?? 0),
		b(f.looksLikeDiff),
		Array.isArray(f.complexityKeywords) ? f.complexityKeywords.length : 0,
		Array.isArray(f.trivialityKeywords) ? f.trivialityKeywords.length : 0,
		REASONING_ORDINAL[f.requestedReasoning ?? "off"] ?? 0,
		f.questionCount ?? 0,
		b(f.isTerseInstruction),
	];
}

export interface LearnedModel {
	version: number;
	trainedAtMs: number;
	rows: number;
	positives: number;
	names: string[];
	means: number[];
	stds: number[];
	weights: number[];
	bias: number;
	/** Holdout AUC at training time, for the record. */
	auc: number;
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** P(escalate) for one turn under a model. */
export function predictRisk(model: LearnedModel, f: Partial<Features>): number {
	const x = learnedVector(f);
	let z = model.bias;
	for (let i = 0; i < model.weights.length && i < x.length; i++) {
		const std = model.stds[i] ?? 1;
		z += (model.weights[i] ?? 0) * (((x[i] ?? 0) - (model.means[i] ?? 0)) / (std > 0 ? std : 1));
	}
	return sigmoid(z);
}

export interface TrainOptions {
	epochs?: number;
	learningRate?: number;
	/** L2 strength on the weights (not the bias). */
	l2?: number;
	/** Weight on positive examples, to counter the ~1% base rate. Default: negatives/positives. */
	positiveWeight?: number;
}

/** Fits weights on already-vectorised rows. Pure, deterministic. */
export function trainLogistic(xs: number[][], ys: number[], opts: TrainOptions = {}): { weights: number[]; bias: number; means: number[]; stds: number[] } {
	const n = xs.length;
	const d = xs[0]?.length ?? 0;
	if (n === 0 || d === 0) throw new Error("no training rows");
	const means = new Array<number>(d).fill(0);
	const stds = new Array<number>(d).fill(0);
	for (const x of xs) for (let j = 0; j < d; j++) means[j]! += (x[j] ?? 0) / n;
	for (const x of xs) for (let j = 0; j < d; j++) stds[j]! += ((x[j] ?? 0) - means[j]!) ** 2 / n;
	for (let j = 0; j < d; j++) stds[j] = Math.sqrt(stds[j]!) || 1;
	const z = xs.map((x) => x.map((v, j) => (v - means[j]!) / stds[j]!));

	const positives = ys.reduce((s, y) => s + y, 0);
	const posWeight = opts.positiveWeight ?? (positives > 0 ? (n - positives) / positives : 1);
	const epochs = opts.epochs ?? 400;
	const lr = opts.learningRate ?? 0.1;
	const l2 = opts.l2 ?? 0.01;
	const w = new Array<number>(d).fill(0);
	let bias = 0;
	for (let e = 0; e < epochs; e++) {
		const gw = new Array<number>(d).fill(0);
		let gb = 0;
		let totalWeight = 0;
		for (let i = 0; i < n; i++) {
			const row = z[i]!;
			let s = bias;
			for (let j = 0; j < d; j++) s += w[j]! * row[j]!;
			const y = ys[i]!;
			const sw = y === 1 ? posWeight : 1;
			const err = (sigmoid(s) - y) * sw;
			for (let j = 0; j < d; j++) gw[j]! += err * row[j]!;
			gb += err;
			totalWeight += sw;
		}
		for (let j = 0; j < d; j++) w[j] = w[j]! - lr * (gw[j]! / totalWeight + l2 * w[j]!);
		bias -= lr * (gb / totalWeight);
	}
	return { weights: w, bias, means, stds };
}

/** Area under the ROC curve by rank (Mann-Whitney), ties counted half. */
export function auc(scores: number[], labels: number[]): number {
	const pos: number[] = [];
	const neg: number[] = [];
	scores.forEach((s, i) => (labels[i] === 1 ? pos : neg).push(s));
	if (pos.length === 0 || neg.length === 0) return 0.5;
	const sortedNeg = [...neg].sort((a, b) => a - b);
	let sum = 0;
	for (const p of pos) {
		// count negatives below p, plus half of ties
		let lo = 0;
		let hi = sortedNeg.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sortedNeg[mid]! < p) lo = mid + 1;
			else hi = mid;
		}
		let ties = 0;
		for (let k = lo; k < sortedNeg.length && sortedNeg[k] === p; k++) ties++;
		sum += lo + ties / 2;
	}
	return sum / (pos.length * neg.length);
}

/** Loads a model file once per path; null when absent or unreadable. */
const modelCache = new Map<string, LearnedModel | null>();
export async function loadLearnedModel(path: string): Promise<LearnedModel | null> {
	if (path === "") return null;
	const cached = modelCache.get(path);
	if (cached !== undefined) return cached;
	let model: LearnedModel | null = null;
	try {
		const parsed = (await Bun.file(path).json()) as Partial<LearnedModel>;
		if (parsed.version === LEARNED_MODEL_VERSION && Array.isArray(parsed.weights) && Array.isArray(parsed.means) && Array.isArray(parsed.stds)) {
			model = parsed as LearnedModel;
		}
	} catch {
		model = null;
	}
	modelCache.set(path, model);
	return model;
}

/** Test seam: forget loaded models. */
export function resetLearnedModels(): void {
	modelCache.clear();
}
