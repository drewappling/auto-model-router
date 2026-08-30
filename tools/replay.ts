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
 *   bun tools/replay.ts --set filters.latencyWeight=0 --verbose
 *   bun tools/replay.ts --where "task='coding'" --set classifier.ambiguityThreshold=0
 *
 * `--set` overrides variant B; `--a` overrides the baseline too (default:
 * config as it currently stands on disk). Read-only: opens the ledger DB
 * readonly and never writes.
 *
 * WHAT IT MODELS FAITHFULLY
 *  - The recorded `features` blob is the exact classifier input from that turn,
 *    so no re-tokenization or re-derivation is involved.
 *  - The real catalog snapshot is hydrated from `catalog_cache` via `peek()`,
 *    so pricing, context windows, capabilities and joined benchmark scores are
 *    the ones that were actually in play. No network.
 *  - The real `Ledger` supplies trust and latency, so the trust divisor and the
 *    throughput multiplier behave as they do live.
 *  - `explorationDraw` keys on `conversationKey:turn`, both recorded, so
 *    exploration reproduces deterministically and cancels out in a diff.
 *
 * Conversation state is reconstructed from the PRECEDING recorded dispatch in
 * the same conversation — prior slug, prior tier, cache warmth, cumulative
 * spend — rather than simulated, so cache-warmth behaviour is exercised. Rows
 * are replayed chronologically for that reason.
 *
 * WHAT IT DOES NOT MODEL — read this before trusting a conclusion
 *  - `messages` are not recorded, so compaction cannot be re-planned. Replay
 *    forces `compaction.enabled=false` and feeds the POST-compaction prompt
 *    size (`usage.promptTokens`), i.e. the prompt selection actually saw.
 *  - Hysteresis holds ARE modelled: the window is re-armed after each replayed
 *    decision exactly as `turn.ts` does, and evolved PER VARIANT so a change
 *    that stops arming an expensive tier also drops the holds that followed it.
 *    What remains absent is escalation-lengthened holds, since replay does not
 *    retry, and `hold_arm` exploration draws are reproduced from the
 *    conversation key rather than read back from the row.
 *  - `requestedReasoning` IS recorded and is now used. It was previously forced
 *    to undefined here on the belief the ledger omitted it, which under-scored
 *    ~42% of dispatches and reproduced 27 hard decisions against 120 served.
 *    Treat replay numbers produced before that fix as biased toward cheap tiers.
 *  - Module constants are not config, so things like CAP_AUTONOMOUS_LOOP cannot
 *    be A/B'd via `--set` — only `RouterConfig` paths can.
 *
 * Because of those gaps the report leads with a FIDELITY figure. Read it with
 * care: it conflates replay error with genuine code change, since replay always
 * runs CURRENT code against rows served by whatever code was live then. Measured
 * on rows served by matching code it is 90% model / 77% tier; across older
 * history it drops to ~55%, and that drop is the shipped classifier changes
 * showing up, not the tool being wrong. Isolate a population with `--where` when
 * measuring one change.
 */

import { Database } from "bun:sqlite";

import { createCatalog } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel, CatalogSnapshot } from "../src/catalog/types.ts";
import { loadConfig } from "../src/config/load.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { computeCost } from "../src/cost/forecast.ts";
import { createLedger } from "../src/cost/ledger.ts";
import type { UsageCounts } from "../src/cost/types.ts";
import { scoreHeuristic } from "../src/router/classify.ts";
import { resolveHoldTurns } from "../src/router/explore.ts";
import { select } from "../src/router/select.ts";
import type { ConversationState, Decision, Features, Tier } from "../src/router/types.ts";
import type { UpstreamClient } from "../src/upstream/types.ts";
import type { NormMessage, NormRequest, NormTool } from "../src/wire/types.ts";

interface Args {
	limit: number;
	where: string;
	setB: string[];
	setA: string[];
	verbose: boolean;
	db: string;
}

function parseArgs(argv: string[]): Args {
	const a: Args = { limit: 500, where: "", setB: [], setA: [], verbose: false, db: "" };
	for (let i = 0; i < argv.length; i++) {
		const k = argv[i];
		const v = argv[i + 1];
		if (k === "--limit" && v !== undefined) (a.limit = Number.parseInt(v, 10)), i++;
		else if (k === "--where" && v !== undefined) (a.where = v), i++;
		else if (k === "--set" && v !== undefined) (a.setB.push(v), i++);
		else if (k === "--a" && v !== undefined) (a.setA.push(v), i++);
		else if (k === "--db" && v !== undefined) (a.db = v), i++;
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
	requested_model: string;
	harness_id: string;
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

/**
 * Conversation state reconstructed from the PRECEDING recorded dispatch in the
 * same conversation, not simulated.
 *
 * A neutral state cannot validate anything that depends on cache warmth — every
 * candidate looks cold, so a warm-cache change shows zero effect. But the
 * ledger does carry what the previous dispatch actually did, so warmth is
 * recoverable: `cacheWarmSlug` is the slug it served, `lastPromptTokens` its
 * prompt size. Deriving state from the RECORDED outcome rather than the
 * replayed one also stops replay error compounding down a conversation.
 *
 * `stickyUntilTurn` and `currentTier` are the exception: they are SIMULATED per
 * variant, by re-arming the hold exactly as `turn.ts` does after each replayed
 * decision. Without that, replay never held a tier and every hysteresis change
 * priced as zero.
 */
function stateOf(row: Row, prior: PriorTurn | undefined, hold: HoldState | undefined): ConversationState {
	return {
		key: row.conversation_key,
		sessionId: `omp-${row.conversation_key}`,
		// `turn.ts` computes turnNumber = state.turn + 1 and records THAT, so the
		// state `select` sees carries the PREVIOUS turn number. Passing row.turn
		// would expire every hold a turn early.
		turn: row.turn - 1,
		currentSlug: prior?.slug ?? null,
		// Tier and hold window come from THIS VARIANT's own history (see
		// HoldState); everything else comes from the recorded outcome.
		currentTier: hold?.tier ?? ((prior?.tier as Tier | undefined) ?? null),
		stickyUntilTurn: hold?.stickyUntilTurn ?? 0,
		escalations: 0,
		spentUsd: prior?.spentUsd ?? 0,
		lastPromptTokens: prior?.promptTokens ?? 0,
		cacheWarmSlug: prior?.cachedTokens !== undefined && prior.cachedTokens > 0 ? prior.slug : null,
		cacheWarmAtMs: prior?.atMs ?? 0,
		contextVersion: null,
		contextFetchedAtMs: 0,
		// Compaction cannot be replanned offline (messages are not recorded), so
		// replay carries no plan: forced off in the config it replays under.
		compactionPlan: null,
		updatedAtMs: prior?.atMs ?? 0,
	};
}

interface PriorTurn {
	slug: string | null;
	tier: string;
	promptTokens: number;
	cachedTokens: number;
	spentUsd: number;
	atMs: number;
}

/**
 * Hysteresis state, evolved PER VARIANT.
 *
 * A hold is a consequence of the decisions a variant made, so A and B must each
 * carry their own: if both read the recorded holds, a change that stops arming
 * `hard` would still be charged for the holds that followed it in production,
 * and the change would price as smaller than it is.
 *
 * This is the one place replay departs from "inputs come from the recorded
 * outcome". The cost is that hold state compounds a variant's own replay error
 * down a conversation; the benefit is that hold policy becomes measurable at
 * all, which it was not.
 */
interface HoldState {
	tier: Tier | null;
	stickyUntilTurn: number;
}

/**
 * Re-prices a decision against the tokens the turn ACTUALLY used, via the real
 * `computeCost` so price tiers, the cache split and reasoning/request fees are
 * handled exactly as they are live.
 *
 * Deliberately NOT the router's own forecast: `candidates.ts` hardcodes
 * `cacheHitRate: 0`, so forecasts overstate absolute cost ~2.8x. Pricing both
 * variants off recorded usage keeps the delta apples-to-apples and grounded.
 */
function repriceUsd(model: CatalogModel | undefined, usage: UsageCounts): number {
	if (model === undefined) return 0;
	return computeCost(model, usage).total;
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
const snapshot = catalog.peek();
if (snapshot === null) {
	console.error(`no cached catalog in ${dbPath}; run the router once so it populates catalog_cache`);
	process.exit(2);
}
const catalogSnapshot: CatalogSnapshot = snapshot;
const bySlug = new Map(snapshot.models.map((m) => [m.slug, m]));
const ledger = createLedger(db, cfgA);

const predicate = args.where === "" ? "" : ` AND (${args.where})`;
// Newest-first to honour --limit, then flipped to chronological so each row can
// see the dispatch that preceded it in its conversation.
const rows = (
	db
		.query(
			`SELECT id, conversation_key, turn, requested_model, harness_id, served_slug, tier, features, usage, reported_usd, predicted_usd, created_at_ms, error_kind
			 FROM ledger
			 WHERE features IS NOT NULL AND wasted = 0${predicate}
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

interface Outcome {
	tier: Tier;
	slug: string;
	usd: number;
	/** Whether the hysteresis hold bound this dispatch, for reporting. */
	held: boolean;
	/** Hold state to carry into this variant's next dispatch. */
	hold: HoldState;
}

function run(cfg: RouterConfig, row: Row, usage: UsageCounts, prior: PriorTurn | undefined, hold: HoldState | undefined): Outcome {
	const f = featuresOf(row, usage.promptTokens);
	const req = requestOf(row, f);
	const state = stateOf(row, prior, hold);
	const decision: Decision = select({
		req,
		features: f,
		classification: scoreHeuristic(f, cfg),
		profile: profileOf(cfg, row.requested_model),
		state,
		snapshot: catalogSnapshot,
		ledger,
		cfg,
		nowMs: Date.now(),
	});

	// Re-arm exactly as turn.ts does: only when the served tier CHANGED, because
	// re-arming every turn extends the window forever and the router then never
	// downgrades. `escalated` is false — replay does not model escalation
	// retries, so escalation-lengthened holds are still absent.
	// Only a dispatch that reaches the COMMIT path re-arms, as in turn.ts: an
	// aborted one never gets there, and 27% of rows abort (omp closing the
	// stream once it has the tool calls). Re-arming on those inflated the hold
	// count roughly 4x against what production recorded.
	const committed = row.error_kind === null;
	const tierChanged = committed && (hold?.tier ?? null) !== decision.tier;
	const next: HoldState = tierChanged
		? { tier: decision.tier, stickyUntilTurn: row.turn + resolveHoldTurns(cfg, row.conversation_key, false).turns }
		: { tier: committed ? decision.tier : (hold?.tier ?? null), stickyUntilTurn: hold?.stickyUntilTurn ?? 0 };

	return {
		tier: decision.tier,
		slug: decision.slug,
		usd: repriceUsd(bySlug.get(decision.slug), usage),
		held: decision.classification.source === "sticky",
		hold: next,
	};
}

const tallyA = new Map<string, number>();
const tallyB = new Map<string, number>();
const tallyRec = new Map<string, number>();
const tierA = new Map<string, number>();
const tierB = new Map<string, number>();
const tierRec = new Map<string, number>();
let usdA = 0;
let usdB = 0;
let usdRec = 0;
let fidelitySlug = 0;
let fidelityTier = 0;
let comparable = 0;
const flips: { id: string; tier: string; from: string; to: string; delta: number }[] = [];
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

// Carries the RECORDED outcome of each conversation's previous dispatch forward,
// so cache warmth and the prior slug are real rather than assumed absent.
const priorByConv = new Map<string, PriorTurn>();
// Hold state is per VARIANT, since a hold follows from that variant's own
// decisions. See HoldState.
const holdA = new Map<string, HoldState>();
const holdB = new Map<string, HoldState>();
let heldA = 0;
let heldB = 0;

for (const row of rows) {
	const u = JSON.parse(row.usage) as UsageCounts;
	if (!(u.promptTokens > 0)) continue;
	const prior = priorByConv.get(row.conversation_key);
	const a = run(cfgA, row, u, prior, holdA.get(row.conversation_key));
	const b = run(cfgB, row, u, prior, holdB.get(row.conversation_key));
	holdA.set(row.conversation_key, a.hold);
	holdB.set(row.conversation_key, b.hold);
	if (a.held) heldA++;
	if (b.held) heldB++;
	priorByConv.set(row.conversation_key, {
		slug: row.served_slug,
		tier: row.tier,
		promptTokens: u.promptTokens,
		cachedTokens: u.cachedTokens,
		spentUsd: (prior?.spentUsd ?? 0) + (row.reported_usd ?? row.predicted_usd),
		atMs: row.created_at_ms,
	});
	bump(tallyA, a.slug);
	bump(tallyB, b.slug);
	bump(tierA, a.tier);
	bump(tierB, b.tier);
	// The recorded outcome: what the router ACTUALLY did, under whatever code and
	// config were live then. This is the yardstick for fidelity, and it is also
	// how a shipped classifier change shows up — replay runs current code.
	if (row.served_slug !== null) bump(tallyRec, row.served_slug);
	bump(tierRec, row.tier);
	usdA += a.usd;
	usdB += b.usd;
	usdRec += row.reported_usd ?? row.predicted_usd;
	comparable++;
	if (row.served_slug !== null && row.served_slug === a.slug) fidelitySlug++;
	if (row.tier === a.tier) fidelityTier++;
	if (a.slug !== b.slug || a.tier !== b.tier) {
		flips.push({ id: row.id.slice(0, 8), tier: `${a.tier}->${b.tier}`, from: a.slug, to: b.slug, delta: b.usd - a.usd });
	}
}

const pct = (n: number, d: number) => (d === 0 ? "0.0" : ((100 * n) / d).toFixed(1));
console.log(`\nreplayed ${comparable} dispatches from ${dbPath}`);
console.log(`variant A overrides: ${args.setA.length ? args.setA.join(" ") : "(config as-is)"}`);
console.log(`variant B overrides: ${args.setB.length ? args.setB.join(" ") : "(none — A and B identical)"}`);
console.log(`\nFIDELITY vs what actually ran:`);
console.log(`  same model ${fidelitySlug}/${comparable} (${pct(fidelitySlug, comparable)}%)   same tier ${fidelityTier}/${comparable} (${pct(fidelityTier, comparable)}%)`);
console.log("  Divergence is expected where code has changed since those rows were served");
console.log("  (replay runs CURRENT code); the rest is what replay cannot model.");
console.log(`  hysteresis holds bound ${heldA} dispatches in A, ${heldB} in B (simulated per variant).`);

function table(label: string, rec: Map<string, number>, A: Map<string, number>, B: Map<string, number>) {
	const keys = [...new Set([...rec.keys(), ...A.keys(), ...B.keys()])].sort((x, y) => (B.get(y) ?? 0) - (B.get(x) ?? 0));
	console.log(`\n${label.padEnd(32)}${"actual".padStart(8)}${"A".padStart(7)}${"B".padStart(7)}${"B-A".padStart(7)}`);
	for (const k of keys) {
		const r = rec.get(k) ?? 0;
		const a = A.get(k) ?? 0;
		const b = B.get(k) ?? 0;
		const d = b - a;
		console.log(`  ${k.padEnd(30)}${String(r).padStart(8)}${String(a).padStart(7)}${String(b).padStart(7)}${(d > 0 ? `+${d}` : String(d)).padStart(7)}`);
	}
}
table("tier", tierRec, tierA, tierB);
table("model", tallyRec, tallyA, tallyB);

console.log(`\nspend, re-priced on RECORDED usage via the real computeCost:`);
console.log(`  actual (billed) $${usdRec.toFixed(4)}   per dispatch $${(usdRec / comparable).toFixed(5)}`);
console.log(`  A               $${usdA.toFixed(4)}   per dispatch $${(usdA / comparable).toFixed(5)}`);
console.log(`  B               $${usdB.toFixed(4)}   per dispatch $${(usdB / comparable).toFixed(5)}`);
const delta = usdB - usdA;
console.log(`  B vs A          $${delta.toFixed(4)}  (${delta === 0 ? "no change" : `${((100 * delta) / (usdA || 1)).toFixed(1)}%`})`);
console.log(`\ndecisions changed: ${flips.length}/${comparable} (${pct(flips.length, comparable)}%)`);
if (args.verbose) {
	for (const f of flips.slice(0, 40)) {
		console.log(`  ${f.id}  ${f.tier.padEnd(22)} ${f.from} -> ${f.to}  ${f.delta >= 0 ? "+" : ""}$${f.delta.toFixed(5)}`);
	}
	if (flips.length > 40) console.log(`  … ${flips.length - 40} more`);
}
db.close();
