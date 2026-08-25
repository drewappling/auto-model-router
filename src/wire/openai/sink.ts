import type { ResponseSink, TurnSummary, UpstreamChunk, WireError } from "../types.ts";
import { encodeSseData, SSE_DONE_BYTES } from "../../util/sse.ts";
import { renderErrorEnvelope } from "./errors.ts";

/**
 * The four observability fields every routed response carries. Streaming
 * responses cannot use real headers (they flush with the first chunk, long
 * before the TurnSummary exists), so the streaming sink emits these in a final
 * `x_auto_model_router` SSE frame instead — see createStreamingSink.finish.
 */
function summaryFields(summary: TurnSummary): Record<string, unknown> {
	return {
		model: summary.servedSlug,
		tier: summary.tier,
		cost_usd: summary.reportedUsd ?? summary.predictedUsd,
		attempts: summary.attempts,
	};
}

export function createStreamingSink(virtualModel: string): { sink: ResponseSink; response: Response } {
	let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
	let closed = false;
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			controller = c;
		},
	});
	const send = (bytes: Uint8Array): void => {
		if (!closed) controller?.enqueue(bytes);
	};
	const close = (): void => {
		if (!closed) {
			closed = true;
			controller?.close();
		}
	};

	const sink: ResponseSink = {
		chunk(chunk: UpstreamChunk) {
			const raw = chunk.raw;
			// The client asked for the virtual id and must see it, so its own
			// bookkeeping stays consistent; the served slug stays observable
			// under x_auto_model_router. The tier is only known at finish time, so
			// per-chunk frames carry the slug and the final frame carries all
			// summary fields.
			send(
				encodeSseData({
					...raw,
					model: virtualModel,
					x_auto_model_router: { model: typeof raw.model === "string" ? raw.model : null },
				}),
			);
		},
		error(error: WireError) {
			// Headers (and likely chunks) are already on the wire; the only
			// channel left for the failure is one SSE frame in the OpenAI error
			// envelope, then an early close.
			send(encodeSseData(renderErrorEnvelope(error)));
			close();
		},
		finish(summary: TurnSummary) {
			// Response headers flushed with the first chunk, so x-auto-model-router-*
			// cannot be real headers here; this final frame is their carrier.
			send(encodeSseData({ x_auto_model_router: summaryFields(summary) }));
			send(SSE_DONE_BYTES);
			close();
		},
	};

	const response = new Response(body, {
		status: 200,
		headers: {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		},
	});
	return { sink, response };
}

/** Aggregation state for one completion choice. */
interface ChoiceAggregate {
	role: string;
	text: string;
	reasoning: string;
	toolCalls: Map<number, { id: string; name: string; args: string }>;
	finishReason: string | null;
}

export function createBufferedSink(virtualModel: string): {
	sink: ResponseSink;
	response: Promise<Response>;
} {
	let resolveResponse!: (r: Response) => void;
	const response = new Promise<Response>((resolve) => {
		resolveResponse = resolve;
	});
	let settled = false;

	let id: string | null = null;
	let created: number | null = null;
	const choices = new Map<number, ChoiceAggregate>();
	let usage: unknown = null;

	const sink: ResponseSink = {
		chunk(chunk: UpstreamChunk) {
			const raw = chunk.raw;
			if (typeof raw.id === "string") id = raw.id;
			if (typeof raw.created === "number") created = raw.created;
			if (Array.isArray(raw.choices)) {
				for (const c of raw.choices) {
					if (typeof c !== "object" || c === null) continue;
					const ch = c as { index?: unknown; delta?: unknown; finish_reason?: unknown };
					const index = typeof ch.index === "number" ? ch.index : 0;
					let agg = choices.get(index);
					if (!agg) {
						agg = { role: "assistant", text: "", reasoning: "", toolCalls: new Map(), finishReason: null };
						choices.set(index, agg);
					}
					if (typeof ch.delta === "object" && ch.delta !== null) {
						const delta = ch.delta as {
							role?: unknown;
							content?: unknown;
							reasoning?: unknown;
							reasoning_content?: unknown;
							tool_calls?: unknown;
						};
						if (typeof delta.role === "string") agg.role = delta.role;
						if (typeof delta.content === "string") agg.text += delta.content;
						// Upstreams disagree on the spelling; both land in `reasoning`.
						if (typeof delta.reasoning === "string") agg.reasoning += delta.reasoning;
						else if (typeof delta.reasoning_content === "string") agg.reasoning += delta.reasoning_content;
						if (Array.isArray(delta.tool_calls)) {
							for (const tc of delta.tool_calls) {
								if (typeof tc !== "object" || tc === null) continue;
								const t = tc as { index?: unknown; id?: unknown; function?: unknown };
								const ti = typeof t.index === "number" ? t.index : 0;
								let ta = agg.toolCalls.get(ti);
								if (!ta) {
									ta = { id: "", name: "", args: "" };
									agg.toolCalls.set(ti, ta);
								}
								if (typeof t.id === "string" && t.id.length > 0 && ta.id.length === 0) ta.id = t.id;
								if (typeof t.function === "object" && t.function !== null) {
									const fn = t.function as { name?: unknown; arguments?: unknown };
									if (typeof fn.name === "string" && fn.name.length > 0 && ta.name.length === 0) {
										ta.name = fn.name;
									}
									if (typeof fn.arguments === "string") ta.args += fn.arguments;
								}
							}
						}
					}
					if (typeof ch.finish_reason === "string") agg.finishReason = ch.finish_reason;
				}
			}
			if (typeof raw.usage === "object" && raw.usage !== null) usage = raw.usage;
		},
		error(error: WireError) {
			if (settled) return;
			settled = true;
			resolveResponse(
				new Response(JSON.stringify(renderErrorEnvelope(error)), {
					status: error.status,
					headers: { "content-type": "application/json" },
				}),
			);
		},
		finish(summary: TurnSummary) {
			if (settled) return;
			settled = true;
			if (choices.size === 0) {
				choices.set(0, { role: "assistant", text: "", reasoning: "", toolCalls: new Map(), finishReason: null });
			}
			const completion: Record<string, unknown> = {
				id: id ?? "chatcmpl-auto-model-router",
				object: "chat.completion",
				created: created ?? Math.floor(Date.now() / 1000),
				model: virtualModel,
				choices: [...choices.entries()]
					.sort((a, b) => a[0] - b[0])
					.map(([index, agg]) => {
						const message: Record<string, unknown> = { role: agg.role, content: agg.text };
						if (agg.reasoning.length > 0) message.reasoning = agg.reasoning;
						if (agg.toolCalls.size > 0) {
							message.tool_calls = [...agg.toolCalls.entries()]
								.sort((a, b) => a[0] - b[0])
								.map(([, ta]) => ({
									id: ta.id,
									type: "function",
									function: { name: ta.name, arguments: ta.args },
								}));
						}
						return { index, message, finish_reason: agg.finishReason ?? "stop" };
					}),
			};
			if (usage !== null) completion.usage = usage;
			// Header names are hyphenated by HTTP convention while the SSE frame
			// keys are snake_case by JSON convention. Deriving one from the other
			// silently produced `x-auto-model-router-cost_usd`.
			const headers: Record<string, string> = {
				"content-type": "application/json",
				"x-auto-model-router-model": summary.servedSlug,
				"x-auto-model-router-tier": summary.tier,
				"x-auto-model-router-cost-usd": String(summary.reportedUsd ?? summary.predictedUsd),
				"x-auto-model-router-attempts": String(summary.attempts),
			};
			resolveResponse(new Response(JSON.stringify(completion), { status: 200, headers }));
		},
	};

	return { sink, response };
}
