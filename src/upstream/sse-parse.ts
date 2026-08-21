/**
 * Incremental SSE decoder for OpenRouter's chat-completions stream.
 *
 * Handles the realities of the wire: frames split across TCP chunks (even
 * mid-line or mid-codepoint), `: OPENROUTER PROCESSING` keep-alive comments,
 * and the terminal `data: [DONE]`. A malformed JSON frame is skipped with a
 * warning rather than thrown — one bad frame must not abort a paid generation.
 */

import type { UsageCounts } from "../cost/types.ts";
import type { FinishReason, StreamEvent, UpstreamChunk } from "../wire/types.ts";

export type SseWarning = (message: string, fields?: Record<string, unknown>) => void;

function asRec(v: unknown): Record<string, unknown> | null {
	return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function mapFinishReason(v: unknown): FinishReason | null {
	if (typeof v !== "string" || v === "") return null;
	switch (v) {
		case "stop":
		case "length":
		case "tool_calls":
		case "content_filter":
			return v;
		default:
			// Anything else ("error", provider-specific strings) means the
			// generation failed; the escalation guard treats it as such.
			return "error";
	}
}

function reasoningDelta(delta: Record<string, unknown>): string | null {
	// Providers disagree on the field: OpenAI-style `reasoning`, DeepSeek-style
	// `reasoning_content`, OpenRouter-normalized `reasoning_details`.
	const reasoning = delta.reasoning;
	if (typeof reasoning === "string" && reasoning.length > 0) return reasoning;
	const reasoningContent = delta.reasoning_content;
	if (typeof reasoningContent === "string" && reasoningContent.length > 0) return reasoningContent;
	const details = delta.reasoning_details;
	if (Array.isArray(details)) {
		let out = "";
		for (const d of details) {
			const rec = asRec(d);
			if (rec && typeof rec.text === "string") out += rec.text;
		}
		if (out.length > 0) return out;
	}
	return null;
}

function usageEvent(payload: Record<string, unknown>): StreamEvent | null {
	const usage = asRec(payload.usage);
	if (!usage) return null;
	const promptDetails = asRec(usage.prompt_tokens_details);
	const completionDetails = asRec(usage.completion_tokens_details);
	const counts: UsageCounts = {
		// prompt_tokens already INCLUDES cached tokens; cachedTokens is a
		// sub-count for pricing, never added on top.
		promptTokens: num(usage.prompt_tokens),
		cachedTokens: num(promptDetails?.cached_tokens),
		cacheWriteTokens: num(promptDetails?.cache_write_tokens),
		completionTokens: num(usage.completion_tokens),
		reasoningTokens: num(completionDetails?.reasoning_tokens),
		// Usage reports carry no image count; per-image surcharges are forecast-side.
		images: 0,
	};
	const cost = usage.cost;
	const reportedCostUsd = typeof cost === "number" && Number.isFinite(cost) ? cost : null;
	return { type: "usage", usage: counts, reportedCostUsd };
}

/**
 * Decodes an SSE byte stream into interpreted chunks. Single-pass; abandoning
 * the generator releases the underlying reader, but callers should abort the
 * fetch signal to actually tear down the connection.
 */
export async function* parseSse(
	stream: ReadableStream<Uint8Array>,
	warn?: SseWarning,
): AsyncGenerator<UpstreamChunk> {
	const reader = stream.getReader();
	// Streaming decoder so a multi-byte codepoint split across chunks survives.
	const decoder = new TextDecoder();
	let buf = "";
	let dataLines: string[] = [];
	let started = false;

	const buildChunk = (data: string): UpstreamChunk | "done" | null => {
		if (data === "[DONE]") return "done";
		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch (err) {
			warn?.("skipping malformed SSE payload", {
				error: err instanceof Error ? err.message : String(err),
				snippet: data.length > 160 ? `${data.slice(0, 160)}…` : data,
			});
			return null;
		}
		const raw = asRec(parsed);
		if (!raw) {
			warn?.("skipping non-object SSE payload", { snippet: data.slice(0, 160) });
			return null;
		}

		const events: StreamEvent[] = [];
		const id = typeof raw.id === "string" && raw.id !== "" ? raw.id : null;
		const model = typeof raw.model === "string" && raw.model !== "" ? raw.model : null;
		if (!started && id !== null && model !== null) {
			started = true;
			events.push({ type: "start", servedSlug: model, generationId: id });
		}

		const choices = raw.choices;
		const choice0 = Array.isArray(choices) && choices.length > 0 ? asRec(choices[0]) : null;
		const delta = choice0 ? asRec(choice0.delta) : null;
		if (delta) {
			const content = delta.content;
			if (typeof content === "string" && content.length > 0) {
				events.push({ type: "text", delta: content });
			}
			const reasoning = reasoningDelta(delta);
			if (reasoning !== null) events.push({ type: "reasoning", delta: reasoning });
			const toolCalls = delta.tool_calls;
			if (Array.isArray(toolCalls)) {
				for (const tcRaw of toolCalls) {
					const tc = asRec(tcRaw);
					if (!tc) continue;
					const ev: {
						type: "tool_call";
						index: number;
						id?: string;
						name?: string;
						argsDelta?: string;
					} = { type: "tool_call", index: typeof tc.index === "number" ? tc.index : 0 };
					// Fragments only carry id/name on their first chunk and arguments
					// as they stream; attach exactly what this fragment supplies.
					if (typeof tc.id === "string" && tc.id !== "") ev.id = tc.id;
					const fn = asRec(tc.function);
					if (fn) {
						if (typeof fn.name === "string" && fn.name !== "") ev.name = fn.name;
						if (typeof fn.arguments === "string" && fn.arguments !== "") ev.argsDelta = fn.arguments;
					}
					events.push(ev);
				}
			}
		}
		const finish = mapFinishReason(choice0?.finish_reason);
		if (finish !== null) events.push({ type: "finish", reason: finish });
		const usage = usageEvent(raw);
		if (usage !== null) events.push(usage);

		return { raw, events };
	};

	// Returns a chunk when the line completed a frame, "done" on [DONE], else null.
	const processLine = (line: string): UpstreamChunk | "done" | null => {
		if (line === "") {
			// Blank line terminates a frame.
			if (dataLines.length === 0) return null;
			const data = dataLines.join("\n");
			dataLines = [];
			return buildChunk(data);
		}
		// Keep-alive comments (": OPENROUTER PROCESSING") carry no data.
		if (line.startsWith(":")) return null;
		if (line.startsWith("data:")) {
			// Per SSE spec, a single leading space after the colon is stripped.
			dataLines.push(line.slice(5).replace(/^ /, ""));
		}
		// event:/id:/retry: fields carry nothing we route on.
		return null;
	};

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				const frame = processLine(line.endsWith("\r") ? line.slice(0, -1) : line);
				if (frame === "done") return;
				if (frame !== null) yield frame;
			}
		}
		// Flush a trailing partial line and a final frame missing its blank-line
		// terminator; some providers close the stream right after the payload.
		buf += decoder.decode();
		if (buf.length > 0) {
			const frame = processLine(buf.endsWith("\r") ? buf.slice(0, -1) : buf);
			if (frame === "done") return;
			if (frame !== null) yield frame;
		}
		const frame = processLine("");
		if (frame !== null && frame !== "done") yield frame;
	} finally {
		reader.releaseLock();
	}
}
