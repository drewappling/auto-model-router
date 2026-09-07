/**
 * Pure logic for the tool-result digest extension: which results to send,
 * how to read a tool result's text, and how to shape the replacement.
 */

export interface DigestPolicy {
	enabled: boolean;
	minBytes: number;
	maxBytes: number;
	tools: string[];
	fromTier: string;
}

export const DISABLED_POLICY: DigestPolicy = { enabled: false, minBytes: 0, maxBytes: 0, tools: [], fromTier: "hard" };

/** The text of a tool result's content parts; images are left alone (and block digesting). */
export function textOf(content: ReadonlyArray<{ type: string; text?: string }>): { text: string; hasImage: boolean } {
	let text = "";
	let hasImage = false;
	for (const part of content) {
		if (part.type === "text" && typeof part.text === "string") text += (text === "" ? "" : "\n") + part.text;
		else if (part.type === "image") hasImage = true;
	}
	return { text, hasImage };
}

/** Client-side gate: cheap checks before anything is sent to the router. */
export function shouldSend(policy: DigestPolicy, toolName: string, isError: boolean, text: string, hasImage: boolean): boolean {
	if (!policy.enabled || isError || hasImage) return false;
	if (!policy.tools.includes(toolName.toLowerCase())) return false;
	const bytes = Buffer.byteLength(text);
	return bytes >= policy.minBytes && bytes <= policy.maxBytes;
}

/** Parses the router's policy payload defensively; anything odd ⇒ disabled. */
export function parsePolicy(json: unknown): DigestPolicy {
	if (typeof json !== "object" || json === null) return DISABLED_POLICY;
	const p = json as Record<string, unknown>;
	if (p.enabled !== true) return DISABLED_POLICY;
	return {
		enabled: true,
		minBytes: typeof p.minBytes === "number" ? p.minBytes : 12_000,
		maxBytes: typeof p.maxBytes === "number" ? p.maxBytes : 400_000,
		tools: Array.isArray(p.tools) ? p.tools.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase()) : [],
		fromTier: typeof p.fromTier === "string" ? p.fromTier : "hard",
	};
}

/** One-line toast for a digest that happened. */
export function digestToast(toolName: string, inputBytes: number, outputChars: number, model: string, usd: number): string {
	const kb = (n: number): string => `${(n / 1024).toFixed(0)}KB`;
	return `digested ${toolName} ${kb(inputBytes)} → ${kb(outputChars)} via ${model.replace(/^ollama\//, "")} ($${usd.toFixed(4)})`;
}
