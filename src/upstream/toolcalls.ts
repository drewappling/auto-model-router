/**
 * Normalising the tool calls a non-streaming completion came back with.
 *
 * Two provider shapes reach us: the OpenAI one (`message.tool_calls[].function`
 * with a JSON STRING of arguments) and Anthropic's (`content[]` blocks of type
 * `tool_use` with an already-parsed `input` object). The eval harness drives a
 * real tool loop, so it needs the calls themselves rather than prose about them.
 *
 * Malformed arguments are reported, never discarded: a model that emits invalid
 * JSON for a tool it was handed has failed a capability, and that is a result.
 */

import type { ToolCall } from "./types.ts";

function asRecord(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** OpenAI shape: `choices[0].message.tool_calls`. */
export function openaiToolCalls(message: Record<string, unknown> | null): ToolCall[] {
	const raw = message === null ? null : message.tool_calls;
	if (!Array.isArray(raw)) return [];
	const out: ToolCall[] = [];
	for (const [i, callRaw] of raw.entries()) {
		const call = asRecord(callRaw);
		const fn = call === null ? null : asRecord(call.function);
		const name = fn !== null && typeof fn.name === "string" ? fn.name : "";
		if (name === "") continue;
		const argsText = fn !== null && typeof fn.arguments === "string" ? fn.arguments : "";
		let args: Record<string, unknown> = {};
		let malformed = false;
		if (argsText.trim() !== "") {
			try {
				args = asRecord(JSON.parse(argsText)) ?? {};
			} catch {
				malformed = true;
			}
		}
		out.push({ id: typeof call?.id === "string" ? call.id : `call_${i}`, name, args, malformed });
	}
	return out;
}

/** Anthropic shape: `content[]` blocks of type `tool_use`, whose `input` is already an object. */
export function anthropicToolCalls(body: Record<string, unknown> | null): ToolCall[] {
	const raw = body === null ? null : body.content;
	if (!Array.isArray(raw)) return [];
	const out: ToolCall[] = [];
	for (const [i, blockRaw] of raw.entries()) {
		const block = asRecord(blockRaw);
		if (block === null || block.type !== "tool_use" || typeof block.name !== "string") continue;
		out.push({ id: typeof block.id === "string" ? block.id : `call_${i}`, name: block.name, args: asRecord(block.input) ?? {}, malformed: false });
	}
	return out;
}
