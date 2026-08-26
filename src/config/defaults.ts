import type { RouterConfig } from "./types.ts";

/**
 * Built-in configuration. Layered beneath `$AUTO_MODEL_ROUTER_HOME/config.yml`,
 * environment variables, and CLI overrides (see `load.ts`).
 *
 * `ledger.path` is intentionally empty: `loadConfig` resolves it to
 * `$AUTO_MODEL_ROUTER_HOME/router.db`, which is only known at load time.
 */
export const DEFAULT_CONFIG: RouterConfig = {
	server: {
		host: "127.0.0.1",
		port: 8788,
	},
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1",
		// May stay empty: catalog and `config` work keyless; only dispatch fails.
		apiKey: "",
		title: "auto-model-router",
		// Agent turns are long; a frontier model with tools can stream for minutes.
		timeoutMs: 600_000,
		catalogTtlMs: 6 * 60 * 60 * 1000,
		// Refetch the key-scoped catalog every 5 minutes in the background so
		// guardrail changes are picked up without waiting for traffic + TTL.
		catalogRefreshMs: 5 * 60 * 1000,
	},
	tiers: {
		// minQuality 0 ⇒ unscored models are eligible here; the floor does the
		// quality work on every other tier (qualityExponent 0 ⇒ cheapest above floor).
		trivial: { minQuality: 0, maxInputPerMtok: 0.3, qualityExponent: 0, pin: [] },
		simple: { minQuality: 40, maxInputPerMtok: 1.5, qualityExponent: 0, pin: [] },
		moderate: { minQuality: 60, maxInputPerMtok: 4.0, qualityExponent: 1, pin: [] },
		// No price ceiling on `hard`: quality is the point of the top tier.
		hard: { minQuality: 72, qualityExponent: 3, pin: [] },
	},
	tasks: {
		// Task selects the axis + capability; the tier's quality floor, price
		// ceiling, and budget guard still govern cost. A task minQuality only
		// RAISES the tier floor for special cases (e.g. vision needs quality);
		// it must not force cheap tiers to be expensive, or escalation has no
		// room to move.
		coding: { axis: "coding" },
		vision: { axis: "intelligence", requireImage: true },
		documentation: { axis: "intelligence" },
		data: { axis: "intelligence" },
		chat: { axis: "intelligence" },
	},
	filters: {
		allow: [],
		deny: [],
		// Free models are rate-limited hard enough that retries cost more than they save.
		includeFree: false,
		requireToolSupport: true,
		minTrust: 0.7,
		minTrustSamples: 12,
		// Shared trust by default: more samples, demotion guard stays effective
		// even with a tiny guardrail-narrowed catalog.
		trustScopedByHarness: false,
		contextHeadroom: 1.25,
	},
	classifier: {
		ambiguityThreshold: 0.6,
		// Cheapest competent slug in the catalog; adjudication prompts are tiny.
		model: "qwen/qwen3.7-flash",
		maxCostFraction: 0.02,
		maxCostUsd: 0.002,
		timeoutMs: 4_000,
		cacheSize: 512,
		toolAxis: "coding",
		chatAxis: "intelligence",
		agenticLoopDepth: 3,
	},
	escalation: {
		enabled: true,
		probeTokens: 48,
		maxHoldMs: 8_000,
		// 3 attempts = the original try plus two retries: enough runway for a
		// probe-driven escalation AND a same-tier failover on an upstream error.
		// Each attempt beyond the first can abandon already-generated tokens, so
		// this is the direct dial between turn reliability and wasted spend.
		maxAttempts: 3,
		// Never probe `hard`: the top tier has nowhere to escalate to.
		probeTiers: ["trivial", "simple", "moderate"],
		triggers: [
			"malformed_tool_args",
			"refusal",
			"empty_completion",
			"repeat_tool_call",
			"missing_expected_tool_call",
		],
		// Scoped to the case it can actually fix: a `length` finish that truncated
		// tool-call arguments leaves unusable output, and another model may emit a
		// well-formed call before the cap. A length finish on prose does NOT
		// escalate — that is the caller's own max_tokens, and the retry truncates
		// in the same place, so escalating just bills twice for one truncation.
		escalateOnLengthStop: true,
	},
	hysteresis: {
		holdTurns: 2,
		holdTurnsAfterEscalation: 4,
		switchMargin: 1.3,
		// OpenRouter sticky sessions expire in 5-10 minutes.
		cacheWarmTtlMs: 300_000,
		maxDowngradePerTurn: 1,
	},
	exploration: {
		// Opt-in. Exploration knowingly routes some turns below the tier that
		// would otherwise be used; escalation bounds the damage, but it is
		// still a real cost paid on real traffic.
		enabled: false,
		// Weighted by scarcity and by spend, not uniformly: `simple` turns are
		// abundant and cheap to be wrong about, `hard` turns are rare and hold
		// most of the money, so they need a far higher rate to yield any
		// sample at all within a useful number of days.
		rates: { simple: 0.03, moderate: 0.15, hard: 0.2 },
		exploreStickyWhenCacheCold: true,
	},
	cache: {
		injectBreakpoints: true,
		// Anthropic allows 4 breakpoints; OpenRouter translates for other vendors.
		maxBreakpoints: 4,
		minPromptTokens: 2_048,
	},
	budget: {
		// No caps by default; at a configured ceiling, downgrade rather than fail.
		onExceeded: "downgrade",
	},
	profiles: [
		{ id: "auto", name: "Auto (auto-model-router)", minTier: "trivial", maxTier: "hard", contextWindow: 400_000, maxTokens: 32_000 },
		{ id: "auto-cheap", name: "Auto Cheap (auto-model-router)", minTier: "trivial", maxTier: "simple", contextWindow: 400_000, maxTokens: 32_000 },
		{ id: "auto-max", name: "Auto Max (auto-model-router)", minTier: "moderate", maxTier: "hard", contextWindow: 400_000, maxTokens: 32_000 },
	],
	ledger: {
		// Resolved by loadConfig: empty ⇒ `$AUTO_MODEL_ROUTER_HOME/router.db`.
		path: "",
		blendWindowDays: 7,
		blendMinSamples: 25,
		// Pre-measurement blend for omp's cost display: a moderate-heavy mix.
		// Consumers publish cache tokens at the full input rate until measured,
		// so early cost reporting never underreports.
		fallbackBlend: { inputPerMtok: 1.5, outputPerMtok: 7.5 },
		conversationTtlMs: 7 * 24 * 60 * 60 * 1000,
	},
	// On by default: an absolute floor that no available model meets is how the
	// router ends up serving every turn from the cheapest tier.
	adaptiveTierFloors: true,
	logLevel: "info",
};
