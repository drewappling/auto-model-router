/**
 * LLM-judge grading for the open-ended tasks.
 *
 * Objective proxies pin frontier models at the ceiling; open-ended tasks graded
 * by a strong model spread them. The judge is used ONLY to produce raw scores —
 * whether those scores are trustworthy is decided downstream by the SAME
 * calibration guard the objective path uses: if the judge's scores do not track
 * AA on the anchors (Pearson r >= MIN_R, positive slope), no fit is emitted.
 * So "validate the judge against AA" is not a separate step; it is enforced by
 * refusing to ship an uncorrelated calibration.
 *
 * Absolute-rubric scoring (0-10), temperature 0, one judge model. A judge that
 * errors or returns no parseable score yields null — treated as no observation,
 * never a 0.
 */

import type { QualityAxis } from "../config/types.ts";
import type { ChatMessage, Completer } from "./run.ts";
import type { JudgedTask } from "./tasks.ts";

export type Judge = (task: JudgedTask, answer: string) => Promise<number | null>;

const JUDGE_SYSTEM = [
	"You are a strict, impartial grader of an AI assistant's answer to a developer task.",
	"Judge ONLY the quality of the answer for the stated dimension: correctness, completeness,",
	"and whether it followed the instruction. Ignore style and length.",
	"Reply with a SINGLE integer from 0 to 10 and nothing else:",
	"0 = wrong, empty, or ignores the instruction; 5 = partially correct or incomplete;",
	"10 = fully correct, complete, and follows the instruction exactly.",
].join("\n");

const AXIS_LABEL: Record<QualityAxis, string> = {
	coding: "coding / implementation quality",
	intelligence: "reasoning quality",
	agentic: "tool-use / planning quality",
};

function buildPrompt(task: JudgedTask, answer: string): string {
	const ref = task.reference === undefined ? "" : `\n=== A STRONG REFERENCE ANSWER ===\n${task.reference}\n`;
	return `Dimension: ${AXIS_LABEL[task.axis]}\n\n=== TASK ===\n${task.user}\n\n=== ANSWER TO GRADE ===\n${answer}\n${ref}\nScore (0-10):`;
}

/**
 * The 0-1 score in the judge's reply: the LAST standalone integer 0-10, since a
 * model that reasons before answering tends to end on the score. Null when no
 * such integer appears.
 */
export function parseScore(text: string): number | null {
	const matches = [...text.matchAll(/\b(10|[0-9])\b/g)];
	if (matches.length === 0) return null;
	const last = matches[matches.length - 1];
	const n = Number(last?.[1]);
	if (!Number.isFinite(n)) return null;
	return n / 10;
}

export function makeJudge(complete: Completer, judgeSlug: string): Judge {
	return async (task, answer) => {
		const messages: ChatMessage[] = [
			{ role: "system", content: JUDGE_SYSTEM },
			{ role: "user", content: buildPrompt(task, answer) },
		];
		let text: string;
		try {
			text = await complete(judgeSlug, messages);
		} catch {
			return null;
		}
		return parseScore(text);
	};
}
