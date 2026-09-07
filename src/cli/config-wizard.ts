/**
 * Interactive configuration wizard for `auto-model-router config`.
 *
 * Edits the router's OWN config (`~/.auto-model-router/config.yml`), covering every
 * section: server, openrouter, ollama, benchmarks, tiers, tasks, filters, classifier,
 * escalation, hysteresis, exploration, cache, compaction, context, budget, ledger,
 * logging. omp's `/router config` walks the same `WIZARD_SECTIONS`.
 *
 * Only fields the user actually changes are written, as a deep-merge partial,
 * so untouched defaults and hand-edited values survive.
 *
 * Input conventions at a field prompt:
 *   - Enter (blank)  keep the current value (nothing written)
 *   - `-`            clear the field (writes null, reverting to no value)
 *   - anything else  parsed per the field kind, validated, re-prompted if bad
 *
 * The terminal plumbing is behind `WizardIo` so the whole flow is testable by
 * feeding a scripted list of answers. We deliberately do NOT use
 * `node:readline/promises`: under Bun, `question()` only resolves the first
 * call when stdin is a pipe, which hangs any scripted or piped run.
 */

import type { RouterConfig } from "../config/types.ts";

/** A pull-based source of input lines. `null` means end of input. */
export interface LineSource {
	next(): Promise<string | null>;
}

/** Terminal plumbing for the wizard: line input plus a write sink. */
export interface WizardIo {
	read: LineSource;
	write(text: string): void;
}

/** A single configurable field. `path` is dotted, e.g. `budget.perDayUsd`. */
export interface FieldSpec {
	path: string;
	label: string;
	kind: "string" | "number" | "boolean" | "enum" | "stringArray" | "numberArray";
	/** For `enum`: the allowed values. For `stringArray`: the allowed items, when restricted. */
	options?: readonly string[];
	/** For `number` / `numberArray`: inclusive bounds. */
	min?: number;
	max?: number;
	/** Whether the field may be cleared to "no value". */
	optional?: boolean;
	/** Short hint shown with the label. */
	hint?: string;
	/** Credential: the current value is shown as set/unset, never echoed. */
	secret?: boolean;
}

/** A wizard section: a titled group of fields. */
export interface SectionSpec {
	title: string;
	fields: readonly FieldSpec[];
}

const AXES = ["coding", "agentic", "intelligence"] as const;
const TIER_NAMES = ["trivial", "simple", "moderate", "hard"] as const;
const TASK_NAMES = ["coding", "vision", "documentation", "data", "chat"] as const;

/**
 * Escalation triggers the orchestrator understands: the `EscalationSignal`
 * union in `src/router/types.ts`. The schema accepts any string so an
 * experimental trigger can still be added by hand in YAML.
 */
const ESCALATION_TRIGGERS = [
	"malformed_tool_args",
	"refusal",
	"empty_completion",
	"repeat_tool_call",
	"length_stop",
	"missing_expected_tool_call",
	"upstream_error",
] as const;

function tierFields(tier: (typeof TIER_NAMES)[number]): FieldSpec[] {
	const p = `tiers.${tier}`;
	return [
		{ path: `${p}.minQuality`, label: `${tier}: min quality`, kind: "number", min: 0, max: 100 },
		{ path: `${p}.maxInputPerMtok`, label: `${tier}: max input $/Mtok`, kind: "number", min: 0, optional: true },
		{ path: `${p}.maxOutputPerMtok`, label: `${tier}: max output $/Mtok`, kind: "number", min: 0, optional: true },
		{ path: `${p}.qualityExponent`, label: `${tier}: quality exponent`, kind: "number", min: 0, hint: "quality^k per $" },
		{ path: `${p}.qualityNormalization`, label: `${tier}: normalise quality to floor`, kind: "boolean", optional: true },
		{ path: `${p}.capabilityFloorUsd`, label: `${tier}: capability floor $/Mtok`, kind: "number", min: 0, optional: true, hint: "blended" },
		{ path: `${p}.pin`, label: `${tier}: pinned slugs`, kind: "stringArray", hint: "comma-separated" },
	];
}

function taskFields(task: (typeof TASK_NAMES)[number]): FieldSpec[] {
	const p = `tasks.${task}`;
	return [
		{ path: `${p}.axis`, label: `${task}: axis`, kind: "enum", options: AXES },
		{ path: `${p}.minQuality`, label: `${task}: quality floor`, kind: "number", min: 0, max: 100, optional: true },
		{ path: `${p}.requireImage`, label: `${task}: require image input`, kind: "boolean", optional: true },
		{ path: `${p}.prefer`, label: `${task}: always-eligible slugs`, kind: "stringArray", optional: true, hint: "comma-separated" },
	];
}

/**
 * Every field the wizard can edit, grouped into the menu's sections. This is
 * the whole of `RouterConfig` except the two Ollama maps (`ollama.prices`,
 * `ollama.twins`) and the profiles array, which are edited as records
 * (profiles through the wizard's own profile editor, the maps in YAML).
 * `test/config-wizard.test.ts` checks that every other config leaf is here.
 */
export const WIZARD_SECTIONS: readonly SectionSpec[] = [
	{
		title: "Server",
		fields: [
			{ path: "server.host", label: "Listen host", kind: "string" },
			{ path: "server.port", label: "Listen port", kind: "number", min: 1, max: 65535 },
			{ path: "server.apiKey", label: "Client bearer token", kind: "string", optional: true, secret: true },
			{ path: "server.harnessId", label: "Default harness id", kind: "string", optional: true },
			{ path: "server.maxConcurrentTurns", label: "Max concurrent turns", kind: "number", min: 1, hint: "per process, all sessions" },
		],
	},
	{
		title: "OpenRouter",
		fields: [
			{ path: "openrouter.baseUrl", label: "Base URL", kind: "string" },
			{ path: "openrouter.apiKey", label: "API key", kind: "string", optional: true, secret: true, hint: "or OPENROUTER_API_KEY / omp login" },
			{ path: "openrouter.referer", label: "Attribution referer", kind: "string", optional: true },
			{ path: "openrouter.title", label: "Attribution title", kind: "string" },
			{ path: "openrouter.timeoutMs", label: "Request timeout", kind: "number", min: 1, hint: "ms" },
			{ path: "openrouter.catalogTtlMs", label: "Catalog TTL", kind: "number", min: 1, hint: "ms" },
			{ path: "openrouter.catalogRefreshMs", label: "Catalog refresh", kind: "number", min: 0, hint: "ms, 0=off" },
		],
	},
	{
		title: "Ollama Cloud",
		fields: [
			{ path: "ollama.enabled", label: "Enable Ollama Cloud as a second upstream", kind: "boolean" },
			{ path: "ollama.baseUrl", label: "Base URL", kind: "string", hint: "https://ollama.com/v1 or a local daemon" },
			{ path: "ollama.apiKey", label: "API key", kind: "string", optional: true, secret: true, hint: "or OLLAMA_API_KEY / omp login ollama-cloud" },
			{ path: "ollama.timeoutMs", label: "Request timeout", kind: "number", min: 1, hint: "ms" },
			{ path: "ollama.catalogTtlMs", label: "Catalog TTL", kind: "number", min: 1, hint: "ms" },
			{ path: "ollama.includeLocal", label: "Include locally pulled models", kind: "boolean", hint: "local daemon only" },
			{ path: "ollama.costBias", label: "Cost bias while credits remain", kind: "number", min: 0, hint: "0.1 = tenth the cost; 1 = at list" },
			{ path: "ollama.biasUntilUsage", label: "Apply bias until plan usage", kind: "number", min: 0, max: 1, hint: "0-1 of included credits" },
			{ path: "ollama.usagePollMs", label: "Plan usage poll", kind: "number", min: 0, hint: "ms, 0=off" },
			{ path: "ollama.quotaCooldownMs", label: "Quota (402) cooldown", kind: "number", min: 0, hint: "ms" },
			{ path: "ollama.rateLimitCooldownMs", label: "Rate-limit (429) cooldown", kind: "number", min: 0, hint: "ms" },
			{ path: "ollama.planCreditsUsd", label: "Plan credits per month $", kind: "number", min: 0, hint: "0=detect plan (Pro 60, Max 300)" },
		],
	},
	{
		title: "Benchmarks",
		fields: [
			{ path: "benchmarks.enabled", label: "Fetch quality scores", kind: "boolean" },
			{ path: "benchmarks.artificialAnalysisApiKey", label: "Artificial Analysis API key", kind: "string", optional: true, secret: true },
			{ path: "benchmarks.benchlm", label: "Use BenchLM scores", kind: "boolean" },
			{ path: "benchmarks.refreshMs", label: "Refresh interval", kind: "number", min: 0, hint: "ms" },
			{ path: "benchmarks.timeoutMs", label: "Fetch timeout", kind: "number", min: 1, hint: "ms" },
			{ path: "benchmarks.useLocalScores", label: "Blend in local eval scores", kind: "boolean" },
		],
	},
	{
		title: "Tiers",
		fields: [
			{
				path: "adaptiveTierFloors",
				label: "Adaptive floors from available models",
				kind: "boolean",
				hint: "keeps every tier populated",
			},
			{ path: "adaptivePriceCeilings", label: "Adaptive price ceilings", kind: "boolean", hint: "derive $/Mtok caps from the catalog" },
			...TIER_NAMES.flatMap(tierFields),
		],
	},
	{
		title: "Tasks",
		fields: TASK_NAMES.flatMap(taskFields),
	},
	{
		title: "Filters",
		fields: [
			{ path: "filters.allow", label: "Allow globs", kind: "stringArray", hint: "comma-separated" },
			{ path: "filters.deny", label: "Deny globs", kind: "stringArray", hint: "comma-separated" },
			{ path: "filters.includeFree", label: "Include free models", kind: "boolean" },
			{ path: "filters.requireToolSupport", label: "Require tool support", kind: "boolean" },
			{ path: "filters.minTrust", label: "Min trust", kind: "number", min: 0, max: 1 },
			{ path: "filters.minTrustSamples", label: "Min trust samples", kind: "number", min: 0 },
			{ path: "filters.trustScopedByHarness", label: "Scope trust per harness", kind: "boolean" },
			{ path: "filters.trustWindowDays", label: "Trust window", kind: "number", min: 0, hint: "days, 0=all time" },
			{ path: "filters.contextHeadroom", label: "Context headroom", kind: "number", min: 1 },
			{ path: "filters.latencyWeight", label: "Latency weight", kind: "number", min: 0, hint: "0=ignore speed" },
			{ path: "filters.latencyReferenceMs", label: "Latency reference TTFT", kind: "number", min: 1, hint: "ms" },
			{ path: "filters.latencyReferenceTokensPerSec", label: "Latency reference speed", kind: "number", min: 1, hint: "tok/s" },
			{ path: "filters.latencyMinSamples", label: "Latency min samples", kind: "number", min: 0 },
			{ path: "filters.cacheReliabilityMinSamples", label: "Cache reliability min samples", kind: "number", min: 0, hint: "0=assume caches reliable" },
			{ path: "filters.maxExpectedWaitMs", label: "Max expected wait", kind: "number", min: 1, optional: true, hint: "ms, hard ceiling" },
			{ path: "filters.escalationCostWeight", label: "Escalation cost weight", kind: "number", min: 0, max: 1 },
		],
	},
	{
		title: "Classifier",
		fields: [
			{ path: "classifier.ambiguityThreshold", label: "Ambiguity threshold", kind: "number", min: 0, max: 1 },
			{ path: "classifier.model", label: "Adjudicator model", kind: "string", optional: true },
			{ path: "classifier.maxCostFraction", label: "Max cost fraction", kind: "number", min: 0, max: 1 },
			{ path: "classifier.maxCostUsd", label: "Max adjudication cost $", kind: "number", min: 0 },
			{ path: "classifier.timeoutMs", label: "Adjudicator timeout", kind: "number", min: 1, hint: "ms" },
			{ path: "classifier.cacheSize", label: "Adjudication cache size", kind: "number", min: 0 },
			{ path: "classifier.toolAxis", label: "Tool-call axis", kind: "enum", options: AXES },
			{ path: "classifier.chatAxis", label: "Chat axis", kind: "enum", options: AXES },
			{ path: "classifier.agenticLoopDepth", label: "Agentic loop depth", kind: "number", min: 0, hint: "tool rounds before damping" },
			{ path: "classifier.mechanicalRetryFactor", label: "Mechanical retry factor", kind: "number", min: 0, max: 1 },
			{ path: "classifier.reasoningWeights.medium", label: "Reasoning weight: medium", kind: "number", min: 0 },
			{ path: "classifier.reasoningWeights.high", label: "Reasoning weight: high", kind: "number", min: 0 },
			{ path: "classifier.reasoningWeights.xhigh", label: "Reasoning weight: xhigh", kind: "number", min: 0 },
			{ path: "classifier.reasoningWeights.max", label: "Reasoning weight: max", kind: "number", min: 0 },
		],
	},
	{
		title: "Escalation",
		fields: [
			{ path: "escalation.enabled", label: "Enable mid-stream escalation", kind: "boolean" },
			{ path: "escalation.probeTokens", label: "Probe tokens", kind: "number", min: 1 },
			{ path: "escalation.maxHoldMs", label: "Max hold", kind: "number", min: 1, hint: "ms" },
			{ path: "escalation.maxAttempts", label: "Max attempts", kind: "number", min: 1 },
			{ path: "escalation.probeTiers", label: "Tiers that probe", kind: "stringArray", options: TIER_NAMES, hint: "comma-separated" },
			{ path: "escalation.triggers", label: "Triggers", kind: "stringArray", options: ESCALATION_TRIGGERS, hint: "comma-separated" },
			{ path: "escalation.escalateOnLengthStop", label: "Escalate on length stop", kind: "boolean" },
		],
	},
	{
		title: "Hysteresis",
		fields: [
			{ path: "hysteresis.holdTurns", label: "Hold turns", kind: "number", min: 0 },
			{ path: "hysteresis.holdTurnsAfterEscalation", label: "Hold turns after escalation", kind: "number", min: 0 },
			{ path: "hysteresis.switchMargin", label: "Switch margin", kind: "number", min: 0 },
			{ path: "hysteresis.switchHorizonTurns", label: "Switch horizon", kind: "number", min: 1, hint: "turns amortised" },
			{ path: "hysteresis.confirmUpgradesBelowConfidence", label: "Confirm upgrades below confidence", kind: "number", min: 0, max: 1, hint: "0=off; low-confidence tier-ups wait a turn" },
			{ path: "hysteresis.cacheWarmTtlMs", label: "Cache-warm TTL", kind: "number", min: 0, hint: "ms" },
			{ path: "hysteresis.maxDowngradePerTurn", label: "Max downgrade per turn", kind: "number", min: 0, hint: "tiers" },
			{ path: "hysteresis.breakHoldOnMechanical", label: "Break hold on mechanical turns", kind: "boolean" },
		],
	},
	{
		title: "Exploration",
		fields: [
			{ path: "exploration.enabled", label: "Enable exploration", kind: "boolean", hint: "records arms into the ledger" },
			{ path: "exploration.rates.trivial", label: "Rate: trivial", kind: "number", min: 0, max: 1, optional: true },
			{ path: "exploration.rates.simple", label: "Rate: simple", kind: "number", min: 0, max: 1, optional: true },
			{ path: "exploration.rates.moderate", label: "Rate: moderate", kind: "number", min: 0, max: 1, optional: true },
			{ path: "exploration.rates.hard", label: "Rate: hard", kind: "number", min: 0, max: 1, optional: true },
			{ path: "exploration.stickyPolicy", label: "Sticky policy", kind: "enum", options: ["never", "cold-cache", "always"] },
			{ path: "exploration.holdTurns.enabled", label: "Hold-length experiment", kind: "boolean" },
			{ path: "exploration.holdTurns.values", label: "Hold-length arms", kind: "numberArray", min: 1, hint: "comma-separated turns" },
		],
	},
	{
		title: "Cache",
		fields: [
			{ path: "cache.injectBreakpoints", label: "Inject cache breakpoints", kind: "boolean" },
			{ path: "cache.maxBreakpoints", label: "Max breakpoints", kind: "number", min: 1 },
			{ path: "cache.minPromptTokens", label: "Min prompt tokens", kind: "number", min: 0 },
			{ path: "cache.milestoneTokens", label: "Milestone tokens", kind: "number", min: 1, hint: "breakpoint spacing" },
		],
	},
	{
		title: "Compaction",
		fields: [
			{ path: "compaction.enabled", label: "Enable compaction", kind: "boolean" },
			{ path: "compaction.budgetTokens", label: "Budget tokens", kind: "number", min: 1 },
			{ path: "compaction.floorRatio", label: "Floor ratio", kind: "number", min: 0, max: 1, hint: "of the budget" },
			{ path: "compaction.replanGrowthRatio", label: "Replan growth ratio", kind: "number", min: 1 },
			{ path: "compaction.fitToWindow", label: "Fit to model context window", kind: "boolean" },
			{ path: "compaction.protectRecentTurns", label: "Protect recent turns", kind: "number", min: 1 },
			{ path: "compaction.maxToolResultBytes", label: "Max tool result bytes", kind: "number", min: 1 },
			{ path: "compaction.keepHeadBytes", label: "Keep head bytes", kind: "number", min: 0 },
			{ path: "compaction.keepTailBytes", label: "Keep tail bytes", kind: "number", min: 0 },
			{ path: "compaction.elideSupersededReads", label: "Elide superseded reads", kind: "boolean" },
			{ path: "compaction.collapseDuplicateResults", label: "Collapse duplicate results", kind: "boolean" },
		],
	},
	{
		title: "Context (agentdox)",
		fields: [
			{ path: "context.enabled", label: "Inject shared project context", kind: "boolean" },
			{ path: "context.baseUrl", label: "agentdox URL", kind: "string", optional: true },
			{ path: "context.token", label: "agentdox token", kind: "string", optional: true, secret: true, hint: "or AGENTDOX_TOKEN" },
			{ path: "context.defaultScope", label: "Default scope", kind: "string", optional: true },
			{ path: "context.timeoutMs", label: "Request timeout", kind: "number", min: 1, hint: "ms" },
			{ path: "context.maxStalenessMs", label: "Max staleness", kind: "number", min: 0, hint: "ms" },
			{ path: "context.maxBlockChars", label: "Max block chars", kind: "number", min: 1 },
			{ path: "context.memoryLimit", label: "Memory items", kind: "number", min: 1 },
			{ path: "context.docsLimit", label: "Doc items", kind: "number", min: 0 },
			{ path: "context.sessionLimit", label: "Session items", kind: "number", min: 0 },
			{ path: "context.briefChars", label: "Brief chars", kind: "number", min: 0 },
			{ path: "context.recordTurns", label: "Record turns back", kind: "boolean" },
			{ path: "context.maxQueue", label: "Write-back queue", kind: "number", min: 1 },
		],
	},
	{
		title: "Budget",
		fields: [
			{ path: "budget.perTurnUsd", label: "Per-turn cap $", kind: "number", min: 0, optional: true },
			{ path: "budget.perConversationUsd", label: "Per-conversation cap $", kind: "number", min: 0, optional: true },
			{ path: "budget.perDayUsd", label: "Per-day cap $", kind: "number", min: 0, optional: true },
			{ path: "budget.onExceeded", label: "On exceeded", kind: "enum", options: ["downgrade", "reject"] },
		],
	},
	{
		title: "Ledger",
		fields: [
			{ path: "ledger.path", label: "Ledger path", kind: "string", hint: "SQLite file" },
			{ path: "ledger.blendWindowDays", label: "Blend window", kind: "number", min: 1, hint: "days" },
			{ path: "ledger.blendMinSamples", label: "Blend min samples", kind: "number", min: 0 },
			{ path: "ledger.fallbackBlend.inputPerMtok", label: "Fallback blend input $/Mtok", kind: "number", min: 0 },
			{ path: "ledger.fallbackBlend.outputPerMtok", label: "Fallback blend output $/Mtok", kind: "number", min: 0 },
			{ path: "ledger.conversationTtlMs", label: "Conversation TTL", kind: "number", min: 1, hint: "ms" },
		],
	},
	{
		title: "Logging",
		fields: [
			{ path: "logLevel", label: "Log level", kind: "enum", options: ["silent", "error", "warn", "info", "debug"] },
		],
	},
];

/** Reads a dotted path out of a nested object. */
export function getPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split(".")) {
		if (typeof cur !== "object" || cur === null) return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

/** Sets a dotted path, creating intermediate objects as needed. */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
	const parts = path.split(".");
	const last = parts.length - 1;
	let cur = target;
	for (let i = 0; i < last; i++) {
		const part = parts[i] ?? "";
		const next = cur[part];
		if (typeof next !== "object" || next === null || Array.isArray(next)) {
			const fresh: Record<string, unknown> = {};
			cur[part] = fresh;
			cur = fresh;
		} else {
			cur = next as Record<string, unknown>;
		}
	}
	cur[parts[last] ?? ""] = value;
}

/** Result of validating one raw answer against a field spec. */
export type FieldResult =
	| { ok: true; value: unknown }
	| { ok: false; error: string };

/** The sentinel a user types to clear an optional field. */
export const CLEAR_TOKEN = "-";

/** Parses and validates one raw answer for a field. */
export function validateField(field: FieldSpec, raw: string): FieldResult {
	const text = raw.trim();

	if (text === CLEAR_TOKEN) {
		if (field.optional !== true) return { ok: false, error: `${field.label} cannot be cleared` };
		return { ok: true, value: null };
	}

	switch (field.kind) {
		case "string":
			return { ok: true, value: text };

		case "number": {
			const n = Number(text);
			if (!Number.isFinite(n)) return { ok: false, error: `not a number: ${text}` };
			if (field.min !== undefined && n < field.min) return { ok: false, error: `must be >= ${field.min}` };
			if (field.max !== undefined && n > field.max) return { ok: false, error: `must be <= ${field.max}` };
			return { ok: true, value: n };
		}

		case "boolean": {
			const lower = text.toLowerCase();
			if (["y", "yes", "true", "1", "on"].includes(lower)) return { ok: true, value: true };
			if (["n", "no", "false", "0", "off"].includes(lower)) return { ok: true, value: false };
			return { ok: false, error: `answer y or n, got: ${text}` };
		}

		case "enum": {
			const options = field.options ?? [];
			if (!options.includes(text)) return { ok: false, error: `one of: ${options.join(", ")}` };
			return { ok: true, value: text };
		}

		case "stringArray": {
			const items = text.split(",").map((s) => s.trim()).filter((s) => s !== "");
			if (field.options !== undefined) {
				const bad = items.filter((s) => !field.options?.includes(s));
				if (bad.length > 0) return { ok: false, error: `unknown: ${bad.join(", ")} (one of: ${field.options.join(", ")})` };
			}
			return { ok: true, value: items };
		}

		case "numberArray": {
			const items = text.split(",").map((s) => s.trim()).filter((s) => s !== "");
			const values: number[] = [];
			for (const item of items) {
				const n = Number(item);
				if (!Number.isFinite(n)) return { ok: false, error: `not a number: ${item}` };
				if (field.min !== undefined && n < field.min) return { ok: false, error: `${item}: must be >= ${field.min}` };
				if (field.max !== undefined && n > field.max) return { ok: false, error: `${item}: must be <= ${field.max}` };
				values.push(n);
			}
			return { ok: true, value: values };
		}
	}
}

/**
 * Turns a flat `dotted.path -> value` map of edits into the nested partial
 * object to merge into the config file.
 */
export function applyAnswers(answers: Record<string, unknown>): Record<string, unknown> {
	const partial: Record<string, unknown> = {};
	for (const [path, value] of Object.entries(answers)) {
		setPath(partial, path, value);
	}
	return partial;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Deep-merges a wizard partial into the on-disk config object.
 *
 * A `null` leaf means "clear this setting": the key is DELETED rather than
 * written as null, so the loader falls back to its default and the schema
 * (which types optional fields as absent, not nullable) still accepts the
 * file. Empty objects left behind by a clear are pruned.
 */
export function mergeConfigPartial(
	base: Record<string, unknown>,
	partial: Record<string, unknown>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...base };

	for (const [key, value] of Object.entries(partial)) {
		if (value === null) {
			delete out[key];
			continue;
		}

		if (isPlainRecord(value)) {
			const existing = out[key];
			const merged = mergeConfigPartial(isPlainRecord(existing) ? existing : {}, value);
			if (Object.keys(merged).length === 0) delete out[key];
			else out[key] = merged;
			continue;
		}

		out[key] = Array.isArray(value) ? value.slice() : value;
	}

	return out;
}

/** Renders a config value the way the prompt shows the current setting. */
export function formatValue(value: unknown): string {
	if (value === undefined || value === null) return "unset";
	if (Array.isArray(value)) return value.length === 0 ? "empty" : value.join(", ");
	if (typeof value === "boolean") return value ? "y" : "n";
	return String(value);
}

/**
 * What a prompt shows as the current value: `formatValue`, except that a
 * secret is never echoed — only whether one is set.
 */
export function displayValue(field: FieldSpec, value: unknown): string {
	if (field.secret === true) return value === undefined || value === null || value === "" ? "unset" : "set";
	return formatValue(value);
}

/** Builds the field prompt line, e.g. `  Listen port [8788]: `. */
function fieldPrompt(field: FieldSpec, current: unknown): string {
	const hint = field.hint !== undefined ? ` (${field.hint})` : "";
	return `  ${field.label}${hint} [${displayValue(field, current)}]: `;
}

/** Renders the top-level section menu. */
function renderMenu(edits: Record<string, unknown>): string {
	const lines: string[] = ["", "auto-model-router config", ""];
	WIZARD_SECTIONS.forEach((section, i) => {
		const touched = Object.keys(edits).filter((p) =>
			section.fields.some((f) => f.path === p),
		).length;
		const mark = touched > 0 ? ` (${touched} changed)` : "";
		lines.push(`  ${String(i + 1).padStart(2)}) ${section.title}${mark}`);
	});
	lines.push("");
	const profilesMark = "profiles" in edits ? " (changed)" : "";
	lines.push(`   p) Profiles${profilesMark}`);
	lines.push("   a) walk every section");
	lines.push("   s) save and exit");
	lines.push("   q) quit without saving");
	lines.push("");
	const pending = Object.keys(edits).length;
	lines.push(`select${pending > 0 ? ` (${pending} pending)` : ""}: `);
	return lines.join("\n");
}

/**
 * Walks one section, prompting for each field. Invalid answers re-prompt.
 * Returns false if input ended (treated as an abort by the caller).
 */
async function editSection(
	section: SectionSpec,
	cfg: RouterConfig,
	edits: Record<string, unknown>,
	io: WizardIo,
): Promise<boolean> {
	io.write(`\n== ${section.title} ==\n`);
	io.write(`   Enter keeps current, "${CLEAR_TOKEN}" clears an optional field\n`);

	for (const field of section.fields) {
		// Show the pending edit if this field was already touched this session.
		const current = field.path in edits ? edits[field.path] : getPath(cfg, field.path);

		for (;;) {
			io.write(fieldPrompt(field, current));
			const raw = await io.read.next();
			if (raw === null) return false;
			if (raw.trim() === "") break; // keep current, next field

			const result = validateField(field, raw);
			if (!result.ok) {
				io.write(`    ! ${result.error}\n`);
				continue;
			}
			edits[field.path] = result.value;
			break;
		}
	}
	return true;
}

const TIERS = ["trivial", "simple", "moderate", "hard"] as const;

/**
 * Fields of one virtual profile. Paths are relative to the profile record,
 * because profiles live in an ARRAY and are edited as whole elements.
 */
export const PROFILE_FIELDS: readonly FieldSpec[] = [
	{ path: "id", label: "Model id (as clients see it)", kind: "string" },
	{ path: "name", label: "Display name", kind: "string" },
	{ path: "minTier", label: "Floor tier", kind: "enum", options: TIERS },
	{ path: "maxTier", label: "Ceiling tier", kind: "enum", options: TIERS },
	{ path: "contextWindow", label: "Context window", kind: "number", min: 1, hint: "tokens" },
	{ path: "maxTokens", label: "Max output tokens", kind: "number", min: 1 },
];

/** A brand-new profile, pre-filled so every field has a sane starting value. */
function blankProfile(): Record<string, unknown> {
	return {
		id: "",
		name: "",
		minTier: "trivial",
		maxTier: "hard",
		contextWindow: 400000,
		maxTokens: 32000,
	};
}

/**
 * Prompts for each field of a single profile, mutating `profile` in place.
 *
 * When `requireAll` is set (a newly added profile) a blank answer is refused
 * for fields that are still empty, so we never persist a nameless profile.
 */
async function editProfileFields(
	profile: Record<string, unknown>,
	io: WizardIo,
	requireAll: boolean,
): Promise<boolean> {
	for (const field of PROFILE_FIELDS) {
		for (;;) {
			io.write(fieldPrompt(field, profile[field.path]));
			const raw = await io.read.next();
			if (raw === null) return false;

			if (raw.trim() === "") {
				if (requireAll && profile[field.path] === "") {
					io.write(`    ! ${field.label} is required\n`);
					continue;
				}
				break; // keep current
			}

			const result = validateField(field, raw);
			if (!result.ok) {
				io.write(`    ! ${result.error}\n`);
				continue;
			}
			profile[field.path] = result.value;
			break;
		}
	}
	return true;
}

/** Renders the profile list menu. */
function renderProfileMenu(list: readonly Record<string, unknown>[]): string {
	const lines: string[] = ["", "== Profiles ==", ""];
	if (list.length === 0) lines.push("  (none)");
	list.forEach((profile, i) => {
		const id = String(profile["id"] ?? "");
		const name = String(profile["name"] ?? "");
		const span = `${String(profile["minTier"] ?? "?")}..${String(profile["maxTier"] ?? "?")}`;
		lines.push(`  ${String(i + 1).padStart(2)}) ${id}  "${name}"  [${span}]`);
	});
	lines.push("");
	lines.push("   n) add a profile");
	lines.push("  x<N>) delete profile N");
	lines.push("   b) back");
	lines.push("");
	lines.push("select: ");
	return lines.join("\n");
}

/**
 * Edits the `profiles` array. Because arrays are replaced wholesale on merge,
 * any change records the ENTIRE new array as one edit.
 */
async function editProfiles(
	cfg: RouterConfig,
	edits: Record<string, unknown>,
	io: WizardIo,
): Promise<boolean> {
	const pending = edits["profiles"];
	const list: Record<string, unknown>[] = Array.isArray(pending)
		? pending.map((p) => ({ ...(p as Record<string, unknown>) }))
		: cfg.profiles.map((p) => ({ ...p }));

	for (;;) {
		io.write(renderProfileMenu(list));
		const choice = await io.read.next();
		if (choice === null) return false;
		const answer = choice.trim().toLowerCase();

		if (answer === "b") return true;

		if (answer === "n") {
			const fresh = blankProfile();
			const ok = await editProfileFields(fresh, io, true);
			if (!ok) return false;
			list.push(fresh);
			edits["profiles"] = list;
			continue;
		}

		const del = /^x\s*(\d+)$/.exec(answer);
		if (del !== null) {
			const index = Number(del[1]);
			if (index < 1 || index > list.length) {
				io.write(`  ! no profile ${index}\n`);
				continue;
			}
			if (list.length === 1) {
				io.write("  ! cannot delete the last profile\n");
				continue;
			}
			list.splice(index - 1, 1);
			edits["profiles"] = list;
			continue;
		}

		const index = Number(answer);
		const profile = Number.isInteger(index) ? list[index - 1] : undefined;
		if (profile === undefined) {
			io.write(`  ! not a choice: ${choice.trim()}\n`);
			continue;
		}
		const ok = await editProfileFields(profile, io, false);
		if (!ok) return false;
		edits["profiles"] = list;
	}
}

/** Outcome of a wizard run. */
export interface WizardResult {
	/** The partial config to merge, or null when the user quit without saving. */
	partial: Record<string, unknown> | null;
	/** Count of fields the user changed. */
	changed: number;
}

/**
 * Runs the menu-driven wizard. Returns the partial config to write, or a null
 * partial when the user quit (or input ended) without saving.
 */
export async function runWizard(cfg: RouterConfig, io: WizardIo): Promise<WizardResult> {
	const edits: Record<string, unknown> = {};

	for (;;) {
		io.write(renderMenu(edits));
		const choice = await io.read.next();
		if (choice === null) return { partial: null, changed: 0 };

		const answer = choice.trim().toLowerCase();

		if (answer === "q") return { partial: null, changed: 0 };

		if (answer === "s") {
			const changed = Object.keys(edits).length;
			if (changed === 0) return { partial: null, changed: 0 };
			return { partial: applyAnswers(edits), changed };
		}

		if (answer === "p") {
			const ok = await editProfiles(cfg, edits, io);
			if (!ok) return { partial: null, changed: 0 };
			continue;
		}

		if (answer === "a") {
			for (const section of WIZARD_SECTIONS) {
				const ok = await editSection(section, cfg, edits, io);
				if (!ok) return { partial: null, changed: 0 };
			}
			const ok = await editProfiles(cfg, edits, io);
			if (!ok) return { partial: null, changed: 0 };
			continue;
		}

		const index = Number(answer);
		const section = Number.isInteger(index) ? WIZARD_SECTIONS[index - 1] : undefined;
		if (section === undefined) {
			io.write(`  ! not a choice: ${choice.trim()}\n`);
			continue;
		}
		const ok = await editSection(section, cfg, edits, io);
		if (!ok) return { partial: null, changed: 0 };
	}
}

/**
 * A `LineSource` over a byte stream (stdin). Buffers chunks and splits on
 * newlines, so it behaves identically for a TTY and for piped input.
 */
export class StreamLineSource implements LineSource {
	private buffer = "";
	private ended = false;
	private readonly decoder = new TextDecoder();
	private readonly iterator: AsyncIterator<Uint8Array>;

	constructor(stream: AsyncIterable<Uint8Array>) {
		this.iterator = stream[Symbol.asyncIterator]();
	}

	async next(): Promise<string | null> {
		for (;;) {
			const newline = this.buffer.indexOf("\n");
			if (newline >= 0) {
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				return line.endsWith("\r") ? line.slice(0, -1) : line;
			}
			if (this.ended) {
				if (this.buffer.length === 0) return null;
				const rest = this.buffer;
				this.buffer = "";
				return rest;
			}
			const chunk = await this.iterator.next();
			if (chunk.done === true) {
				this.ended = true;
				continue;
			}
			this.buffer += this.decoder.decode(chunk.value, { stream: true });
		}
	}
}

/** A `LineSource` over a fixed script of answers; for tests. */
export class ScriptedLineSource implements LineSource {
	private index = 0;

	constructor(private readonly lines: readonly string[]) {}

	async next(): Promise<string | null> {
		if (this.index >= this.lines.length) return null;
		const line = this.lines[this.index] ?? null;
		this.index += 1;
		return line;
	}
}
