/**
 * Router assembly: estimate -> features -> classify -> select.
 *
 * Deliberately READ-ONLY with respect to conversation state. `server/turn.ts`
 * owns every write, because only it knows the committed outcome (which model
 * actually served, what it cost, whether the cache went warm). Routing that
 * also persisted would race that save and lose the sticky window.
 *
 * The read-only property is what makes `auto-model-router explain` safe: it routes a
 * real request without perturbing the conversation it belongs to.
 */

import type { CatalogSnapshot, CatalogSource } from "../catalog/types.ts";
import type { ProfileConfig, RouterConfig } from "../config/types.ts";
import { type AsyncLedger, type LedgerReader } from "../cost/types.ts";
import { estimatePromptTokens } from "../tokens/estimate.ts";
import type { UpstreamClient } from "../upstream/types.ts";
import { modelNotFound } from "../wire/openai/errors.ts";
import type { NormRequest, RequestPolicy } from "../wire/types.ts";
import { classify, classifyTask } from "./classify.ts";
import { extractFeatures } from "./features.ts";
import { monthStartMs, select, type TurnReads } from "./select.ts";
import { TIER_ORDER, type Classification, type ConversationStore, type Decision, type Router, type Tier } from "./types.ts";
export interface RouterDeps {
	config: RouterConfig;
	catalog: CatalogSource;
	ledger: AsyncLedger;
	conversations: ConversationStore;
	upstream: UpstreamClient;
	/** Async ledger reads; defaults to reading `ledger` directly. */
	reader?: LedgerReader;
}

/**
 * Tokenizer used for prompt estimation before a model is chosen.
 *
 * Chicken-and-egg: the estimate feeds candidate filtering, so it cannot depend
 * on the winner. The conversation's previous model is the best available proxy,
 * and family ratios differ by only a few percent anyway.
 */
const NEUTRAL_TOKENIZER = "gpt";

const TIER_RANK: Record<string, number> = { trivial: 0, simple: 1, moderate: 2, hard: 3 };

/**
 * Applies a request policy on top of the resolved profile and config: the
 * tier envelope is narrowed (never widened), a request allow list replaces
 * the configured one, a request deny list adds to it, and a pin becomes a
 * forced slug unless a session override already forced one.
 */
export function applyRequestPolicy(
	profile: ProfileConfig,
	cfg: RouterConfig,
	policy: RequestPolicy | undefined,
	forceSlug: string | undefined,
): { profile: ProfileConfig; cfg: RouterConfig; forceSlug: string | undefined; reasons: string[] } {
	if (policy === undefined) return { profile, cfg, forceSlug, reasons: [] };
	const reasons: string[] = [];
	let minTier = profile.minTier;
	let maxTier = profile.maxTier;
	if (policy.minTier !== undefined && TIER_RANK[policy.minTier]! > TIER_RANK[minTier]!) minTier = policy.minTier;
	if (policy.maxTier !== undefined && TIER_RANK[policy.maxTier]! < TIER_RANK[maxTier]!) maxTier = policy.maxTier;
	if (TIER_RANK[minTier]! > TIER_RANK[maxTier]!) minTier = maxTier;
	const narrowed = minTier !== profile.minTier || maxTier !== profile.maxTier;
	const outProfile = narrowed ? { ...profile, id: `${profile.id}+policy`, minTier, maxTier } : profile;
	if (narrowed) reasons.push(`policy: tiers narrowed to [${minTier}..${maxTier}]`);
	let outCfg = cfg;
	if (policy.allow !== undefined || policy.deny !== undefined) {
		outCfg = { ...cfg, filters: { ...cfg.filters, ...(policy.allow === undefined ? {} : { allow: policy.allow }), ...(policy.deny === undefined ? {} : { deny: [...cfg.filters.deny, ...policy.deny] }) } };
		reasons.push(`policy: ${policy.allow === undefined ? "" : `allow ${policy.allow.join("|")} `}${policy.deny === undefined ? "" : `deny ${policy.deny.join("|")}`}`.trim());
	}
	let outForce = forceSlug;
	if (forceSlug === undefined && policy.pin !== undefined) {
		outForce = policy.pin;
		reasons.push(`policy: pinned to ${policy.pin}`);
	}
	return { profile: outProfile, cfg: outCfg, forceSlug: outForce, reasons };
}

export function resolveProfile(cfg: RouterConfig, requestedModel: string, isSubagent = false): ProfileConfig {
	const fallback = cfg.profiles[0];
	if (fallback === undefined) throw new Error("no router profiles configured");
	// A subagent asking for the default profile is routed under the subagent
	// profile when one is configured and exists; an explicit other profile
	// (auto-max, auto-cheap) is honoured as asked.
	const exact = cfg.profiles.find((p) => p.id === requestedModel);
	if (isSubagent && cfg.server.subagentProfile !== "" && (exact === undefined || exact.id === fallback.id)) {
		const sub = cfg.profiles.find((p) => p.id === cfg.server.subagentProfile);
		if (sub !== undefined) return sub;
	}
	if (exact !== undefined) return exact;
	return fallback;
}

/**
 * The `model` a client names is a profile id. When it is neither a profile nor
 * a catalog slug, routing something else and reporting the asked-for name back
 * is a silent substitution: the caller is billed for a model it never chose.
 * A real slug becomes a pin (absolute, the way a session override is); anything
 * else is refused.
 *
 * @param asked the client's `model` before the provider prefix was stripped.
 * @returns the slug to pin, or undefined when a profile matched.
 */
export function pinForRequestedModel(
	cfg: RouterConfig,
	slugs: readonly string[],
	requestedModel: string,
	asked: string,
): string | undefined {
	if (cfg.profiles.some((p) => p.id === requestedModel)) return undefined;
	if (slugs.includes(asked)) return asked;
	throw modelNotFound(asked);
}

/**
 * Reads the ledger for one turn, concurrently, before selection runs.
 *
 * Only what this turn's configuration actually consults is fetched: month and
 * day spend are skipped when no such budget is set, and the escalation-cost
 * term is skipped when its weight is 0. Empty catalog ⇒ no signal queries at
 * all, which is what keeps the tests' fakes cheap.
 */
export async function prefetchTurnReads(
	reader: LedgerReader | null,
	req: NormRequest,
	profile: ProfileConfig,
	cfg: RouterConfig,
	snapshot: CatalogSnapshot,
	task: string,
	nowMs: number = Date.now(),
): Promise<TurnReads> {
	if (reader === null) return {};
	const slugs = snapshot.models.map((m) => m.slug);
	const harness = cfg.filters.trustScopedByHarness ? req.harnessId : undefined;
	const perMonthUsd = profile.budget?.perMonthUsd ?? cfg.budget.perMonthUsd;
	const perDayUsd = profile.budget?.perDayUsd ?? cfg.budget.perDayUsd;
	const [signals, cacheReliability, escalation, monthSpendUsd, daySpendUsd] = await Promise.all([
		slugs.length > 0 ? reader.signals(slugs, harness, cfg.filters.feedbackByTask ? task : undefined) : undefined,
		slugs.length > 0 && cfg.filters.cacheReliabilityMinSamples > 0 ? reader.cacheReliability(slugs) : undefined,
		cfg.filters.escalationCostWeight > 0 ? reader.escalationCost(cfg.ledger.blendWindowDays) : undefined,
		// Month pacing can tighten the daily ceiling, so month spend is needed
		// whenever either budget is set.
		perMonthUsd !== undefined ? reader.spendSince(monthStartMs(nowMs), req.harnessId) : undefined,
		perDayUsd !== undefined || perMonthUsd !== undefined ? reader.spendSince(nowMs - 86_400_000, req.harnessId) : undefined,
	]);
	return {
		...(signals === undefined ? {} : { signals }),
		...(cacheReliability === undefined ? {} : { cacheReliability }),
		...(escalation === undefined ? {} : { escalationUsdPerPromptToken: escalation?.usdPerPromptToken ?? null }),
		...(monthSpendUsd === undefined ? {} : { monthSpendUsd }),
		...(daySpendUsd === undefined ? {} : { daySpendUsd }),
	};
}

export function createRouter(deps: RouterDeps): Router {
	const { config, catalog, ledger, conversations, upstream } = deps;
	// A Postgres ledger supplies its own reader; a local one is wrapped, so the
	// prefetch path is identical for both.
	// The unified ledger IS a reader: `LedgerReader` is the narrow half of it.
	const reader = deps.reader ?? ledger;

	return {
		async route(
			req: NormRequest,
			opts: { attempt: number; escalateFrom?: Tier; excludeSlugs?: readonly string[]; forceTier?: Tier; forceSlug?: string },
		): Promise<Decision> {
			const state = (await conversations.get(req.conversationKey)) ?? (await conversations.load(req.conversationKey));
			const snapshot = await catalog.get();

			const priorTokenizer =
				state.currentSlug === null ? undefined : catalog.find(state.currentSlug)?.tokenizer;
			const tokenizer = priorTokenizer ?? NEUTRAL_TOKENIZER;
			// One ratio, fetched before estimating: the estimate itself runs in
			// synchronous code that a shared store cannot be read from.
			const ratio = await ledger.tokenRatio(tokenizer);
			const promptTokens = estimatePromptTokens(req, tokenizer, ratio);
			const features = extractFeatures(req, promptTokens);

			let classification: Classification;
			if (opts.escalateFrom !== undefined) {
				// An escalation is not a re-judgement: the probe already proved the
				// cheaper tier failed, so force strictly upward rather than letting
				// the classifier re-derive the same losing answer.
				const nextIdx = Math.min(TIER_ORDER.indexOf(opts.escalateFrom) + 1, TIER_ORDER.length - 1);
				const forced = TIER_ORDER[nextIdx];
				if (forced === undefined) throw new Error(`unresolvable escalation tier from ${opts.escalateFrom}`);
				classification = {
					tier: forced,
					task: classifyTask(features),
					confidence: 1,
					source: "escalation",
					score: 1,
					reasons: [`escalated from ${opts.escalateFrom} after attempt ${opts.attempt - 1} was rejected`],
				};
			} else if (opts.forceTier !== undefined) {
				// A session override from omp: the user chose the tier for a while.
				classification = {
					tier: opts.forceTier,
					task: classifyTask(features),
					confidence: 1,
					source: "forced",
					score: 1,
					reasons: [`tier ${opts.forceTier} forced by session override (/router tier)`],
				};
			} else {
				classification = await classify(req, features, config, { upstream, ledger, catalog });
			}

			const pinnedByModel = pinForRequestedModel(
				config,
				snapshot.models.map((m) => m.slug),
				req.requestedModel,
				req.requestedModelFull ?? req.requestedModel,
			);
			const policed = applyRequestPolicy(
				resolveProfile(config, req.requestedModel, req.isSubagent),
				config,
				req.policy,
				opts.forceSlug ?? pinnedByModel,
			);
			// Every ledger read this turn needs, fetched here rather than inside
			// `select`: selection stays a synchronous pure function, and a ledger
			// that can only be read asynchronously (Postgres) works unchanged.
			const reads = await prefetchTurnReads(reader, req, policed.profile, policed.cfg, snapshot, classification.task);
			const decision = select({
				req,
				features,
				classification,
				profile: policed.profile,
				state,
				snapshot,
				cfg: policed.cfg,
				nowMs: Date.now(),
				reads,
				...(opts.excludeSlugs === undefined ? {} : { excludeSlugs: opts.excludeSlugs }),
				...(policed.forceSlug === undefined ? {} : { forceSlug: policed.forceSlug }),
			});
			if (policed.reasons.length > 0) decision.reasons.unshift(...policed.reasons);
			return decision;
		},
	};
}
