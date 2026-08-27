/**
 * The curated eval suite: small, representative coding-agent turns with fully
 * deterministic graders. Not ledger replay — the ledger stores no prompts — but
 * an on-distribution stand-in: instruction-following, structured output, tool
 * selection, and checkable answers, the things a tier gate actually cares about.
 *
 * Each task is tagged with the quality AXIS it exercises, so a model's raw score
 * on an axis is the mean grade over that axis's tasks. Add tasks freely; the
 * runner and calibration are agnostic to the count.
 */

import type { QualityAxis } from "../config/types.ts";
import { answerScore, extractJson, jsonField, tokenCoverage } from "./grade.ts";

export interface EvalTask {
	id: string;
	axis: QualityAxis;
	system?: string;
	user: string;
	/** Deterministic proxy grade in [0, 1]. */
	grade: (output: string) => number;
}

const JSON_ONLY = "Reply with ONLY the requested content and no prose, code fences, or explanation.";

export const EVAL_TASKS: readonly EvalTask[] = [
	// ---- coding: does it produce correct, well-formed code/answers ----
	{
		id: "coding/sum-fn",
		axis: "coding",
		system: JSON_ONLY,
		user: "Write a TypeScript function `sum(a: number, b: number): number` that returns their sum.",
		grade: (o) => tokenCoverage(o, ["function sum", "a + b"]) === 1 ? 1 : tokenCoverage(o, ["sum", "a + b"]),
	},
	{
		id: "coding/sort-output",
		axis: "coding",
		system: JSON_ONLY,
		user: "What is the result of `[3, 1, 2].sort((a, b) => a - b)`? Reply with only the array.",
		grade: (o) => answerScore(o, "[1, 2, 3]") === 1 ? 1 : answerScore(o, "[1,2,3]"),
	},
	{
		id: "coding/map-double",
		axis: "coding",
		system: JSON_ONLY,
		user: "Complete this to double each element: `const doubled = nums.map(n => ___)`. Reply with only the lambda body that replaces ___.",
		grade: (o) => tokenCoverage(o, ["n", "*", "2"]),
	},
	{
		id: "coding/primes-json",
		axis: "coding",
		system: JSON_ONLY,
		user: "Reply with only a JSON array of the first five prime numbers.",
		grade: (o) => {
			const j = extractJson(o);
			return Array.isArray(j) && JSON.stringify(j) === JSON.stringify([2, 3, 5, 7, 11]) ? 1 : 0;
		},
	},

	// ---- intelligence: reasoning + constraint following ----
	{
		id: "intel/decimal-compare",
		axis: "intelligence",
		system: JSON_ONLY,
		user: "Which is larger, 9.11 or 9.9? Reply with just the number.",
		grade: (o) => answerScore(o, "9.9"),
	},
	{
		id: "intel/syllogism",
		axis: "intelligence",
		system: JSON_ONLY,
		user: "If all Bloops are Razzies and all Razzies are Lazzies, are all Bloops Lazzies? Reply yes or no.",
		grade: (o) => answerScore(o, "yes"),
	},
	{
		id: "intel/arith-json",
		axis: "intelligence",
		system: JSON_ONLY,
		user: 'Reply with only a JSON object {"answer": n} where n = 2 + 2 * 3.',
		grade: (o) => (jsonField(extractJson(o), "answer") === 8 ? 1 : 0),
	},
	{
		id: "intel/bat-ball",
		axis: "intelligence",
		system: JSON_ONLY,
		user: "A bat and a ball cost $1.10 together. The bat costs $1.00 more than the ball. How many cents does the ball cost? Reply with just the number.",
		grade: (o) => answerScore(o, "5"),
	},

	// ---- agentic: tool selection + structured output (as text, since complete() returns text) ----
	{
		id: "agentic/single-tool",
		axis: "agentic",
		system: JSON_ONLY,
		user: 'Tools: read_file(path). To read src/main.ts, emit only the JSON call: {"tool": <name>, "args": {"path": <path>}}.',
		grade: (o) => {
			const j = extractJson(o);
			return jsonField(j, "tool") === "read_file" && jsonField(jsonField(j, "args"), "path") === "src/main.ts" ? 1 : 0;
		},
	},
	{
		id: "agentic/tool-choice",
		axis: "agentic",
		system: JSON_ONLY,
		user: 'Tools: read_file(path), write_file(path, content). To save the text "hello" into out.txt, emit only the JSON call {"tool": <name>, "args": {...}}.',
		grade: (o) => {
			const j = extractJson(o);
			if (jsonField(j, "tool") !== "write_file") return 0;
			const args = jsonField(j, "args");
			const pathOk = jsonField(args, "path") === "out.txt";
			const content = jsonField(args, "content");
			const contentOk = typeof content === "string" && content.includes("hello");
			return pathOk && contentOk ? 1 : 0;
		},
	},
	{
		id: "agentic/tool-sequence",
		axis: "agentic",
		system: JSON_ONLY,
		user: 'Tools: list_dir(path), read_file(path). Emit only a JSON array of the two calls, in order: first list the "src" directory, then read "src/a.ts". Each element is {"tool": <name>, "args": {"path": <path>}}.',
		grade: (o) => {
			const j = extractJson(o);
			if (!Array.isArray(j) || j.length !== 2) return 0;
			const first = jsonField(j[0], "tool") === "list_dir" && jsonField(jsonField(j[0], "args"), "path") === "src";
			const second = jsonField(j[1], "tool") === "read_file" && jsonField(jsonField(j[1], "args"), "path") === "src/a.ts";
			return first && second ? 1 : 0;
		},
	},
	{
		id: "agentic/exact-token",
		axis: "agentic",
		system: JSON_ONLY,
		user: "Reply with EXACTLY the word ACK and nothing else.",
		grade: (o) => answerScore(o, "ack"),
	},
];
