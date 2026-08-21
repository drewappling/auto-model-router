/**
 * SSE encoding helpers for the client-facing wire. The OpenAI front end needs
 * exactly two frame shapes; both go through one shared TextEncoder because a
 * frame is emitted per token on the hot path.
 */

const encoder = new TextEncoder();

/** One `data:` frame carrying a JSON payload, terminated by a blank line. */
export function sseDataFrame(value: unknown): string {
	return `data: ${JSON.stringify(value)}\n\n`;
}

/** Encoded variant of {@link sseDataFrame} for stream hot paths. */
export function encodeSseData(value: unknown): Uint8Array {
	return encoder.encode(sseDataFrame(value));
}

/** Terminal frame of every OpenAI SSE stream. */
export const SSE_DONE_FRAME = "data: [DONE]\n\n";

/** Pre-encoded {@link SSE_DONE_FRAME}. */
export const SSE_DONE_BYTES: Uint8Array = encoder.encode(SSE_DONE_FRAME);
