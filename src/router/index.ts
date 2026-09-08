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

import type { CatalogSource } from "../catalog/types.ts";
import type { ProfileConfig, RouterConfig } from "../config/types.ts";
import type { Ledger } from "../cost/types.ts";
import { estimatePromptTokens } from "../tokens/estimate.ts";
import type { UpstreamClient } from "../upstream/types.ts";
import type { NormRequest, RequestPolicy } from "../wire/types.ts";
import { classify, classifyTask } from "./classify.ts";
import { extractFeatures } from "./features.ts";
import { select } from "./select.ts";
import { TIER_ORDER, type Classification, type ConversationStore, type Decision, type Router, type Tier } from "./types.ts";

export interface RouterDeps {
	config: RouterConfig;
	catalog: CatalogSource;
	ledger: Ledger;
	conversations: ConversationStore;
	upstream: UpstreamClient;
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

export function createRouter(deps: RouterDeps): Router {
	const { config, catalog, ledger, conversations, upstream } = deps;

	return {
		async route(
			req: NormRequest,
			opts: { attempt: number; escalateFrom?: Tier; excludeSlugs?: readonly string[]; forceTier?: Tier; forceSlug?: string },
		): Promise<Decision> {
			const state = conversations.get(req.conversationKey) ?? conversations.load(req.conversationKey);
			const snapshot = await catalog.get();

			const priorTokenizer =
				state.currentSlug === null ? undefined : catalog.find(state.currentSlug)?.tokenizer;
			const promptTokens = estimatePromptTokens(req, priorTokenizer ?? NEUTRAL_TOKENIZER, ledger);
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

			const policed = applyRequestPolicy(resolveProfile(config, req.requestedModel, req.isSubagent), config, req.policy, opts.forceSlug);
			const decision = select({
				req,
				features,
				classification,
				profile: policed.profile,
				state,
				snapshot,
				ledger,
				cfg: policed.cfg,
				nowMs: Date.now(),
				...(opts.excludeSlugs === undefined ? {} : { excludeSlugs: opts.excludeSlugs }),
				...(policed.forceSlug === undefined ? {} : { forceSlug: policed.forceSlug }),
			});
			if (policed.reasons.length > 0) decision.reasons.unshift(...policed.reasons);
			return decision;
		},
	};
}
