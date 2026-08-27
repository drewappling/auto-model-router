import { z } from "zod";

/**
 * Input schema for `$AUTO_MODEL_ROUTER_HOME/config.yml`: a deep partial of
 * `RouterConfig` — every field is optional so the file carries only
 * overrides. Nested objects are strict so a misspelled key fails loudly
 * instead of being silently dropped.
 *
 * Array fields (`profiles`, `probeTiers`, `pin`, `allow`, `deny`,
 * `triggers`) REPLACE the default wholesale on merge; consequently a
 * `profiles` entry must be complete — there is nothing to merge it with.
 */

const tier = z.enum(["trivial", "simple", "moderate", "hard"]);
const qualityAxis = z.enum(["coding", "agentic", "intelligence"]);
const logLevel = z.enum(["silent", "error", "warn", "info", "debug"]);

const server = z.strictObject({
	host: z.string().min(1).optional(),
	port: z.number().int().min(0).max(65_535).optional(),
	apiKey: z.string().optional(),
	harnessId: z.string().optional(),
});

const openrouter = z.strictObject({
	baseUrl: z.string().min(1).optional(),
	apiKey: z.string().optional(),
	referer: z.string().optional(),
	title: z.string().optional(),
	timeoutMs: z.number().positive().optional(),
	catalogTtlMs: z.number().positive().optional(),
	catalogRefreshMs: z.number().nonnegative().optional(),
});

const benchmarks = z.strictObject({
	enabled: z.boolean().optional(),
	artificialAnalysisApiKey: z.string().optional(),
	benchlm: z.boolean().optional(),
	refreshMs: z.number().nonnegative().optional(),
	timeoutMs: z.number().positive().optional(),
	useLocalScores: z.boolean().optional(),
});

const tierConfig = z.strictObject({
	minQuality: z.number().min(0).max(100).optional(),
	maxInputPerMtok: z.number().nonnegative().optional(),
	maxOutputPerMtok: z.number().nonnegative().optional(),
	qualityExponent: z.number().nonnegative().optional(),
	pin: z.array(z.string()).optional(),
});

const taskConfig = z.strictObject({
	axis: qualityAxis.optional(),
	minQuality: z.number().min(0).max(100).optional(),
	requireImage: z.boolean().optional(),
	prefer: z.array(z.string()).optional(),
});

const filters = z.strictObject({
	allow: z.array(z.string()).optional(),
	deny: z.array(z.string()).optional(),
	includeFree: z.boolean().optional(),
	requireToolSupport: z.boolean().optional(),
	minTrust: z.number().min(0).max(1).optional(),
	minTrustSamples: z.number().int().nonnegative().optional(),
	trustScopedByHarness: z.boolean().optional(),
	contextHeadroom: z.number().positive().optional(),
});

const classifier = z.strictObject({
	ambiguityThreshold: z.number().min(0).max(1).optional(),
	model: z.string().min(1).optional(),
	maxCostFraction: z.number().min(0).max(1).optional(),
	maxCostUsd: z.number().nonnegative().optional(),
	timeoutMs: z.number().positive().optional(),
	cacheSize: z.number().int().nonnegative().optional(),
	toolAxis: qualityAxis.optional(),
	chatAxis: qualityAxis.optional(),
	agenticLoopDepth: z.number().int().nonnegative().optional(),
});

const escalation = z.strictObject({
	enabled: z.boolean().optional(),
	probeTokens: z.number().int().positive().optional(),
	maxHoldMs: z.number().positive().optional(),
	maxAttempts: z.number().int().positive().optional(),
	probeTiers: z.array(tier).optional(),
	triggers: z.array(z.string()).optional(),
	escalateOnLengthStop: z.boolean().optional(),
});

const hysteresis = z.strictObject({
	holdTurns: z.number().int().nonnegative().optional(),
	holdTurnsAfterEscalation: z.number().int().nonnegative().optional(),
	switchMargin: z.number().positive().optional(),
	cacheWarmTtlMs: z.number().nonnegative().optional(),
	maxDowngradePerTurn: z.number().int().nonnegative().optional(),
});

const exploration = z.strictObject({
	enabled: z.boolean().optional(),
	// Spelled out per tier rather than z.record so an unknown tier name is a
	// config error instead of a silently ignored key.
	rates: z
		.strictObject({
			trivial: z.number().min(0).max(1).optional(),
			simple: z.number().min(0).max(1).optional(),
			moderate: z.number().min(0).max(1).optional(),
			hard: z.number().min(0).max(1).optional(),
		})
		.optional(),
	stickyPolicy: z.enum(["never", "cold-cache", "always"]).optional(),
	holdTurns: z
		.strictObject({
			enabled: z.boolean().optional(),
			// Non-empty and positive: an empty set or a 0 would silently disable
			// the experiment while reading as enabled.
			values: z.array(z.number().int().positive()).min(1).optional(),
		})
		.optional(),
});
const cache = z.strictObject({
	injectBreakpoints: z.boolean().optional(),
	maxBreakpoints: z.number().int().positive().optional(),
	minPromptTokens: z.number().int().nonnegative().optional(),
});

const budget = z.strictObject({
	perTurnUsd: z.number().nonnegative().optional(),
	perConversationUsd: z.number().nonnegative().optional(),
	perDayUsd: z.number().nonnegative().optional(),
	onExceeded: z.enum(["downgrade", "reject"]).optional(),
});

const fallbackBlend = z.strictObject({
	inputPerMtok: z.number().nonnegative().optional(),
	outputPerMtok: z.number().nonnegative().optional(),
});

const ledger = z.strictObject({
	path: z.string().optional(),
	blendWindowDays: z.number().positive().optional(),
	blendMinSamples: z.number().int().nonnegative().optional(),
	fallbackBlend: fallbackBlend.optional(),
	conversationTtlMs: z.number().positive().optional(),
});

// Complete entries: arrays replace wholesale, so a partial profile would
// produce an invalid resolved config.
const profile = z.strictObject({
	id: z.string().min(1),
	name: z.string().min(1),
	maxTier: tier,
	minTier: tier,
	contextWindow: z.number().int().positive(),
	maxTokens: z.number().int().positive(),
	budget: budget.optional(),
});

export const configInputSchema = z.strictObject({
	server: server.optional(),
	openrouter: openrouter.optional(),
	benchmarks: benchmarks.optional(),
	tiers: z
		.strictObject({
			trivial: tierConfig.optional(),
			simple: tierConfig.optional(),
			moderate: tierConfig.optional(),
			hard: tierConfig.optional(),
		})
		.optional(),
	tasks: z
		.strictObject({
			coding: taskConfig.optional(),
			vision: taskConfig.optional(),
			documentation: taskConfig.optional(),
			data: taskConfig.optional(),
			chat: taskConfig.optional(),
		})
		.optional(),
	filters: filters.optional(),
	classifier: classifier.optional(),
	escalation: escalation.optional(),
	hysteresis: hysteresis.optional(),
	exploration: exploration.optional(),
	cache: cache.optional(),
	budget: budget.optional(),
	profiles: z.array(profile).optional(),
	ledger: ledger.optional(),
	adaptiveTierFloors: z.boolean().optional(),
	adaptivePriceCeilings: z.boolean().optional(),
	logLevel: logLevel.optional(),
});

export type ConfigInput = z.infer<typeof configInputSchema>;
