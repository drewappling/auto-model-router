/**
 * Runs the eval suite against models via a text completer, aggregating each
 * model's grades into a raw mean per axis. IO is injected as `Completer` so the
 * runner is unit-testable with a canned model and never touches the network in
 * tests. A completion that throws is folded in as an empty reply (grade 0) — a
 * model that errors on a turn genuinely failed it.
 */

import type { QualityAxis } from "../config/types.ts";
import type { Judge } from "./judge.ts";
import { EVAL_TASKS, JUDGED_TASKS, type Complexity, type EvalTask, type JudgedTask } from "./tasks.ts";
import { AGENTIC_SCENARIOS, runScenario, type Scenario, type ToolSpec } from "./agentic.ts";
import type { ToolCall } from "../upstream/types.ts";

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export type Completer = (slug: string, messages: ChatMessage[]) => Promise<string>;

export interface AxisScore {
	/** Sum of grades over this axis's tasks. */
	sum: number;
	/** Task count on this axis. */
	n: number;
}

export interface EvalResult {
	slug: string;
	axes: Record<QualityAxis, AxisScore>;
	/** Tasks whose completion threw (dispatch failure). Excluded from `axes`. */
	errors: number;
	/** Passes actually completed. 1 unless `repeats` was given. */
	repeats: number;
	/**
	 * Mean grade per difficulty band. This is where a model's ceiling shows: a suite of one
	 * difficulty reports a single number and cannot say whether a model is strong or the
	 * questions were easy.
	 */
	byComplexity: Partial<Record<Complexity, AxisScore>>;
	/**
	 * Per-axis scores from the HARD band alone. Calibration fits against these: the easy and
	 * moderate bands sit at ~1.0 for every model worth ranking, so including them gives the
	 * regression almost no variation in x against a wide spread in published y — the fitted
	 * slope goes shallow and every target is dragged toward the middle. Measured: a model
	 * published at intelligence 39.5 calibrated to 22.8 across 10 passes.
	 */
	axesHard: Record<QualityAxis, AxisScore>;
	/**
	 * Per-axis spread across passes: max pass mean minus min pass mean, or null under two
	 * passes. A wide spread means the headline is one sample of a noisy quantity, and is the
	 * honest counterpart to reporting a score at all.
	 */
	spread: Partial<Record<QualityAxis, number>>;
}

function messagesFor(task: { system?: string; user: string }): ChatMessage[] {
	const msgs: ChatMessage[] = [];
	if (task.system !== undefined) msgs.push({ role: "system", content: task.system });
	msgs.push({ role: "user", content: task.user });
	return msgs;
}

export interface RunEvalArgs {
	slugs: readonly string[];
	complete: Completer;
	/** Objective, deterministically-graded tasks. Defaults to the built-in suite. */
	tasks?: readonly EvalTask[];
	/** Open-ended tasks scored by `judge`. Ignored unless `judge` is supplied. */
	judged?: readonly JudgedTask[];
	/** LLM judge for the open-ended tasks. Absent ⇒ judged tasks are skipped entirely. */
	judge?: Judge;
	/** How many models to score at once. Default 4; bounded so upstream is not flooded. */
	concurrency?: number;
	/** Called as each model finishes, for progress logging. */
	onProgress?: (result: EvalResult, done: number, total: number) => void;
	/**
	 * Called as each PASS of each model finishes. A run is `models x repeats` passes and takes
	 * the better part of an hour at ten repeats, so per-model progress is too coarse to show
	 * anyone: without this the only observable states are "running" and "finished".
	 */
	onPass?: (slug: string, pass: number, of: number) => void;
	/**
	 * A tool-capable completer. Absent ⇒ the agentic SCENARIOS are skipped and the axis falls
	 * back to the text tasks, which only ever measured whether a model can format JSON.
	 */
	toolComplete?: (slug: string, messages: Record<string, unknown>[], tools: ToolSpec[]) => Promise<{ text: string; toolCalls: ToolCall[] }>;
	/** Agentic tool-loop scenarios. Defaults to the built-in set when `toolComplete` is given. */
	scenarios?: readonly Scenario[];
	/**
	 * How many times to run the whole suite per model, default 1. A single pass cannot tell a
	 * real difference from sampling noise — Artificial Analysis runs 3-5 repeats and spends
	 * >10 to claim a confidence interval. Every attempt is an independent observation, so the
	 * axis mean is over `tasks x repeats` and `spread` reports how much the passes disagreed.
	 */
	repeats?: number;
}

/** One pass of the whole suite. Repeats call this and the observations are pooled. */
async function scorePass(slug: string, args: RunEvalArgs): Promise<EvalResult> {
	const tasks = args.tasks ?? EVAL_TASKS;
	const judge = args.judge;
	const judged = judge !== undefined ? (args.judged ?? JUDGED_TASKS) : [];
	const axes: Record<QualityAxis, AxisScore> = {
		coding: { sum: 0, n: 0 },
		intelligence: { sum: 0, n: 0 },
		agentic: { sum: 0, n: 0 },
	};
	let errors = 0;
	type Outcome = { axis: QualityAxis; grade: number; ok: boolean; complexity: Complexity };
	// A THROW (or an unscorable judge reply) means the turn produced no usable
	// observation — NOT a score of 0, which would poison an anchor whose model is
	// merely unavailable. Such turns are tallied as errors and excluded.
	const objective: Outcome[] = await Promise.all(
		tasks.map(async (task) => {
			try {
				const text = await args.complete(slug, messagesFor(task));
				return { axis: task.axis, grade: task.grade(text), ok: true, complexity: task.complexity ?? "easy" };
			} catch {
				return { axis: task.axis, grade: 0, ok: false, complexity: task.complexity ?? "easy" };
			}
		}),
	);
	const judgedOutcomes: Outcome[] =
		judge === undefined
			? []
			: await Promise.all(
					judged.map(async (task) => {
						try {
							const answer = await args.complete(slug, messagesFor(task));
							const score = await judge(task, answer);
							return score === null ? { axis: task.axis, grade: 0, ok: false, complexity: "hard" } : { axis: task.axis, grade: score, ok: true, complexity: "hard" };
						} catch {
							return { axis: task.axis, grade: 0, ok: false, complexity: "hard" };
						}
					}),
				);
	// Agentic scenarios: a real tool loop, scored on the trajectory as well as the answer.
	// Run sequentially — each is several turns, and firing them all at once is what made a
	// provider's throttle look like a model getting things wrong.
	const scenarioOutcomes: Outcome[] = [];
	if (args.toolComplete !== undefined) {
		const scenarios = args.scenarios ?? AGENTIC_SCENARIOS;
		for (const scenario of scenarios) {
			try {
				const run = await runScenario(scenario, (messages, tools) => args.toolComplete!(slug, messages, tools));
				scenarioOutcomes.push({ axis: "agentic", grade: scenario.grade(run), ok: true, complexity: "moderate" });
			} catch {
				scenarioOutcomes.push({ axis: "agentic", grade: 0, ok: false, complexity: "moderate" });
			}
		}
	}
	const byComplexity: Partial<Record<Complexity, AxisScore>> = {};
	const axesHard: Record<QualityAxis, AxisScore> = { coding: { sum: 0, n: 0 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } };
	for (const o of [...objective, ...judgedOutcomes, ...scenarioOutcomes]) {
		if (!o.ok) {
			// An unobserved task is NOT a zero: a provider's throttle or outage would otherwise
			// be recorded as the model answering wrongly. Artificial Analysis goes further and
			// withholds a result whose failures persisted; we at least never score one.
			errors += 1;
			continue;
		}
		axes[o.axis].sum += o.grade;
		axes[o.axis].n += 1;
		if (o.complexity === "hard") {
			axesHard[o.axis].sum += o.grade;
			axesHard[o.axis].n += 1;
		}
		const band = (byComplexity[o.complexity] ??= { sum: 0, n: 0 });
		band.sum += o.grade;
		band.n += 1;
	}
	return { slug, axes, errors, repeats: 1, spread: {}, byComplexity, axesHard };
}

const AXES: readonly QualityAxis[] = ["coding", "intelligence", "agentic"];

/**
 * A model's score over `repeats` passes. Observations are POOLED rather than averaged over
 * pass means, so a pass that lost tasks to dispatch errors weighs only what it observed.
 * Passes run one after another: they are the same model, and firing them concurrently just
 * trips a provider's throttle and buys errors instead of data.
 */
async function scoreModel(slug: string, args: RunEvalArgs): Promise<EvalResult> {
	const passes = Math.max(1, Math.floor(args.repeats ?? 1));
	const axes: Record<QualityAxis, AxisScore> = { coding: { sum: 0, n: 0 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } };
	const means: Record<QualityAxis, number[]> = { coding: [], intelligence: [], agentic: [] };
	const byComplexity: Partial<Record<Complexity, AxisScore>> = {};
	const axesHard: Record<QualityAxis, AxisScore> = { coding: { sum: 0, n: 0 }, intelligence: { sum: 0, n: 0 }, agentic: { sum: 0, n: 0 } };
	let errors = 0;
	for (let i = 0; i < passes; i++) {
		const pass = await scorePass(slug, args);
		args.onPass?.(slug, i + 1, passes);
		errors += pass.errors;
		for (const axis of AXES) {
			axes[axis].sum += pass.axes[axis].sum;
			axes[axis].n += pass.axes[axis].n;
			axesHard[axis].sum += pass.axesHard[axis].sum;
			axesHard[axis].n += pass.axesHard[axis].n;
			if (pass.axes[axis].n > 0) means[axis].push(pass.axes[axis].sum / pass.axes[axis].n);
		}
		for (const [band, score] of Object.entries(pass.byComplexity) as [Complexity, AxisScore][]) {
			const acc = (byComplexity[band] ??= { sum: 0, n: 0 });
			acc.sum += score.sum;
			acc.n += score.n;
		}
	}
	const spread: Partial<Record<QualityAxis, number>> = {};
	for (const axis of AXES) {
		const m = means[axis];
		if (m.length > 1) spread[axis] = Math.max(...m) - Math.min(...m);
	}
	return { slug, axes, errors, repeats: passes, spread, byComplexity, axesHard };
}

export async function runEval(args: RunEvalArgs): Promise<EvalResult[]> {
	const total = args.slugs.length;
	const concurrency = Math.max(1, args.concurrency ?? 4);
	const results: EvalResult[] = new Array(total);
	let next = 0;
	let done = 0;
	// A fixed pool of workers pulls the next model index until the list is drained,
	// so at most `concurrency` models are in flight at once.
	const worker = async (): Promise<void> => {
		for (;;) {
			const i = next++;
			if (i >= total) return;
			const slug = args.slugs[i]!;
			const r = await scoreModel(slug, args);
			results[i] = r;
			done += 1;
			args.onProgress?.(r, done, total);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
	return results;
}
