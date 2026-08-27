/**
 * Runs the eval suite against models via a text completer, aggregating each
 * model's grades into a raw mean per axis. IO is injected as `Completer` so the
 * runner is unit-testable with a canned model and never touches the network in
 * tests. A completion that throws is folded in as an empty reply (grade 0) — a
 * model that errors on a turn genuinely failed it.
 */

import type { QualityAxis } from "../config/types.ts";
import type { Judge } from "./judge.ts";
import { EVAL_TASKS, JUDGED_TASKS, type EvalTask, type JudgedTask } from "./tasks.ts";

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
}

async function scoreModel(slug: string, args: RunEvalArgs): Promise<EvalResult> {
	const tasks = args.tasks ?? EVAL_TASKS;
	const judge = args.judge;
	const judged = judge !== undefined ? (args.judged ?? JUDGED_TASKS) : [];
	const axes: Record<QualityAxis, AxisScore> = {
		coding: { sum: 0, n: 0 },
		intelligence: { sum: 0, n: 0 },
		agentic: { sum: 0, n: 0 },
	};
	let errors = 0;
	type Outcome = { axis: QualityAxis; grade: number; ok: boolean };
	// A THROW (or an unscorable judge reply) means the turn produced no usable
	// observation — NOT a score of 0, which would poison an anchor whose model is
	// merely unavailable. Such turns are tallied as errors and excluded.
	const objective: Outcome[] = await Promise.all(
		tasks.map(async (task) => {
			try {
				const text = await args.complete(slug, messagesFor(task));
				return { axis: task.axis, grade: task.grade(text), ok: true };
			} catch {
				return { axis: task.axis, grade: 0, ok: false };
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
							return score === null ? { axis: task.axis, grade: 0, ok: false } : { axis: task.axis, grade: score, ok: true };
						} catch {
							return { axis: task.axis, grade: 0, ok: false };
						}
					}),
				);
	for (const o of [...objective, ...judgedOutcomes]) {
		if (!o.ok) {
			errors += 1;
			continue;
		}
		axes[o.axis].sum += o.grade;
		axes[o.axis].n += 1;
	}
	return { slug, axes, errors };
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
