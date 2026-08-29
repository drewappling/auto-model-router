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
	benchmarks: {
		// Keyless BenchLM alone fills real gaps, so this is on by default; the AA
		// feed only actually fires once a key is present (config or env).
		enabled: true,
		artificialAnalysisApiKey: "",
		benchlm: true,
		refreshMs: 24 * 60 * 60 * 1000,
		timeoutMs: 30_000,
		// Off: our own eval scores change routing, so they never apply until asked.
		useLocalScores: false,
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
		// Latency scoring is off by default (weight 0): opt in after establishing a
		// baseline. Expected total wait (TTFT + expected completion / throughput)
		// above the references inflates a model's effective cost.
		latencyWeight: 0,
		latencyReferenceMs: 5000,
		// 30 tok/s: below this a model streams noticeably slowly. Only genuinely
		// slow models (e.g. deepseek-v4-flash ~20 tok/s) fall under it.
		latencyReferenceTokensPerSec: 30,
		latencyMinSamples: 20,
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
		// Conservative default: never sacrifice a live prompt cache without
		// the operator choosing to. `always` is what actually reaches the
		// held population that carries the spend.
		stickyPolicy: "cold-cache",
		holdTurns: { enabled: false, values: [2, 3, 4] },
	},
	cache: {
		injectBreakpoints: true,
		// Anthropic allows 4 breakpoints; OpenRouter translates for other vendors.
		maxBreakpoints: 4,
		minPromptTokens: 2_048,
		// One slot for the system prefix, one for the tail, leaving two milestones
		// live at 4 breakpoints. 20k spacing keeps them coarse enough that a
		// milestone survives many turns of appended tool output.
		milestoneTokens: 20_000,
	},
	context: {
		// Off until an agentdox URL + token are configured. Enabling this changes
		// what every model sees, so it is never implicit.
		enabled: false,
		baseUrl: "",
		token: "",
		defaultScope: "",
		timeoutMs: 3_000,
		// Matches agentdox's own auto-context job cadence (900s): refreshing
		// faster than the server reassembles buys nothing but cache misses.
		maxStalenessMs: 900_000,
		maxBlockChars: 24_000,
		// Bound what agentdox SELECTS, rather than letting the block grow and then
		// slicing it at `maxBlockChars`. Byte truncation cuts an entry mid-sentence
		// and is blind to relevance; a limit lets the server rank first. Left
		// unbounded, this scope reached 15 memory entries = 23.5k chars (~5.9k
		// tokens) injected into every turn, against a 24k cap it was about to hit.
		memoryLimit: 8,
		// Docs are WHOLE DOCUMENTS, so they are the easiest way to blow the cap:
		// this was left unbounded and a single ashlands note-doc measured 41,921
		// chars — larger than maxBlockChars on its own, with three of them
		// assembling a 104k-char block. Bounded rather than off, because a scope
		// whose docs are genuinely short summaries benefits from them; set 0 where
		// docs mirror whole repo files (agentdox ingest does this), since the
		// content is retrievable on demand via docs_read and does not belong in
		// every prompt's prefix.
		docsLimit: 2,
		// Session messages are cheap today but grow once recordTurns is on, and
		// they feed straight back into the next assembly.
		sessionLimit: 6,
		// The project brief renders FIRST in the block (query-independent →
		// cache-friendly) but grows one entry per recorded decision, so it is
		// budgeted, not unbounded. 12k keeps the whole measured brief (8.9k across
		// statics + all 14 decisions) inside a 24k block while leaving ~15k for
		// the query-relevant memory/docs tail. 0 omits the brief.
		briefChars: 12_000,
		recordTurns: true,
		maxQueue: 64,
	},
	compaction: {
		// Off by default: shrinking context is behavior-changing, never implicit.
		enabled: false,
		// ~40k tokens: above this the prompt is dominated by re-sent tool output.
		budgetTokens: 40_000,
		// Once compaction fires, compact down to this fraction of the budget
		// instead of stopping just under it. Below 1 the plan overshoots and then
		// holds for several turns; at 1 it gains an edit almost every turn, and
		// every plan change rewrites already-cached prompt bytes.
		//
		// Measured (tools/verify-plan-persist.ts, 20-turn agentic conversation):
		// 1.0 changes the plan on 10 of 10 compacting turns, 0.75 on 3, 0.6 on 2.
		// Live ledger: a changed-plan dispatch runs 15.4% cold vs 8.9% when the
		// plan holds, and a cold prompt costs 4.34x a warm one per token.
		//
		// Ships at 1 because elision is lossy and compaction is never implicit
		// here — the same reason `enabled` is false. 0.75 is the recommended
		// setting once a deployment has watched its own ledger.
		floorRatio: 1,
		fitToWindow: true,
		protectRecentTurns: 4,
		maxToolResultBytes: 4_096,
		keepHeadBytes: 512,
		keepTailBytes: 512,
		elideSupersededReads: true,
		collapseDuplicateResults: true,
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
	// Off by default: fixed per-tier ceilings ship as the baseline. Enable to make
	// price ceilings self-tune to the key's catalog (see RouterConfig doc).
	adaptivePriceCeilings: false,
	logLevel: "info",
};
