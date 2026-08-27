/**
 * Runs the eval suite against models via a text completer, aggregating each
 * model's grades into a raw mean per axis. IO is injected as `Completer` so the
 * runner is unit-testable with a canned model and never touches the network in
 * tests. A completion that throws is folded in as an empty reply (grade 0) — a
 * model that errors on a turn genuinely failed it.
 */

import type { QualityAxis } from "../config/types.ts";
import { EVAL_TASKS, type EvalTask } from "./tasks.ts";

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

function messagesFor(task: EvalTask): ChatMessage[] {
	const msgs: ChatMessage[] = [];
	if (task.system !== undefined) msgs.push({ role: "system", content: task.system });
	msgs.push({ role: "user", content: task.user });
	return msgs;
}

export interface RunEvalArgs {
	slugs: readonly string[];
	complete: Completer;
	tasks?: readonly EvalTask[];
}

export async function runEval(args: RunEvalArgs): Promise<EvalResult[]> {
	const tasks = args.tasks ?? EVAL_TASKS;
	const results: EvalResult[] = [];
	for (const slug of args.slugs) {
		const axes: Record<QualityAxis, AxisScore> = {
			coding: { sum: 0, n: 0 },
			intelligence: { sum: 0, n: 0 },
			agentic: { sum: 0, n: 0 },
		};
		// Tasks for one model run concurrently; models stay sequential to be gentle
		// on the upstream and to keep per-model cost legible.
		// A THROW means the turn never ran (auth gate, 404, network) — that is "no
		// observation", not a score of 0. Folding it in as 0 would poison an
		// anchor whose model is simply unavailable to this key. Only graded output
		// counts toward the axis mean; errors are tallied separately.
		let errors = 0;
		const graded = await Promise.all(
			tasks.map(async (task) => {
				try {
					const text = await args.complete(slug, messagesFor(task));
					return { axis: task.axis, grade: task.grade(text), ok: true as const };
				} catch {
					return { axis: task.axis, grade: 0, ok: false as const };
				}
			}),
		);
		for (const g of graded) {
			if (!g.ok) {
				errors += 1;
				continue;
			}
			axes[g.axis].sum += g.grade;
			axes[g.axis].n += 1;
		}
		results.push({ slug, axes, errors });
	}
	return results;
}
