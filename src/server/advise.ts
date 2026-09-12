/**
 * Harness-side model switch: the router advises a tier for a prompt BEFORE
 * the harness dispatches it, so the harness can move its active model to one
 * the router cannot proxy (a Claude subscription model, say) for hard work
 * and back to the router for the rest.
 *
 * Why this shape: proxying a subscription upstream would mean translating
 * the OpenAI wire to that provider's and carrying its OAuth token through a
 * third-party process. Advising is cheaper and keeps the token where it
 * belongs. The cost of a native turn lands on the subscription, not the
 * ledger; the router only sees the turns it serves.
 *
 * The advice is the heuristic classifier over the user's prompt text alone
 * (the harness has not built the request yet), plus the session's last
 * routed tier for context. No adjudicator call, no dispatch, nothing recorded.
 */

import type { RouterConfig } from "../config/types.ts";
import type { AsyncLedger } from "../cost/types.ts";
import { scoreHeuristic } from "../router/classify.ts";
import { extractFeatures } from "../router/features.ts";
import { estimateTokens } from "../tokens/estimate.ts";
import type { TaskType, Tier } from "../router/types.ts";
import type { NormRequest } from "../wire/types.ts";

export interface AdviseRequest {
	ompSessionId: string;
	harnessId: string;
	/** The user's prompt as submitted. */
	text: string;
}

export interface Advice {
	tier: Tier;
	task: TaskType;
	confidence: number;
	score: number;
	reasons: string[];
	/** The tier this session's last routed turn ran at, when the router served one. */
	lastTier: Tier | null;
}

const SYSTEM_STUB = "You are a coding agent.";

function requestOf(req: AdviseRequest): NormRequest {
	const text = req.text;
	return {
		protocol: "openai-chat",
		conversationKey: `advise:${req.ompSessionId}`,
		harnessId: req.harnessId,
		ompSessionId: req.ompSessionId,
		agentdoxScope: "",
		agentdoxGroup: "",
		agentdoxPersonal: "",
		agentdoxOrigin: "",
		isSubagent: false,
		requestedModel: "auto",
		messages: [
			{ role: "system", text: SYSTEM_STUB, images: 0, textBytes: Buffer.byteLength(SYSTEM_STUB), toolCalls: [] },
			{ role: "user", text, images: 0, textBytes: Buffer.byteLength(text), toolCalls: [] },
		],
		tools: [],
		forcedToolChoice: false,
		stream: false,
		hasImages: false,
		promptBytes: Buffer.byteLength(SYSTEM_STUB) + Buffer.byteLength(text),
		renderUpstreamBody: () => ({}),
	};
}

/** Classifies a prompt the way the first turn of a conversation would be, without dispatching anything. */
export async function advise(cfg: RouterConfig, ledger: AsyncLedger | null, req: AdviseRequest): Promise<Advice> {
	const norm = requestOf(req);
	// Advice is a hint for a client that has not dispatched yet: the default
	// family ratio is enough, and it keeps this off the store entirely.
	const features = extractFeatures(norm, estimateTokens(norm.promptBytes, "unknown", null));
	const cls = scoreHeuristic(features, cfg);
	const last = req.ompSessionId === "" ? null : ((await ledger?.latestForSession(req.ompSessionId))?.tier ?? null);
	return {
		tier: cls.tier,
		task: cls.task,
		confidence: cls.confidence,
		score: cls.score,
		reasons: cls.reasons,
		lastTier: last === null ? null : (last as Tier),
	};
}
