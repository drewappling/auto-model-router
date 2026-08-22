/**
 * Guarded-probe state machine for mid-stream escalation.
 *
 * While undecided, the probe holds every chunk. It commits (release the
 * buffer to the client) once the generation proves itself — enough text, or
 * complete valid tool-call JSON — and escalates when it observes a configured
 * failure signal. Pure and synchronous: the only impurity is an injectable
 * clock for the hold-time ceiling.
 */

import type { EscalationSignal, ProbePlan, ProbeVerdict } from "./types.ts";
import type { FinishReason, NormRequest, NormToolCall, UpstreamChunk } from "../wire/types.ts";

export interface Probe {
	/** Returns a verdict once decided, null while still buffering. */
	observe(chunk: UpstreamChunk): ProbeVerdict | null;
	/** Stream ended while still undecided; decide from what was held. */
	verdictOnEnd(): ProbeVerdict;
	/** Live view of the buffer; do not mutate. Valid until the next observe(). */
	held(): UpstreamChunk[];
}

// Refusal openers, matched against the start of the held text. Kept
// deliberately tight and anchored: a false positive pays for two generations.
const REFUSAL_OPENERS: readonly RegExp[] = [
	// "I'm sorry, but I can't ..." / "I am sorry I cannot ..."
	/^(?:i'?m|i am) sorry,? (?:but )?i (?:can'?t|cannot|won'?t|will not)/i,
	// "I cannot assist/help/comply/fulfill/provide ..."
	/^i (?:can'?t|cannot) (?:assist|help|comply|fulfill|provide|generate|create)/i,
	// "I'm unable to help ..." / "I'm not able to provide ..."
	/^i'?m (?:not able|unable) to (?:assist|help|comply|fulfill|provide)/i,
	// "I must decline/refuse ..."
	/^i must (?:decline|refuse)/i,
	// "Sorry, I can't ..."
	/^(?:sorry|apologies),? (?:but )?i (?:can'?t|cannot)/i,
];

const INVALID = Symbol("invalid-json");

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return INVALID;
	}
}

// Key-order-insensitive comparison: the same call re-emitted with reordered
// keys is still a loop. Parsed JSON contains no undefined/functions, so plain
// per-node stringification is exact.
function stableStringify(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
	if (v !== null && typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${stableStringify(val)}`).join(",")}}`;
	}
	return JSON.stringify(v);
}

interface ToolCallAcc {
	name: string | null;
	args: string;
	sawArgs: boolean;
}

export function createProbe(
	plan: ProbePlan,
	req: NormRequest,
	triggers: ReadonlySet<string>,
	now: () => number = Date.now,
): Probe {
	const heldChunks: UpstreamChunk[] = [];
	const toolCalls = new Map<number, ToolCallAcc>();
	const startedAt = now();
	let text = "";
	// Cheap 4-chars-per-token approximation. It only gates WHEN we stop holding
	// (latency), never money — the ledger uses reported usage.
	let approxTextTokens = 0;
	let finishReason: FinishReason | null = null;
	// Reasoning deltas prove the model is working even before any content
	// arrives. Used only by the hold-time ceiling, never by the end verdict:
	// a stream that ENDS having emitted only reasoning really is hollow.
	let sawReasoning = false;
	let decided: ProbeVerdict | null = null;

	const commit = (reason: string): ProbeVerdict => (decided = { action: "commit", reason });
	const escalate = (signal: EscalationSignal, reason: string): ProbeVerdict =>
		(decided = { action: "escalate", signal, reason });

	const matchesRefusal = (): boolean => {
		const head = text.trimStart();
		return head !== "" && REFUSAL_OPENERS.some((re) => re.test(head));
	};

	const lastAssistantToolCall = (): NormToolCall | null => {
		for (let i = req.messages.length - 1; i >= 0; i--) {
			const m = req.messages[i];
			if (m && m.role === "assistant" && m.toolCalls.length > 0) {
				return m.toolCalls[m.toolCalls.length - 1] ?? null;
			}
		}
		return null;
	};

	const isRepeat = (name: string | null, argsParsed: unknown): boolean => {
		if (!triggers.has("repeat_tool_call") || name === null) return false;
		const prev = lastAssistantToolCall();
		if (!prev || prev.name !== name) return false;
		const prevParsed = parseJson(prev.argsJson);
		if (prevParsed === INVALID) return false;
		return stableStringify(prevParsed) === stableStringify(argsParsed);
	};

	// End-of-stream evaluation, shared by the finish event and verdictOnEnd.
	const endVerdict = (): ProbeVerdict => {
		if (toolCalls.size > 0) {
			let sawValid = false;
			for (const acc of toolCalls.values()) {
				// Functions without parameters stream no argument fragments;
				// absent arguments mean an empty object, not malformed JSON.
				const parsed = parseJson(acc.args === "" ? "{}" : acc.args);
				if (parsed === INVALID) continue;
				sawValid = true;
				if (isRepeat(acc.name, parsed)) {
					return escalate("repeat_tool_call", `tool call "${acc.name ?? "?"}" repeats the previous assistant call`);
				}
			}
			if (!sawValid) {
				if (triggers.has("malformed_tool_args")) {
					return escalate("malformed_tool_args", "tool-call arguments are not complete valid JSON");
				}
				if (finishReason === "length" && triggers.has("length_stop")) {
					return escalate("length_stop", "hit the length cap mid tool-call arguments");
				}
			}
			return commit(sawValid ? "tool call complete" : "tool call unvalidated; its signals are disabled");
		}

		const hasText = text.trim() !== "";
		if (finishReason === "length") {
			// Truncated with no usable tool call: the agent would act on half an answer.
			if (triggers.has("length_stop")) return escalate("length_stop", "hit the length cap with no tool call");
			return commit("length finish tolerated");
		}
		if (req.forcedToolChoice && req.tools.length > 0 && triggers.has("missing_expected_tool_call")) {
			return escalate("missing_expected_tool_call", "tool choice was forced but the model produced prose");
		}
		if (!hasText) {
			if (triggers.has("empty_completion")) return escalate("empty_completion", "finished with no content");
			return commit("empty completion tolerated; signal disabled");
		}
		if (matchesRefusal() && triggers.has("refusal")) {
			return escalate("refusal", "completion opens with a refusal");
		}
		if (finishReason === "error" && triggers.has("upstream_error")) {
			return escalate("upstream_error", "upstream reported an error finish");
		}
		return commit("completed with content");
	};

	return {
		observe(chunk: UpstreamChunk): ProbeVerdict | null {
			if (decided) return decided;
			heldChunks.push(chunk);
			if (!plan.enabled) return commit("probe disabled");

			for (const ev of chunk.events) {
				switch (ev.type) {
					case "text":
						text += ev.delta;
						approxTextTokens += Math.ceil(ev.delta.length / 4);
						break;
					case "reasoning":
						sawReasoning = true;
						break;
					case "tool_call": {
						let acc = toolCalls.get(ev.index);
						if (!acc) {
							acc = { name: null, args: "", sawArgs: false };
							toolCalls.set(ev.index, acc);
						}
						if (ev.name !== undefined) acc.name = ev.name;
						if (ev.argsDelta !== undefined) {
							acc.args += ev.argsDelta;
							acc.sawArgs = true;
						}
						break;
					}
					case "finish":
						finishReason = ev.reason;
						break;
					default:
						break;
				}
			}

			// Refusal patterns are anchored openers, so they are checkable the
			// moment text starts arriving — do not wait for the finish event.
			if (triggers.has("refusal") && text !== "" && matchesRefusal()) {
				return escalate("refusal", "held text opens with a refusal");
			}
			if (finishReason !== null) return endVerdict();
			if (plan.maxTokens > 0 && approxTextTokens >= plan.maxTokens) {
				return commit(`held ~${approxTextTokens} text tokens, at the probe budget`);
			}
			for (const acc of toolCalls.values()) {
				if (!acc.sawArgs || acc.args === "") continue;
				const parsed = parseJson(acc.args);
				if (parsed === INVALID) continue;
				// A loop repeats too: check identity against the previous call
				// before letting a structurally valid call commit.
				if (isRepeat(acc.name, parsed)) {
					return escalate("repeat_tool_call", `tool call "${acc.name ?? "?"}" repeats the previous assistant call`);
				}
				return commit(`tool call "${acc.name ?? "?"}" arguments are complete valid JSON`);
			}
			if (plan.maxHoldMs > 0 && now() - startedAt >= plan.maxHoldMs) {
				// The ceiling bounds how long we withhold output; the stream is
				// still OPEN here, so "nothing useful yet" means slow, not broken.
				//
				// Committing unconditionally (the original behaviour) blessed a
				// genuinely stalled stream as served. Running the full end-of-stream
				// verdict instead over-corrects the other way: a reasoning model
				// that has emitted only reasoning tokens after 8s is working
				// normally, and escalating throws away a paid, healthy generation
				// to re-run it dearer.
				//
				// So the ceiling escalates only on the absence of ANY sign of life.
				// Real end-of-stream hollowness is still caught by `verdictOnEnd`,
				// where an ended stream that produced only reasoning IS hollow.
				const aliveButSlow = text !== "" || sawReasoning || toolCalls.size > 0;
				if (aliveButSlow) return commit("hold ceiling reached while still generating");
				if (triggers.has("empty_completion")) {
					return escalate("empty_completion", "hold ceiling reached with no output at all");
				}
				return commit("hold ceiling reached; empty-completion signal disabled");
			}
			return null;
		},

		verdictOnEnd(): ProbeVerdict {
			if (decided) return decided;
			if (!plan.enabled) return commit("probe disabled");
			return endVerdict();
		},

		held(): UpstreamChunk[] {
			return heldChunks;
		},
	};
}
