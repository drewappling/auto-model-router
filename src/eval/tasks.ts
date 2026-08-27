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
import { answerScore, extractJson, jsonField, multiAnswerCoverage, tokenCoverage } from "./grade.ts";

export interface EvalTask {
	id: string;
	axis: QualityAxis;
	system?: string;
	user: string;
	/** Deterministic proxy grade in [0, 1]. */
	grade: (output: string) => number;
}

/** An open-ended task with no deterministic grader; scored 0-1 by an LLM judge. */
export interface JudgedTask {
	id: string;
	axis: QualityAxis;
	system?: string;
	user: string;
	/** Optional strong answer given to the judge as a reference. */
	reference?: string;
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

	// ---- harder / partial-credit: spread models by HOW MANY parts they get right ----
	{
		id: "coding/trace-multi",
		axis: "coding",
		system: JSON_ONLY,
		user: "Give the result of each expression, one per line, in order:\n(1) [1,2,3,4].reduce((a,b)=>a+b,0)\n(2) 'hello'.length\n(3) [5,3,8].sort()[0]\n(4) Object.keys({a:1,b:2}).length\n(5) parseInt('0x1F',16)",
		grade: (o) => multiAnswerCoverage(o, ["10", "5", "3", "2", "31"]),
	},
	{
		id: "coding/float-eq",
		axis: "coding",
		system: JSON_ONLY,
		user: "In JavaScript, what does `0.1 + 0.2 === 0.3` evaluate to? Reply true or false.",
		grade: (o) => answerScore(o, "false"),
	},
	{
		id: "coding/regex-exec",
		axis: "coding",
		system: JSON_ONLY,
		user: "What does `/\\d+/.exec('ab12cd34')[0]` return? Reply with only the value.",
		grade: (o) => answerScore(o, "12"),
	},
	{
		id: "intel/multi-arith",
		axis: "intelligence",
		system: JSON_ONLY,
		user: "Answer each, one per line, in order:\n(1) 17 * 23\n(2) 100 - 37\n(3) 2^10\n(4) the 13th prime number\n(5) GCD(48, 36)",
		grade: (o) => multiAnswerCoverage(o, ["391", "63", "1024", "41", "12"]),
	},
	{
		id: "intel/units",
		axis: "intelligence",
		system: JSON_ONLY,
		user: "How many minutes are in 3.5 hours? Reply with just the number.",
		grade: (o) => answerScore(o, "210"),
	},
	{
		id: "intel/order",
		axis: "intelligence",
		system: JSON_ONLY,
		user: "Tom is older than Jane. Jane is older than Sue. Who is the youngest? Reply with just the name.",
		grade: (o) => answerScore(o, "sue"),
	},
	{
		id: "agentic/arg-synth",
		axis: "agentic",
		system: JSON_ONLY,
		user: 'Tool: search(query, limit). Emit only the JSON call to search for "router config" limited to 5 results: {"tool": <name>, "args": {"query": <q>, "limit": <n>}}.',
		grade: (o) => {
			const j = extractJson(o);
			const args = jsonField(j, "args");
			const q = jsonField(args, "query");
			return jsonField(j, "tool") === "search" && typeof q === "string" && q.toLowerCase().includes("router config") && jsonField(args, "limit") === 5 ? 1 : 0;
		},
	},
	{
		id: "agentic/conditional",
		axis: "agentic",
		system: JSON_ONLY,
		user: 'Tools: read_file(path), create_file(path). If a file "x" exists, read it; otherwise create it. Assume it does NOT exist. Emit only the JSON call {"tool": <name>, "args": {"path": <path>}}.',
		grade: (o) => {
			const j = extractJson(o);
			return jsonField(j, "tool") === "create_file" && jsonField(jsonField(j, "args"), "path") === "x" ? 1 : 0;
		},
	},
	{
		id: "agentic/three-step",
		axis: "agentic",
		system: JSON_ONLY,
		user: 'Tools: list_dir(path), read_file(path), write_file(path, content). Emit only a JSON array of three calls, in order: (1) list "src", (2) read "src/config.ts", (3) write "note.txt" with content "done". Each element is {"tool": <name>, "args": {...}}.',
		grade: (o) => {
			const j = extractJson(o);
			if (!Array.isArray(j)) return 0;
			const want = [
				{ tool: "list_dir", key: "path", val: "src" },
				{ tool: "read_file", key: "path", val: "src/config.ts" },
				{ tool: "write_file", key: "path", val: "note.txt" },
			];
			let hit = 0;
			for (let i = 0; i < want.length; i++) {
				const step = j[i];
				const w = want[i]!;
				if (jsonField(step, "tool") === w.tool && jsonField(jsonField(step, "args"), w.key) === w.val) hit += 1;
			}
			return hit / want.length;
		},
	},
];

/**
 * Open-ended tasks graded by an LLM judge. Deliberately harder and answer-free,
 * so quality (not just pass/fail) varies and the judge can separate models the
 * objective proxies pin at the ceiling.
 */
export const JUDGED_TASKS: readonly JudgedTask[] = [
	{
		id: "coding/debounce",
		axis: "coding",
		user: "Implement `debounce(fn, ms)` in TypeScript that delays calls, so only the last call within a quiet window runs. Preserve `this` and the latest arguments, and type it generically. Explain any edge case you handle.",
	},
	{
		id: "coding/bugfix-explain",
		axis: "coding",
		user: "This function is wrong:\n\nfunction median(xs) {\n  xs.sort();\n  const m = xs.length / 2;\n  return xs[m];\n}\n\nRewrite it correctly for an array of numbers and explain every bug you fixed.",
	},
	{
		id: "intel/concurrency-tradeoff",
		axis: "intelligence",
		user: "Explain the tradeoff between optimistic and pessimistic concurrency control. Give a concrete workload where each is the right choice, and say why.",
	},
	{
		id: "intel/latency-diagnosis",
		axis: "intelligence",
		user: "A web service's p99 latency spiked 10x while p50 stayed flat. List the three most likely causes and, for each, one concrete measurement that would confirm or rule it out.",
	},
	{
		id: "agentic/debug-plan",
		axis: "agentic",
		user: "You must fix a failing test in a repo you have never seen, with tools read_file, search, edit_file, run. Describe the exact sequence of tool actions you would take BEFORE editing anything, and why each step precedes the next.",
	},
	{
		id: "agentic/locate-error",
		axis: "agentic",
		user: "Given only list_dir, read_file, and run, plan the concrete steps to locate the source of a runtime error 'TypeError: undefined is not a function' in an unfamiliar JS project. Be specific about what you run and what you look for at each step.",
	},
];
