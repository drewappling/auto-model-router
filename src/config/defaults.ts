import type { RouterConfig } from "./types.ts";

/**
 * Built-in configuration. Layered beneath `$OMP_ROUTER_HOME/config.yml`,
 * environment variables, and CLI overrides (see `load.ts`).
 *
 * `ledger.path` is intentionally empty: `loadConfig` resolves it to
 * `$OMP_ROUTER_HOME/router.db`, which is only known at load time.
 */
export const DEFAULT_CONFIG: RouterConfig = {
	server: {
		host: "127.0.0.1",
		port: 8787,
	},
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1",
		// May stay empty: catalog and `config` work keyless; only dispatch fails.
		apiKey: "",
		title: "omp-router",
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
	filters: {
		allow: [],
		deny: [],
		// Free models are rate-limited hard enough that retries cost more than they save.
		includeFree: false,
		requireToolSupport: true,
		minTrust: 0.7,
		minTrustSamples: 12,
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
		maxAttempts: 2,
		// Never probe `hard`: the top tier has nowhere to escalate to.
		probeTiers: ["trivial", "simple", "moderate"],
		triggers: [
			"malformed_tool_args",
			"refusal",
			"empty_completion",
			"repeat_tool_call",
			"missing_expected_tool_call",
		],
		escalateOnLengthStop: false,
	},
	hysteresis: {
		holdTurns: 2,
		holdTurnsAfterEscalation: 4,
		switchMargin: 1.3,
		// OpenRouter sticky sessions expire in 5-10 minutes.
		cacheWarmTtlMs: 300_000,
		maxDowngradePerTurn: 1,
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
		{ id: "auto", name: "Auto (omp-router)", minTier: "trivial", maxTier: "hard", contextWindow: 400_000, maxTokens: 32_000 },
		{ id: "auto-cheap", name: "Auto Cheap (omp-router)", minTier: "trivial", maxTier: "simple", contextWindow: 400_000, maxTokens: 32_000 },
		{ id: "auto-max", name: "Auto Max (omp-router)", minTier: "moderate", maxTier: "hard", contextWindow: 400_000, maxTokens: 32_000 },
	],
	ledger: {
		// Resolved by loadConfig: empty ⇒ `$OMP_ROUTER_HOME/router.db`.
		path: "",
		blendWindowDays: 7,
		blendMinSamples: 25,
		// Pre-measurement blend for omp's cost display: a moderate-heavy mix.
		// Consumers publish cache tokens at the full input rate until measured,
		// so early cost reporting never underreports.
		fallbackBlend: { inputPerMtok: 1.5, outputPerMtok: 7.5 },
		conversationTtlMs: 7 * 24 * 60 * 60 * 1000,
	},
	logLevel: "info",
};
