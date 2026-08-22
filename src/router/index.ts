/**
 * Router assembly: estimate -> features -> classify -> select.
 *
 * Deliberately READ-ONLY with respect to conversation state. `server/turn.ts`
 * owns every write, because only it knows the committed outcome (which model
 * actually served, what it cost, whether the cache went warm). Routing that
 * also persisted would race that save and lose the sticky window.
 *
 * The read-only property is what makes `omp-router explain` safe: it routes a
 * real request without perturbing the conversation it belongs to.
 */

import type { CatalogSource } from "../catalog/types.ts";
import type { ProfileConfig, RouterConfig } from "../config/types.ts";
import type { Ledger } from "../cost/types.ts";
import { estimatePromptTokens } from "../tokens/estimate.ts";
import type { UpstreamClient } from "../upstream/types.ts";
import type { NormRequest } from "../wire/types.ts";
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

function resolveProfile(cfg: RouterConfig, requestedModel: string): ProfileConfig {
	const exact = cfg.profiles.find((p) => p.id === requestedModel);
	if (exact !== undefined) return exact;
	const fallback = cfg.profiles[0];
	if (fallback === undefined) throw new Error("no router profiles configured");
	return fallback;
}

export function createRouter(deps: RouterDeps): Router {
	const { config, catalog, ledger, conversations, upstream } = deps;

	return {
		async route(
			req: NormRequest,
			opts: { attempt: number; escalateFrom?: Tier; excludeSlugs?: readonly string[] },
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
			} else {
				classification = await classify(req, features, config, { upstream, ledger, catalog });
			}

			return select({
				req,
				features,
				classification,
				profile: resolveProfile(config, req.requestedModel),
				state,
				snapshot,
				ledger,
				cfg: config,
				nowMs: Date.now(),
				...(opts.excludeSlugs === undefined ? {} : { excludeSlugs: opts.excludeSlugs }),
			});
		},
	};
}
