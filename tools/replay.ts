/**
 * Offline decision replay — re-run REAL routing over recorded ledger rows.
 *
 * Every routing change is behavior-changing and cost-relevant, so the standing
 * rule is to validate on the ledger before enabling. This is the tool for that:
 * it feeds recorded `features` back through the real `scoreHeuristic` and
 * `select`, under two config variants, and diffs the decisions.
 *
 *   bun tools/replay.ts --limit 500
 *   bun tools/replay.ts --set tiers.hard.minQuality=70
 *   bun tools/replay.ts --set hysteresis.switchHorizonTurns=8 --verbose
 *   bun tools/replay.ts --where "task='coding'" --set classifier.ambiguityThreshold=0
 *   bun tools/replay.ts --warmth recorded          # the pre-2026-09-07 warmth model
 *
 * `--set` overrides variant B; `--a` overrides the baseline too (default:
 * config as it currently stands on disk). Read-only: opens the ledger DB
 * readonly and never writes.
 *
 * WHAT IT MODELS FAITHFULLY
 *  - The recorded `features` blob is the exact classifier input from that turn,
 *    so no re-tokenization or re-derivation is involved.
 *  - The real catalog is hydrated from `catalog_cache` (OpenRouter) and
 *    `ollama_catalog_cache` (Ollama Cloud, when `ollama.enabled`) and merged
 *    exactly as `composite.ts` does, with each variant's own `ollama.costBias`
 *    stamped on its snapshot. No network.
 *  - The real `Ledger` supplies trust and latency, so the trust divisor and the
 *    throughput multiplier behave as they do live.
 *  - `explorationDraw` keys on `conversationKey:turn`, both recorded, so
 *    exploration reproduces deterministically and cancels out in a diff.
 *  - Escalations are replayed AS RECORDED: a served attempt > 0 routes with
 *    `escalateFrom` set to the tier of the probe-rejected attempt before it
 *    and `excludeSlugs` set to the slugs that failed, exactly as `turn.ts`
 *    calls `route()`. Hold re-arming uses the escalated hold length. What
 *    replay cannot do is decide whether a VARIANT's cheaper pick would have
 *    escalated — the probe needs the streamed output — so an escalation that
 *    happened stays happened in both variants.
 *
 * CACHE WARMTH (the part that makes switch policy measurable)
 *  - `--warmth variant` (default): each variant carries its OWN previous
 *    decision. The model it chose last turn is the warm one, and a dispatch is
 *    priced warm only when the variant stays on it within `cacheWarmTtlMs`,
 *    with the previous prompt as the cached prefix (the same rule
 *    `cache-estimate.ts` applies to Ollama). A variant that switches pays the
 *    cold read. This is what lets `switchMargin`, `switchHorizonTurns`,
 *    `confirmUpgradesBelowConfidence` and the hold lengths be priced.
 *  - `--warmth recorded`: warmth comes from the recorded outcome (what the
 *    previous dispatch actually served and cached). Keeps replay error from
 *    compounding down a conversation, but prices every variant's switch as if
 *    the cache followed it, so switch policies show as no-ops.
 *
 * WHAT IT DOES NOT MODEL — read this before trusting a conclusion
 *  - `messages` are not recorded, so compaction cannot be re-planned. Replay
 *    forces `compaction.enabled=false` and feeds the POST-compaction prompt
 *    size (`usage.promptTokens`), i.e. the prompt selection actually saw.
 *  - The credit-aware Ollama bias is replayed at the CONFIGURED `costBias`,
 *    not the usage-dependent effective bias that was live at the time.
 *  - Module constants are not config, so things like CAP_AUTONOMOUS_LOOP cannot
 *    be A/B'd via `--set` — only `RouterConfig` paths can.
 *
 * FIDELITY LINE. "same model N/M" compares variant A against what actually
 * ran. Divergence is expected where code has changed since those rows were
 * served (replay runs CURRENT code); the rest is what replay cannot model.
 */

import { Database } from "bun:sqlite";

import { loadOllamaCatalogCache, mergeSnapshots } from "../src/catalog/ollama-catalog.ts";
import { createCatalog } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot } from "../src/catalog/types.ts";
import { loadConfig } from "../src/config/load.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { computeCost } from "../src/cost/forecast.ts";
import { createLedger } from "../src/cost/ledger.ts";
import type { UsageCounts } from "../src/cost/types.ts";
import { classifyTask, scoreHeuristic } from "../src/router/classify.ts";
import { resolveHoldTurns } from "../src/router/explore.ts";
import { select } from "../src/router/select.ts";
import { TIER_ORDER, type Classification, type ConversationState, type Decision, type Features, type Tier } from "../src/router/types.ts";
import type { UpstreamClient } from "../src/upstream/types.ts";
import type { NormMessage, NormRequest, NormTool } from "../src/wire/types.ts";

interface Args {
	limit: number;
	where: string;
	setB: string[];
	setA: string[];
	verbose: boolean;
	db: string;
	warmth: "variant" | "recorded";
}

function parseArgs(argv: string[]): Args {
	const a: Args = { limit: 500, where: "", setB: [], setA: [], verbose: false, db: "", warmth: "variant" };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		const v = argv[i + 1];
		if (k === "--limit" && v !== undefined) (a.limit = Number.parseInt(v, 10)), i++;
		else if (k === "--where" && v !== undefined) (a.where = v), i++;
		else if (k === "--set" && v !== undefined) (a.setB.push(v), i++);
		else if (k === "--a" && v !== undefined) (a.setA.push(v), i++);
		else if (k === "--db" && v !== undefined) (a.db = v), i++;
		else if (k === "--warmth" && (v === "variant" || v === "recorded")) (a.warmth = v), i++;
		else if (k === "--verbose") a.verbose = true;
	}
	return a;
}

/** Coerce a CLI string to the JSON-ish type the config field expects. */
function coerce(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (raw === "null") return null;
	const n = Number(raw);
	if (raw.trim() !== "" && !Number.isNaN(n)) return n;
	return raw;
}

/** Applies `a.b.c=value` overrides onto a deep clone, so variants never alias. */
function withOverrides(cfg: RouterConfig, sets: readonly string[]): RouterConfig {
	const next = structuredClone(cfg);
	for (const entry of sets) {
		const eq = entry.indexOf("=");
		if (eq < 0) throw new Error(`--set expects path=value, got: ${entry}`);
		const path = entry.slice(0, eq).split(".");
		const value = coerce(entry.slice(eq + 1));
		let node: Record<string, unknown> = next as unknown as Record<string, unknown>;
		for (const seg of path.slice(0, -1)) {
			const child = node[seg];
			if (typeof child !== "object" || child === null) throw new Error(`--set path not found: ${entry}`);
			node = child as Record<string, unknown>;
		}
		const leaf = path[path.length - 1];
		if (leaf === undefined) throw new Error(`--set expects a key, got: ${entry}`);
		// An absent leaf is legitimate and required: optional config fields are
		// simply missing until set (exactOptionalPropertyTypes), and introducing
		// one is exactly what a variant does. A wrong PARENT path still throws,
		// in the walk above, which is what catches typos.
		node[leaf] = value;
	}
	return next;
}

interface Row {
	id: string;
	conversation_key: string;
	turn: number;
	attempt: number;
	wasted: number;
	escalation_signal: string | null;
	requested_model: string;
	harness_id: string;
	slug: string;
	served_slug: string | null;
	tier: string;
	features: string;
	usage: string;
	reported_usd: number | null;
	predicted_usd: number;
	created_at_ms: number;
	error_kind: string | null;
}

/**
 * Rebuilds the classifier input from the recorded blob.
 *
 * `requestedReasoning` IS recorded (JSON.stringify only drops it when the client
 * sent no level), and it must be used: it is worth up to +0.34 of score, rides
 * on ~42% of dispatches, and forcing it to undefined — as this did, on the
 * assumption the ledger omitted it — under-scored every one of those rows.
 * Measured effect of the bug: replay reproduced 27 hard-tier decisions against
 * 120 actually served, i.e. it silently biased every comparison toward cheaper
 * tiers and made reasoning-weight changes look like no-ops.
 */
function featuresOf(row: Row, promptTokens: number): Features {
	const f = JSON.parse(row.features) as Partial<Features>;
	return { ...(f as Features), promptTokens };
}

/**
 * Minimal request carrying only what `select`/`buildCandidates` read: tool count
 * and schema bytes, image presence, harness id (trust/latency scoping),
 * conversation key and profile id.
 */
function requestOf(row: Row, f: Features): NormRequest {
	const perTool = f.toolCount > 0 ? Math.round(f.toolSchemaBytes / f.toolCount) : 0;
	const tools: NormTool[] = Array.from({ length: f.toolCount }, (_v, i) => ({
		name: `t${i}`,
		description: "",
		schemaBytes: perTool,
	}));
	const messages: NormMessage[] = [
		{ role: "user", text: "", images: f.hasImages ? 1 : 0, textBytes: f.promptTokens * 4, toolCalls: [] },
	];
	return {
		protocol: "openai-chat",
		conversationKey: row.conversation_key,
		harnessId: row.harness_id,
		ompSessionId: "",
		agentdoxScope: "",
		isSubagent: false,
		requestedModel: row.requested_model,
		messages,
		tools,
		forcedToolChoice: false,
		stream: true,
		hasImages: f.hasImages,
		promptBytes: f.promptTokens * 4,
		renderUpstreamBody: () => ({}),
	};
}

/** The recorded outcome of a conversation's previous dispatch. */
interface PriorTurn {
	slug: string | null;
	tier: string;
	promptTokens: number;
	cachedTokens: number;
	spentUsd: number;
	atMs: number;
}

/**
 * A variant's own trail through a conversation: the model it chose last, the
 * prompt it saw, the tier it holds and until when, and the upgrade it deferred.
 * Evolved PER VARIANT, because every one of these follows from the variant's
 * own decisions; reading them from the recorded outcome would charge a variant
 * for holds and caches it never created and hide the switches it made.
 */
interface VariantTrail {
	slug: string | null;
	promptTokens: number;
	atMs: number;
	tier: Tier | null;
	stickyUntilTurn: number;
	upgradeDeferredTier: Tier | null;
}

function stateOf(row: Row, prior: PriorTurn | undefined, trail: VariantTrail | undefined, warmth: Args["warmth"]): ConversationState {
	const warmSlug = warmth === "variant" ? (trail?.slug ?? null) : prior?.cachedTokens !== undefined && prior.cachedTokens > 0 ? prior.slug : null;
	return {
		key: row.conversation_key,
		sessionId: `omp-${row.conversation_key}`,
		// `turn.ts` computes turnNumber = state.turn + 1 and records THAT, so the
		// state `select` sees carries the PREVIOUS turn number. Passing row.turn
		// would expire every hold a turn early.
		turn: row.turn - 1,
		currentSlug: warmth === "variant" ? (trail?.slug ?? null) : (prior?.slug ?? null),
		currentTier: trail?.tier ?? ((prior?.tier as Tier | undefined) ?? null),
		stickyUntilTurn: trail?.stickyUntilTurn ?? 0,
		escalations: 0,
		spentUsd: prior?.spentUsd ?? 0,
		lastPromptTokens: warmth === "variant" ? (trail?.promptTokens ?? 0) : (prior?.promptTokens ?? 0),
		cacheWarmSlug: warmSlug,
		cacheWarmAtMs: warmth === "variant" ? (trail?.atMs ?? 0) : (prior?.atMs ?? 0),
		contextVersion: null,
		contextFetchedAtMs: 0,
		// Compaction cannot be replanned offline (messages are not recorded), so
		// replay carries no plan: forced off in the config it replays under.
		compactionPlan: null,
		upgradeDeferredTier: trail?.upgradeDeferredTier ?? null,
		updatedAtMs: warmth === "variant" ? (trail?.atMs ?? 0) : (prior?.atMs ?? 0),
	};
}

/**
 * Re-prices a decision against the tokens the turn ACTUALLY used, via the real
 * `computeCost`, with the cache split decided by the warmth model: under
 * `variant` warmth a dispatch is warm only when the variant stayed on its own
 * previous model within the TTL, and the previous prompt is the cached prefix.
 *
 * Deliberately NOT the router's own forecast: `candidates.ts` hardcodes
 * `cacheHitRate: 0`, so forecasts overstate absolute cost ~2.8x. Pricing both
 * variants off recorded usage keeps the delta apples-to-apples and grounded.
 */
function repriceUsd(
	model: CatalogModel | undefined,
	usage: UsageCounts,
	warm: boolean,
	prevPromptTokens: number,
	recordedSlug: string | null,
): { usd: number; cold: boolean } {
	if (model === undefined) return { usd: 0, cold: false };
	if (!warm) {
		return { usd: computeCost(model, { ...usage, cachedTokens: 0, cacheWriteTokens: 0 }).total, cold: true };
	}
	// Warm: the recorded cache count when the recorded dispatch was this very
	// model (the provider's own figure), else the previous prompt as prefix.
	const cached = recordedSlug === model.slug && usage.cachedTokens > 0 ? usage.cachedTokens : Math.min(prevPromptTokens, usage.promptTokens);
	return { usd: computeCost(model, { ...usage, cachedTokens: cached, cacheWriteTokens: 0 }).total, cold: false };
}

const DEAD_UPSTREAM: UpstreamClient = {
	dispatch: () => Promise.reject(new Error("replay is offline")),
	complete: () => Promise.reject(new Error("replay is offline")),
	fetchModels: () => Promise.reject(new Error("replay is offline")),
	fetchModelsForUser: () => Promise.reject(new Error("replay is offline")),
};

const args = parseArgs(process.argv.slice(2));
const baseCfg = await loadConfig();
// Compaction cannot be re-planned without messages; see the header.
const forced = ["compaction.enabled=false"];
const cfgA = withOverrides(baseCfg, [...forced, ...args.setA]);
const cfgB = withOverrides(baseCfg, [...forced, ...args.setB]);

const dbPath = args.db !== "" ? args.db : baseCfg.ledger.path;
const db = new Database(dbPath, { readonly: true });
const catalog = createCatalog(cfgA, DEAD_UPSTREAM, db);
const openrouterSnapshot = catalog.peek();
if (openrouterSnapshot === null) {
	console.error(`no cached catalog in ${dbPath}; run the router once so it populates catalog_cache`);
	process.exit(2);
}
const ollamaCache = loadOllamaCatalogCache(db);

/** The composite snapshot a variant routes over, with its own Ollama bias stamped on. */
function snapshotFor(cfg: RouterConfig): CatalogSnapshot {
	if (!cfg.ollama.enabled || ollamaCache.models.length === 0) return openrouterSnapshot as CatalogSnapshot;
	return { ...mergeSnapshots(openrouterSnapshot as CatalogSnapshot, ollamaCache.models), providerBias: { ollama: cfg.ollama.costBias } };
}
const snapshotA = snapshotFor(cfgA);
const snapshotB = snapshotFor(cfgB);
const bySlug = new Map([...snapshotA.models, ...snapshotB.models].map((m) => [m.slug, m]));
const ledger = createLedger(db, cfgA);

const predicate = args.where === "" ? "" : ` AND (${args.where})`;
// Newest-first to honour --limit, then flipped to chronological so each row can
// see the dispatch that preceded it in its conversation. Wasted attempts ride
// along so a served attempt > 0 can see what it escalated from.
const rows = (
	db
		.query(
			`SELECT id, conversation_key, turn, attempt, wasted, escalation_signal, requested_model, harness_id, slug, served_slug, tier, features, usage, reported_usd, predicted_usd, created_at_ms, error_kind
			 FROM ledger
			 WHERE features IS NOT NULL${predicate}
			 ORDER BY created_at_ms DESC LIMIT ?`,
		)
		.all(args.limit) as Row[]
).reverse();

if (rows.length === 0) {
	console.error("no rows matched; widen --where or --limit");
	process.exit(2);
}

/** Profile resolution mirrors router/index.ts, which does not export it. */
function profileOf(cfg: RouterConfig, requested: string) {
	const exact = cfg.profiles.find((p) => p.id === requested);
	if (exact !== undefined) return exact;
	const first = cfg.profiles[0];
	if (first === undefined) throw new Error("no router profiles configured");
	return first;
}

/** The escalation context `turn.ts` would have passed to `route()` for a served attempt > 0. */
interface EscalationContext {
	escalateFrom: Tier | undefined;
	excludeSlugs: string[];
}

interface Outcome {
	tier: Tier;
	slug: string;
	usd: number;
	cold: boolean;
	switched: boolean;
	held: boolean;
	trail: VariantTrail;
}

function run(
	cfg: RouterConfig,
	snapshot: CatalogSnapshot,
	row: Row,
	usage: UsageCounts,
	prior: PriorTurn | undefined,
	trail: VariantTrail | undefined,
	esc: EscalationContext,
): Outcome {
	const f = featuresOf(row, usage.promptTokens);
	const req = requestOf(row, f);
	const state = stateOf(row, prior, trail, args.warmth);
	let classification: Classification;
	if (esc.escalateFrom !== undefined) {
		// Mirrors router/index.ts: an escalation forces strictly upward.
		const nextIdx = Math.min(TIER_ORDER.indexOf(esc.escalateFrom) + 1, TIER_ORDER.length - 1);
		const forcedTier = TIER_ORDER[nextIdx] ?? esc.escalateFrom;
		classification = {
			tier: forcedTier,
			task: classifyTask(f),
			confidence: 1,
			source: "escalation",
			score: 1,
			reasons: [`escalated from ${esc.escalateFrom} after attempt ${row.attempt - 1} was rejected`],
		};
	} else {
		classification = scoreHeuristic(f, cfg);
	}
	const decision: Decision = select({
		req,
		features: f,
		classification,
		profile: profileOf(cfg, row.requested_model),
		state,
		snapshot,
		ledger,
		cfg,
		// The row's own clock: cache warmth and hold windows are judged against
		// when the turn happened, not against today. Passing Date.now() here made
		// every replayed cache cold and every switch policy a no-op.
		nowMs: row.created_at_ms,
		...(esc.excludeSlugs.length === 0 ? {} : { excludeSlugs: esc.excludeSlugs }),
	});

	// Re-arm exactly as turn.ts does: only when the served tier CHANGED, because
	// re-arming every turn extends the window forever and the router then never
	// downgrades. Only a dispatch that reaches the COMMIT path re-arms: an
	// aborted one never gets there, and 27% of rows abort (omp closing the
	// stream once it has the tool calls). Re-arming on those inflated the hold
	// count roughly 4x against what production recorded.
	const committed = row.error_kind === null;
	const escalated = esc.escalateFrom !== undefined;
	const tierChanged = committed && (trail?.tier ?? null) !== decision.tier;
	const nextTier = committed ? decision.tier : (trail?.tier ?? null);
	const stickyUntilTurn = tierChanged ? row.turn + resolveHoldTurns(cfg, row.conversation_key, escalated).turns : (trail?.stickyUntilTurn ?? 0);

	const prevSlug = args.warmth === "variant" ? (trail?.slug ?? null) : (prior?.slug ?? null);
	const prevPrompt = args.warmth === "variant" ? (trail?.promptTokens ?? 0) : (prior?.promptTokens ?? 0);
	const prevAt = args.warmth === "variant" ? (trail?.atMs ?? 0) : (prior?.atMs ?? 0);
	const warm = prevSlug === decision.slug && prevPrompt > 0 && row.created_at_ms - prevAt <= cfg.hysteresis.cacheWarmTtlMs;
	const priced = repriceUsd(bySlug.get(decision.slug), usage, warm, prevPrompt, row.served_slug);

	return {
		tier: decision.tier,
		slug: decision.slug,
		usd: priced.usd,
		cold: priced.cold,
		switched: prevSlug !== null && prevSlug !== decision.slug,
		held: decision.classification.source === "sticky",
		trail: {
			slug: decision.slug,
			promptTokens: usage.promptTokens,
			atMs: row.created_at_ms,
			tier: nextTier,
			stickyUntilTurn,
			upgradeDeferredTier: decision.upgradeDeferred,
		},
	};
}

interface Tally {
	slugs: Map<string, number>;
	tiers: Map<string, number>;
	usd: number;
	switches: number;
	switchUsd: number;
	cold: number;
	held: number;
	deferred: number;
}
const tally = (): Tally => ({ slugs: new Map(), tiers: new Map(), usd: 0, switches: 0, switchUsd: 0, cold: 0, held: 0, deferred: 0 });
const A = tally();
const B = tally();
const REC = tally();
let fidelitySlug = 0;
let fidelityTier = 0;
let comparable = 0;
let escalationsReplayed = 0;
const flips: { id: string; tier: string; from: string; to: string; delta: number }[] = [];
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

// Carries the RECORDED outcome of each conversation's previous served dispatch
// forward (spend, tier), plus each variant's own trail.
const priorByConv = new Map<string, PriorTurn>();
const trailA = new Map<string, VariantTrail>();
const trailB = new Map<string, VariantTrail>();
// Wasted attempts of the turn being replayed, keyed by conversation:turn.
const wastedByTurn = new Map<string, Row[]>();

for (const row of rows) {
	const turnKey = `${row.conversation_key}:${row.turn}`;
	if (row.wasted === 1) {
		const list = wastedByTurn.get(turnKey) ?? [];
		list.push(row);
		wastedByTurn.set(turnKey, list);
		continue;
	}
	const u = JSON.parse(row.usage) as UsageCounts;
	if (!(u.promptTokens > 0)) continue;
	const prior = priorByConv.get(row.conversation_key);
	// Escalation context as turn.ts would have passed it: the last probe-rejected
	// attempt's tier, and every failed attempt's slug excluded.
	const wasted = (wastedByTurn.get(turnKey) ?? []).filter((w) => w.attempt < row.attempt);
	const rejected = wasted.filter((w) => w.escalation_signal !== null);
	const esc: EscalationContext = {
		escalateFrom: rejected.length > 0 ? (rejected[rejected.length - 1]!.tier as Tier) : undefined,
		excludeSlugs: wasted.map((w) => w.served_slug ?? w.slug),
	};
	if (esc.escalateFrom !== undefined) escalationsReplayed++;
	const a = run(cfgA, snapshotA, row, u, prior, trailA.get(row.conversation_key), esc);
	const b = run(cfgB, snapshotB, row, u, prior, trailB.get(row.conversation_key), esc);
	trailA.set(row.conversation_key, a.trail);
	trailB.set(row.conversation_key, b.trail);

	const recordedSwitch = prior?.slug !== undefined && prior.slug !== null && row.served_slug !== null && prior.slug !== row.served_slug;
	const recordedUsd = row.reported_usd ?? row.predicted_usd;
	priorByConv.set(row.conversation_key, {
		slug: row.served_slug,
		tier: row.tier,
		promptTokens: u.promptTokens,
		cachedTokens: u.cachedTokens,
		spentUsd: (prior?.spentUsd ?? 0) + recordedUsd,
		atMs: row.created_at_ms,
	});

	for (const [t, o] of [
		[A, a],
		[B, b],
	] as const) {
		bump(t.slugs, o.slug);
		bump(t.tiers, o.tier);
		t.usd += o.usd;
		if (o.switched) {
			t.switches++;
			t.switchUsd += o.usd;
		}
		if (o.cold) t.cold++;
		if (o.held) t.held++;
		if (o.trail.upgradeDeferredTier !== null) t.deferred++;
	}
	// The recorded outcome: what the router ACTUALLY did, under whatever code and
	// config were live then. This is the yardstick for fidelity, and it is also
	// how a shipped classifier change shows up — replay runs current code.
	if (row.served_slug !== null) bump(REC.slugs, row.served_slug);
	bump(REC.tiers, row.tier);
	REC.usd += recordedUsd;
	if (recordedSwitch) {
		REC.switches++;
		REC.switchUsd += recordedUsd;
	}
	if (u.promptTokens > 20_000 && u.cachedTokens < 0.2 * u.promptTokens) REC.cold++;
	comparable++;
	if (row.served_slug !== null && row.served_slug === a.slug) fidelitySlug++;
	if (row.tier === a.tier) fidelityTier++;
	if (a.slug !== b.slug || a.tier !== b.tier) {
		flips.push({ id: row.id.slice(0, 8), tier: `${a.tier}->${b.tier}`, from: a.slug, to: b.slug, delta: b.usd - a.usd });
	}
}

const pct = (n: number, d: number) => (d === 0 ? "0.0" : ((100 * n) / d).toFixed(1));
console.log(`\nreplayed ${comparable} dispatches from ${dbPath} (${escalationsReplayed} escalations as recorded; warmth: ${args.warmth})`);
console.log(`catalog: ${openrouterSnapshot.models.length} OpenRouter models${ollamaCache.models.length > 0 ? ` + ${ollamaCache.models.length} Ollama Cloud models` : ""}${cfgA.ollama.enabled ? "" : " (ollama disabled in config)"}`);
console.log(`variant A overrides: ${args.setA.length ? args.setA.join(" ") : "(config as-is)"}`);
console.log(`variant B overrides: ${args.setB.length ? args.setB.join(" ") : "(none — A and B identical)"}`);
console.log(`\nFIDELITY vs what actually ran:`);
console.log(`  same model ${fidelitySlug}/${comparable} (${pct(fidelitySlug, comparable)}%)   same tier ${fidelityTier}/${comparable} (${pct(fidelityTier, comparable)}%)`);
console.log("  Divergence is expected where code has changed since those rows were served");
console.log("  (replay runs CURRENT code); the rest is what replay cannot model.");

function table(label: string, rec: Map<string, number>, a: Map<string, number>, b: Map<string, number>) {
	const keys = [...new Set([...rec.keys(), ...a.keys(), ...b.keys()])].sort((x, y) => (b.get(y) ?? 0) - (b.get(x) ?? 0));
	console.log(`\n${label.padEnd(32)}${"actual".padStart(8)}${"A".padStart(7)}${"B".padStart(7)}${"B-A".padStart(7)}`);
	for (const k of keys) {
		const r = rec.get(k) ?? 0;
		const av = a.get(k) ?? 0;
		const bv = b.get(k) ?? 0;
		const d = bv - av;
		console.log(`  ${k.padEnd(30)}${String(r).padStart(8)}${String(av).padStart(7)}${String(bv).padStart(7)}${(d > 0 ? `+${d}` : String(d)).padStart(7)}`);
	}
}
table("tier", REC.tiers, A.tiers, B.tiers);
table("model", REC.slugs, A.slugs, B.slugs);

console.log(`\ncache behaviour (per variant; "actual" cold = recorded <20% cached on a >20k prompt):`);
console.log(`  ${"".padEnd(30)}${"actual".padStart(8)}${"A".padStart(7)}${"B".padStart(7)}${"B-A".padStart(7)}`);
const line = (label: string, r: number, av: number, bv: number) =>
	console.log(`  ${label.padEnd(30)}${String(r).padStart(8)}${String(av).padStart(7)}${String(bv).padStart(7)}${(bv - av > 0 ? `+${bv - av}` : String(bv - av)).padStart(7)}`);
line("model switches", REC.switches, A.switches, B.switches);
line("cold-priced dispatches", REC.cold, A.cold, B.cold);
line("hysteresis holds", 0, A.held, B.held);
line("upgrades deferred", 0, A.deferred, B.deferred);
console.log(`  spend on switch turns          $${REC.switchUsd.toFixed(2).padStart(7)} $${A.switchUsd.toFixed(2).padStart(6)} $${B.switchUsd.toFixed(2).padStart(6)}`);

console.log(`\nspend, re-priced on RECORDED usage via the real computeCost:`);
console.log(`  actual (billed) $${REC.usd.toFixed(4)}   per dispatch $${(REC.usd / comparable).toFixed(5)}`);
console.log(`  A               $${A.usd.toFixed(4)}   per dispatch $${(A.usd / comparable).toFixed(5)}`);
console.log(`  B               $${B.usd.toFixed(4)}   per dispatch $${(B.usd / comparable).toFixed(5)}`);
const delta = B.usd - A.usd;
console.log(`  B vs A          $${delta.toFixed(4)}  (${delta === 0 ? "no change" : `${((100 * delta) / (A.usd || 1)).toFixed(1)}%`})`);
console.log(`\ndecisions changed: ${flips.length}/${comparable} (${pct(flips.length, comparable)}%)`);
if (args.verbose) {
	for (const f of flips.slice(0, 40)) {
		console.log(`  ${f.id}  ${f.tier.padEnd(22)} ${f.from} -> ${f.to}  ${f.delta >= 0 ? "+" : ""}$${f.delta.toFixed(5)}`);
	}
	if (flips.length > 40) console.log(`  … ${flips.length - 40} more`);
}
db.close();
