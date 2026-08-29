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
 * WHAT IT DOES NOT MODEL — read this before trusting a conclusion
 *  - `messages` are not recorded, so compaction cannot be re-planned. Replay
 *    forces `compaction.enabled=false` and feeds the POST-compaction prompt
 *    size (`usage.promptTokens`), i.e. the prompt selection actually saw.
 *  - Conversation state is not recoverable historically (only the current row
 *    survives), so replay uses a neutral state: no sticky tier, no warm cache,
 *    no accumulated spend. Hysteresis, cache-warmth tie-breaks and the
 *    per-conversation budget guard are therefore NOT exercised.
 *  - `requestedReasoning` is the one `Features` field the ledger omits; it
 *    replays as undefined.
 *
 * Because of those gaps, the report leads with a FIDELITY figure: how often the
 * baseline variant reproduces the model that actually served. Low fidelity means
 * the unmodelled parts dominate and any delta below is weak evidence.
 */

import { Database } from "bun:sqlite";

import { createCatalog } from "../src/catalog/openrouter-catalog.ts";
import type { CatalogModel } from "../src/catalog/types.ts";
import { loadConfig } from "../src/config/load.ts";
import type { RouterConfig } from "../src/config/types.ts";
import { computeCost } from "../src/cost/forecast.ts";
import { createLedger } from "../src/cost/ledger.ts";
import type { UsageCounts } from "../src/cost/types.ts";
import { scoreHeuristic } from "../src/router/classify.ts";
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
		if (leaf === undefined || !(leaf in node)) throw new Error(`--set path not found: ${entry}`);
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
}

/** Rebuilds the classifier input. The ledger stores 20 of 21 Features fields. */
function featuresOf(row: Row, promptTokens: number): Features {
	const f = JSON.parse(row.features) as Partial<Features>;
	return { ...(f as Features), promptTokens, requestedReasoning: undefined };
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

/** Neutral state: no sticky tier, no warm cache, no prior spend. See header. */
function stateOf(row: Row): ConversationState {
	return {
		key: row.conversation_key,
		sessionId: `omp-${row.conversation_key}`,
		turn: row.turn,
		currentSlug: null,
		currentTier: null,
		stickyUntilTurn: 0,
		escalations: 0,
		spentUsd: 0,
		lastPromptTokens: 0,
		cacheWarmSlug: null,
		cacheWarmAtMs: 0,
		contextVersion: null,
		contextFetchedAtMs: 0,
		updatedAtMs: 0,
	};
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
const bySlug = new Map(snapshot.models.map((m) => [m.slug, m]));
const ledger = createLedger(db, cfgA);

const predicate = args.where === "" ? "" : ` AND (${args.where})`;
const rows = db
	.query(
		`SELECT id, conversation_key, turn, requested_model, harness_id, served_slug, tier, features, usage, reported_usd, predicted_usd
		 FROM ledger
		 WHERE features IS NOT NULL AND wasted = 0${predicate}
		 ORDER BY created_at_ms DESC LIMIT ?`,
	)
	.all(args.limit) as Row[];

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
}

function run(cfg: RouterConfig, row: Row, usage: UsageCounts): Outcome {
	const f = featuresOf(row, usage.promptTokens);
	const req = requestOf(row, f);
	const decision: Decision = select({
		req,
		features: f,
		classification: scoreHeuristic(f, cfg),
		profile: profileOf(cfg, row.requested_model),
		state: stateOf(row),
		snapshot,
		ledger,
		cfg,
		nowMs: Date.now(),
	});
	return { tier: decision.tier, slug: decision.slug, usd: repriceUsd(bySlug.get(decision.slug), usage) };
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

for (const row of rows) {
	const u = JSON.parse(row.usage) as UsageCounts;
	if (!(u.promptTokens > 0)) continue;
	const a = run(cfgA, row, u);
	const b = run(cfgB, row, u);
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
console.log("  (replay runs CURRENT code); the rest is the unmodelled neutral state.");
console.log("  Low fidelity => treat the A/B delta below as weak evidence.");

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
