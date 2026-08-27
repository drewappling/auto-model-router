/**
 * Objective, deterministic grading proxies over an assistant's TEXT reply.
 *
 * These measure whether a model can follow an instruction, emit valid
 * structured output, and hit a checkable answer — a FLOOR on quality, which is
 * exactly what a tier gate needs ("is it good enough for this tier"). They are
 * not an absolute capability index, and deliberately use no LLM judge: every
 * grade is reproducible from the text alone.
 */

const REFUSAL = /\b(?:i can(?:'|no)?t|i am unable|i'm unable|cannot help|as an ai)\b/i;

export function isRefusalOrEmpty(output: string): boolean {
	const t = output.trim();
	return t.length === 0 || REFUSAL.test(t);
}

/** Lowercased, whitespace-collapsed. Reused by every text comparator here. */
export function normalizeText(s: string): string {
	return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function lastLine(s: string): string {
	const lines = s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
	return lines.length === 0 ? "" : (lines[lines.length - 1] ?? "");
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 1 when the expected answer is the whole reply, the last non-empty line, or a
 * standalone token in it; else 0. Standalone so "9.9" does not match "19.99".
 */
export function answerScore(output: string, expected: string): number {
	if (isRefusalOrEmpty(output)) return 0;
	const exp = normalizeText(expected);
	if (normalizeText(output) === exp) return 1;
	if (normalizeText(lastLine(output)) === exp) return 1;
	const re = new RegExp(`(?:^|[^\\w.])${escapeRegex(exp)}(?:$|[^\\w.])`);
	return re.test(normalizeText(output)) ? 1 : 0;
}

/** Fraction of required tokens present, case-insensitive. Smooth partial credit. */
export function tokenCoverage(output: string, tokens: readonly string[]): number {
	if (isRefusalOrEmpty(output) || tokens.length === 0) return 0;
	const hay = normalizeText(output);
	let hit = 0;
	for (const t of tokens) if (hay.includes(t.toLowerCase())) hit += 1;
	return hit / tokens.length;
}

/**
 * The first balanced JSON value in the text, tolerating ``` fences and prose
 * around it. Scans by bracket depth with string/escape awareness so a brace
 * inside a string literal does not throw off the balance.
 */
export function extractJson(output: string): unknown {
	const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const body = fenced?.[1] ?? output;
	const start = body.search(/[[{]/);
	if (start === -1) return undefined;
	const open = body[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = start; i < body.length; i++) {
		const ch = body[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === "\\") esc = true;
			else if (ch === '"') inStr = false;
			continue;
		}
		if (ch === '"') inStr = true;
		else if (ch === open) depth += 1;
		else if (ch === close) {
			depth -= 1;
			if (depth === 0) {
				try {
					return JSON.parse(body.slice(start, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

/** A named field of a JSON object, or undefined. Guarded boundary cast, read is checked. */
export function jsonField(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	// Narrowed to a non-null, non-array object; index as a string map at this boundary.
	const rec = value as Record<string, unknown>;
	return rec[key];
}

/**
 * Fraction of expected answers present as standalone tokens anywhere in the
 * reply. Partial credit — the point of these is to SPREAD models by how many
 * parts they get right, where an all-or-nothing grade would pin everyone at 1.
 */
export function multiAnswerCoverage(output: string, expected: readonly string[]): number {
	if (isRefusalOrEmpty(output) || expected.length === 0) return 0;
	const hay = normalizeText(output);
	let hit = 0;
	for (const e of expected) {
		const re = new RegExp(`(?:^|[^\\w.])${escapeRegex(normalizeText(e))}(?:$|[^\\w.])`);
		if (re.test(hay)) hit += 1;
	}
	return hit / expected.length;
}
