/**
 * The request id a turn carries, end to end.
 *
 * A front door (the team edition, a proxy, an edge) stamps `x-request-id` on
 * the response a customer sees, and that is what they quote in a ticket. Until
 * the router recorded it, placing that id on a ROUTED TURN was a time-window
 * join — "the same member at the same instant" — which can only ever answer
 * "probably this one", and answers nothing at all when two turns overlap. The
 * ledger records the id instead, so the answer is exact.
 *
 * The value comes from outside, so it is validated rather than trusted:
 *
 *  - **Bounded.** 128 characters covers every id in circulation (a UUID is 36,
 *    a ULID 26, a W3C `traceparent` 55, the team edition's own 12) with room
 *    to spare, and nothing unbounded reaches a column, a log line or a JSON
 *    body.
 *  - **Safe characters only.** Letters, digits, and `. _ - : + =`. That is
 *    every id shape a caller actually sends, and it excludes by construction
 *    the things that make an opaque string dangerous downstream: control
 *    characters and newlines (log injection — a log line must stay one line),
 *    quotes and angle brackets (a front door rendering the id in HTML), and
 *    whitespace.
 *  - **Rejected, never repaired.** A value outside the rules is treated as
 *    absent, not truncated or stripped. A truncated id looks valid and matches
 *    nothing, which is worse than a fresh one that at least addresses the row.
 *
 * When the caller sends nothing usable the router MINTS one, so every turn it
 * records is addressable — a direct user of the router gets the capability the
 * team edition's members get, without a front door in between. A minted id
 * carries a fixed prefix so it is never confused with one a caller chose, and
 * a caller-supplied id that wears the prefix is refused for the same reason:
 * nobody but this router may claim to have minted an id.
 */

/** The longest id accepted from a caller, and the length of a minted one's body. */
export const REQUEST_ID_MAX_LENGTH = 128;

/**
 * What every id this router mints starts with. Chosen to survive a front door's
 * own id rules: it stays inside `[A-Za-z0-9._-]`, so an operator can paste a
 * minted id into the team edition's support search unchanged.
 */
export const MINTED_REQUEST_ID_PREFIX = "amr-";

const SHAPE = new RegExp(`^[A-Za-z0-9._:+=-]{1,${REQUEST_ID_MAX_LENGTH}}$`);

/** Whether a string is an acceptable request id at all (shape and length only). */
export function isRequestId(value: string): boolean {
	return SHAPE.test(value);
}

/** Whether this router minted the id, rather than a caller supplying it. */
export function isMintedRequestId(value: string): boolean {
	return value.startsWith(MINTED_REQUEST_ID_PREFIX);
}

/** A fresh id for a turn whose caller supplied none: the prefix plus 32 hex characters. */
export function mintRequestId(): string {
	return `${MINTED_REQUEST_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

/**
 * The id to trust from a request header: the caller's, or `""` for anything
 * this router will not carry — absent, empty, too long, the wrong characters,
 * or wearing the minted prefix.
 */
export function acceptRequestId(raw: string | null | undefined): string {
	const s = (raw ?? "").trim();
	if (!isRequestId(s)) return "";
	return isMintedRequestId(s) ? "" : s;
}

/** The id a turn carries: the caller's when it passes, otherwise a minted one. */
export function requestIdFor(raw: string | null | undefined): string {
	const given = acceptRequestId(raw);
	return given === "" ? mintRequestId() : given;
}
