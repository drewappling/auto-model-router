/**
 * What to tell agentdox this turn is about.
 *
 * The relevance query biases which memories and docs the assembled block
 * carries, and agentdox echoes it verbatim into the block's header. Taking
 * the last user-role message literally sent omp's own machinery instead of
 * the user's ask: `<system-reminder>` nudges, `<system-notice>` job results,
 * `<recap>` prompts, "Attached image(s) from tool result:" continuations.
 * Measured on the live ledger: the three most recent blocks for one scope
 * were queried with `<chat>`, `<system-reminder>` and an image notice, one
 * header alone ran to 2k chars, and every refresh re-ranked memory against
 * noise — different bytes each time, at the head of the cached prefix.
 *
 * The query is the last user message with real content once wrapper blocks
 * are stripped, falling back to the conversation's opening ask, capped so the
 * header stays a line rather than a message.
 */

import type { NormRequest } from "../wire/types.ts";

/** Longest query worth sending: enough to rank on, short enough to stay stable. */
export const MAX_QUERY_CHARS = 400;

/**
 * Harness wrapper tags whose whole element is machinery, not the user's ask.
 * Stripped before judging whether a message has content.
 */
const WRAPPER_TAGS = ["system-reminder", "system-notice", "system-directive", "recap", "chat", "checkpoint-active-reminder", "interrupted-thinking"];

const WRAPPER_RE = new RegExp(`<(${WRAPPER_TAGS.join("|")})(\\s[^>]*)?>[\\s\\S]*?</\\1>`, "gi");
/** An unclosed wrapper at the start swallows the rest: treat the message as machinery. */
const OPEN_WRAPPER_RE = new RegExp(`^\\s*<(${WRAPPER_TAGS.join("|")})(\\s[^>]*)?>`, "i");
/** omp's tool-result image continuation and similar auto-generated stubs. */
const STUB_RE = /^(attached image\(s\)(\s.*)?|\[image\]|\(no output\)|continue[.!]?)$/i;

/** The user's own words in a message, or "" when it is all harness machinery. */
export function userContent(text: string): string {
	let t = text.replace(WRAPPER_RE, " ");
	if (OPEN_WRAPPER_RE.test(t)) return "";
	t = t.replace(/\s+/g, " ").trim();
	if (t === "" || STUB_RE.test(t)) return "";
	return t;
}

function cap(text: string): string {
	return text.length > MAX_QUERY_CHARS ? `${text.slice(0, MAX_QUERY_CHARS - 1)}…` : text;
}

/** The relevance query for this turn: last real user message, else the opening ask, else "". */
export function relevanceQuery(req: Pick<NormRequest, "messages">): string {
	for (let i = req.messages.length - 1; i >= 0; i--) {
		const m = req.messages[i];
		if (m === undefined || m.role !== "user") continue;
		const content = userContent(m.text);
		if (content !== "") return cap(content);
	}
	return "";
}
