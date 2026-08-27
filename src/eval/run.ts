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
		const graded = await Promise.all(
			tasks.map(async (task) => {
				let text = "";
				try {
					text = await args.complete(slug, messagesFor(task));
				} catch {
					text = "";
				}
				return { axis: task.axis, grade: task.grade(text) };
			}),
		);
		for (const g of graded) {
			axes[g.axis].sum += g.grade;
			axes[g.axis].n += 1;
		}
		results.push({ slug, axes });
	}
	return results;
}
