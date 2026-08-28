/**
 * Exercises the wire's context injection through the public render path, so
 * the test covers the real ordering (inject, then apply cache breakpoints).
 */
import { parseChatRequest } from "../../src/wire/openai/request.ts";

export function injectForTest(
	body: Record<string, unknown>,
	block: string,
	breakpoints: number[],
): Record<string, unknown> {
	const req = parseChatRequest(body, new Headers());
	return req.renderUpstreamBody({
		slug: "vendor/model",
		fallbacks: [],
		sessionId: "s",
		cacheBreakpointMessageIndices: breakpoints,
		reasoning: undefined,
		maxTokens: undefined,
		stripAssistantReasoning: false,
		contextBlock: block,
	});
}
