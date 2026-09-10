/**
 * Redaction rules: the guard that decides which patterns are allowed to run,
 * and the compiler that turns a rule set into regular expressions once.
 *
 * A rule is configuration meeting text from a user, which is exactly the shape
 * that backtracks: a pattern an operator wrote once, run against megabytes of
 * tool output on every turn of every conversation. A redaction rule that hangs
 * a request is worse than no rule at all, so the pattern is compiled ONCE, at
 * load, and the constructs with exponential worst cases are REFUSED rather
 * than trusted — the same view `src/context/scope.ts` takes of regular
 * expressions anywhere near the turn path.
 *
 * The refusal happens here, in config, so a bad rule is a startup error naming
 * the rule and the reason, never a rule the router quietly skipped while the
 * operator believed it was removing something. `src/server/redact.ts` applies
 * what this compiles.
 */

import type { RedactionConfig, RedactionRule } from "./types.ts";

/** One rule with its pattern already compiled. */
export interface CompiledRedactionRule {
	name: string;
	/** Global; `replace` owns `lastIndex`. */
	regex: RegExp;
	replacement: string;
}

/**
 * Bounds on a rule, all deliberately small. A redaction rule describes the
 * SHAPE OF A SECRET — an API key prefix, an account number, an internal
 * hostname — and every real one is short and literal. A pattern that needs
 * more than this is doing something a redaction rule should not.
 */
const MAX_PATTERN_CHARS = 512;
export const MAX_REDACTION_RULES = 64;

/** A rule name: it is echoed into the prompt as `[redacted:<name>]`, so it stays boring. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** The replacement a rule without one gets. Names the rule, never the match. */
export function defaultReplacement(name: string): string {
	return `[redacted:${name}]`;
}

/** Is `source[i]` an unbounded quantifier (`*`, `+`, `{n,}`)? Returns its length, or 0. */
function unboundedQuantifierAt(source: string, i: number): number {
	const c = source[i];
	if (c === "*" || c === "+") return 1;
	if (c !== "{") return 0;
	const close = source.indexOf("}", i);
	if (close < 0) return 0;
	// `{n,}` is unbounded; `{n}` and `{n,m}` are not.
	return /^\{\d+,\}$/.test(source.slice(i, close + 1)) ? close + 1 - i : 0;
}

/**
 * Walks a pattern source once, character by character, honouring escapes and
 * character classes, and reports the first construct we refuse to run.
 *
 * Two are refused, and they are the two that make a backtracking engine
 * exponential rather than merely slow:
 *
 *  - **A backreference** (`\1`, `\k<name>`). It takes the pattern outside the
 *    regular languages, so no linear-time strategy exists for it at all.
 *  - **An unbounded quantifier over a group that itself repeats without bound
 *    or offers a choice** — `(a+)+`, `(?:a|a)*`. These are the textbook
 *    catastrophic shapes: the number of ways to split the same input across
 *    the two quantifiers (or the two branches) grows exponentially with its
 *    length, so a single non-matching tool result can pin a core for minutes.
 *    A bounded outer quantifier is fine, which is why `(?:\d{1,3}\.){3}` — the
 *    shape real rules actually use — still loads.
 */
function refusedConstruct(source: string): string | null {
	const groupStarts: number[] = [];
	let inClass = false;
	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if (c === "\\") {
			const next = source[i + 1];
			if (!inClass && next !== undefined && (/[1-9]/.test(next) || next === "k")) {
				return "backreferences (\\1, \\k<name>) are not allowed: they take the pattern outside the regular languages, where no bound on matching time exists";
			}
			i++;
			continue;
		}
		if (inClass) {
			if (c === "]") inClass = false;
			continue;
		}
		if (c === "[") {
			inClass = true;
			continue;
		}
		if (c === "(") {
			groupStarts.push(i);
			continue;
		}
		if (c !== ")") continue;
		const start = groupStarts.pop();
		// Unbalanced: `new RegExp` reports it far better than we could.
		if (start === undefined) continue;
		if (unboundedQuantifierAt(source, i + 1) === 0) continue;
		const body = source.slice(start + 1, i);
		if (containsUnbounded(body)) {
			return `nested unbounded quantifiers ("${source.slice(start, i + 2)}"): a group that repeats without bound must not repeat without bound inside, or matching can take exponential time`;
		}
		if (containsAlternation(body)) {
			return `an alternation inside an unbounded quantifier ("${source.slice(start, i + 2)}"): the branches can match the same input many ways, so matching can take exponential time`;
		}
	}
	return null;
}

/** Does this fragment contain an unbounded quantifier outside a class or escape? */
function containsUnbounded(fragment: string): boolean {
	let inClass = false;
	for (let i = 0; i < fragment.length; i++) {
		const c = fragment[i]!;
		if (c === "\\") {
			i++;
			continue;
		}
		if (inClass) {
			if (c === "]") inClass = false;
			continue;
		}
		if (c === "[") inClass = true;
		else if (unboundedQuantifierAt(fragment, i) > 0) return true;
	}
	return false;
}

/** Does this fragment contain an alternation outside a class or escape? */
function containsAlternation(fragment: string): boolean {
	let inClass = false;
	for (let i = 0; i < fragment.length; i++) {
		const c = fragment[i]!;
		if (c === "\\") {
			i++;
			continue;
		}
		if (inClass) {
			if (c === "]") inClass = false;
			continue;
		}
		if (c === "[") inClass = true;
		else if (c === "|") return true;
	}
	return false;
}

/**
 * Compiles one pattern under the guard, or returns why it was refused.
 *
 * Unicode first: `u` rejects sloppy escapes and malformed quantifiers at load
 * rather than silently meaning something else, and it makes `.` and classes
 * operate on code points, so a rule cannot be defeated by an astral character
 * splitting a surrogate pair. A legacy pattern that only `u` rejects (an
 * unescaped `{`, an octal escape) still loads without it — an operator's
 * working rule should not break on an upgrade — so `u` is a preference, not a
 * requirement.
 *
 * Exported so a front door (the team edition's dashboard) can tell an operator
 * a rule is bad while they are typing it, with the same message the router
 * would refuse it with.
 */
export function compileRedactionPattern(source: string): { regex: RegExp } | { error: string } {
	if (source === "") return { error: "pattern must not be empty" };
	if (source.length > MAX_PATTERN_CHARS) {
		return { error: `pattern is ${source.length} characters; the limit is ${MAX_PATTERN_CHARS}` };
	}
	const refused = refusedConstruct(source);
	if (refused !== null) return { error: refused };
	let regex: RegExp | null = null;
	let unicode = true;
	try {
		regex = new RegExp(source, "gu");
	} catch {
		unicode = false;
	}
	if (regex === null) {
		try {
			regex = new RegExp(source, "g");
		} catch (err) {
			return { error: `pattern does not compile: ${err instanceof Error ? err.message : String(err)}` };
		}
	}
	// A pattern that matches the empty string would replace at every position,
	// turning the prompt into replacement text. Cheaper to refuse than to
	// special-case. Tested on a non-global copy so `lastIndex` stays untouched.
	if (new RegExp(source, unicode ? "u" : "").test("")) {
		return { error: "pattern matches the empty string, which would replace every position in the prompt" };
	}
	return { regex };
}

/** The reason a pattern is refused, or null when it is fine. */
export function validateRedactionPattern(source: string): string | null {
	const result = compileRedactionPattern(source);
	return "error" in result ? result.error : null;
}

/**
 * The reason a rule is refused, or null. Checks the name too, since it is
 * echoed into the prompt. Takes the two fields it reads rather than a whole
 * `RedactionRule`, so the config schema can hand it a parsed input object.
 */
export function validateRedactionRule(rule: { name: string; pattern: string }): string | null {
	if (!NAME_RE.test(rule.name)) {
		return "name must be 1-64 characters of letters, digits, spaces, dot, underscore or dash";
	}
	return validateRedactionPattern(rule.pattern);
}

/**
 * Compiles a whole rule set. Throws on the first bad rule, naming it: a
 * redaction rule that does not load is a hole in the guard, so the router
 * refuses to start rather than quietly forwarding what the operator believed
 * was being removed.
 */
export function compileRedactionRules(rules: readonly RedactionRule[]): CompiledRedactionRule[] {
	if (rules.length > MAX_REDACTION_RULES) {
		throw new Error(`redaction.rules has ${rules.length} rules; the limit is ${MAX_REDACTION_RULES}`);
	}
	const out: CompiledRedactionRule[] = [];
	for (const rule of rules) {
		const compiled = compileRedactionPattern(rule.pattern);
		if ("error" in compiled) throw new Error(`redaction rule "${rule.name}": ${compiled.error}`);
		if (!NAME_RE.test(rule.name)) {
			throw new Error(`redaction rule "${rule.name}": name must be 1-64 characters of letters, digits, spaces, dot, underscore or dash`);
		}
		out.push({
			name: rule.name,
			regex: compiled.regex,
			replacement: rule.replacement ?? defaultReplacement(rule.name),
		});
	}
	return out;
}

/**
 * Compiled rules for a config, memoised on the rules themselves.
 *
 * The turn path must not recompile a pattern per turn, and the live config is
 * MUTATED in place by hot reload and by an embedder's `reconfigure`, so a
 * reference check would miss an edit. The signature is the rules' own text —
 * a few short strings, joined — so an edited rule set compiles once more and
 * an unedited one is a map lookup.
 */
const compiledCache = new Map<string, CompiledRedactionRule[]>();

export function redactionRulesFor(cfg: RedactionConfig): CompiledRedactionRule[] {
	if (!cfg.enabled || cfg.rules.length === 0) return [];
	// NUL-separated so no rule text can forge another rule's boundary.
	const signature = cfg.rules.map((r) => [r.name, r.pattern, r.replacement ?? ""].join("\u0000")).join("\u0001");
	const hit = compiledCache.get(signature);
	if (hit !== undefined) return hit;
	const compiled = compileRedactionRules(cfg.rules);
	// One process can host several routers (the team edition restarts an
	// embedded one on the same port); keep the map from growing with them.
	if (compiledCache.size >= 16) compiledCache.clear();
	compiledCache.set(signature, compiled);
	return compiled;
}
