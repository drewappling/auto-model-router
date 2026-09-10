/**
 * Redaction: strings an operator forbids from leaving the process.
 *
 * An operator with a compliance obligation needs two things a router can
 * actually give: certainty that certain shapes of text never reach a provider,
 * and evidence that the guard ran. This module is the first half; the ledger's
 * `redactions` count is the second. Neither ever records WHAT was matched — a
 * redaction log that quotes the secret is just a second copy of the secret.
 *
 * `runTurn` applies this to the rendered upstream body, which is the
 * chat-completions shape every front end normalises to and every provider
 * client renders from, so the guard sits between the router and ALL of them:
 * a new upstream cannot bypass it by construction.
 */

import type { CompiledRedactionRule } from "../config/redaction.ts";

/** Applies every rule to one string. Returns the text and how many matches were replaced. */
export function redactText(text: string, rules: readonly CompiledRedactionRule[]): { text: string; count: number } {
	let out = text;
	let count = 0;
	for (const rule of rules) {
		// `replace` with a global regex resets and advances `lastIndex` itself,
		// including over a zero-width position — which compilation refuses anyway.
		out = out.replace(rule.regex, () => {
			count++;
			return rule.replacement;
		});
	}
	return { text: out, count };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => v !== null && typeof v === "object" && !Array.isArray(v);

/** Redacts a message's `content`, whether it is a string or an array of parts. Returns matches replaced. */
function redactContent(message: Rec, rules: readonly CompiledRedactionRule[]): number {
	const content = message.content;
	if (typeof content === "string") {
		const r = redactText(content, rules);
		if (r.count > 0) message.content = r.text;
		return r.count;
	}
	if (!Array.isArray(content)) return 0;
	let count = 0;
	for (const part of content) {
		// Text parts only: an `image_url` part carries a data URI, which no
		// redaction rule can meaningfully read and every rule would be slow over.
		if (!isRec(part) || part.type !== "text" || typeof part.text !== "string") continue;
		const r = redactText(part.text, rules);
		if (r.count > 0) part.text = r.text;
		count += r.count;
	}
	return count;
}

/**
 * Redacts the rendered upstream body in place and returns how many matches
 * were replaced.
 *
 * The body is the chat-completions shape: every front end (chat completions,
 * Responses, Anthropic Messages) translates into it before parsing, and every
 * upstream client renders its own protocol FROM it, so this one pass covers
 * every wire in and every provider out.
 *
 * What is scanned:
 *  - the text content of every message that is not a tool result — the system
 *    prompt (including the injected agentdox block), the user's words, the
 *    assistant's replay;
 *  - with `scanTools`, tool-call arguments and tool-result content as well.
 *    Off by default because tool results are where the bytes are: a turn's
 *    prompt is mostly file content, so scanning them is most of the cost — and
 *    also, for an operator who cares about a secret in a file the agent read,
 *    most of the point.
 *
 * Tool NAMES, ids and the tool schemas are left alone: they are the harness's
 * own vocabulary, not conversation content, and rewriting one breaks the
 * call/result pairing the model needs.
 */
export function redactUpstreamBody(
	body: Rec,
	rules: readonly CompiledRedactionRule[],
	opts: { scanTools: boolean },
): number {
	if (rules.length === 0) return 0;
	const messages = body.messages;
	if (!Array.isArray(messages)) return 0;
	let count = 0;
	for (const message of messages) {
		if (!isRec(message)) continue;
		const isToolResult = message.role === "tool";
		if (!isToolResult || opts.scanTools) count += redactContent(message, rules);
		if (!opts.scanTools || !Array.isArray(message.tool_calls)) continue;
		for (const call of message.tool_calls) {
			if (!isRec(call) || !isRec(call.function)) continue;
			const args = call.function.arguments;
			if (typeof args !== "string") continue;
			const r = redactText(args, rules);
			if (r.count > 0) call.function.arguments = r.text;
			count += r.count;
		}
	}
	return count;
}
