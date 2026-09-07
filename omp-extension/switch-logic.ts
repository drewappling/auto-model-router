/**
 * Pure decision logic behind the harness-side model switch (router-switch.ts):
 * given the router's advice for a prompt and what model omp is on, say whether
 * to move up to a harness-native model, back to the router, or stay put.
 * Free of omp types so it is unit-testable.
 */

export const TIERS = ["trivial", "simple", "moderate", "hard"] as const;
export type TierName = (typeof TIERS)[number];

export interface SwitchPolicy {
	enabled: boolean;
	/** Tier → harness model (`provider/id`) that serves that tier and above, up to the next configured tier. */
	models: Partial<Record<TierName, string>>;
	/** Advice below this confidence never moves the model. */
	minConfidence: number;
}

export const DISABLED_SWITCH: SwitchPolicy = { enabled: false, models: {}, minConfidence: 1 };

export function parseSwitchPolicy(raw: unknown): SwitchPolicy {
	if (raw === null || typeof raw !== "object") return DISABLED_SWITCH;
	const r = raw as Record<string, unknown>;
	const models: Partial<Record<TierName, string>> = {};
	if (r.models !== null && typeof r.models === "object") {
		for (const t of TIERS) {
			const v = (r.models as Record<string, unknown>)[t];
			if (typeof v === "string" && v.includes("/")) models[t] = v;
		}
	}
	return {
		enabled: r.enabled === true,
		models,
		minConfidence: typeof r.minConfidence === "number" ? r.minConfidence : 0.6,
	};
}

/** The harness model configured for the highest tier at or below `tier`, if any. */
export function nativeModelFor(policy: SwitchPolicy, tier: TierName): string | undefined {
	for (let i = TIERS.indexOf(tier); i >= 0; i--) {
		const m = policy.models[TIERS[i]!];
		if (m !== undefined) return m;
	}
	return undefined;
}

export interface SwitchInput {
	policy: SwitchPolicy;
	advised: { tier: TierName; confidence: number };
	/** omp's active model as `provider/id`, or null when none. */
	active: string | null;
	/** True when the active model belongs to the router's provider. */
	activeIsRouter: boolean;
	/** The harness model this extension last switched TO, if omp is still on it. */
	switchedTo: string | null;
	/** The router model omp was on before the switch, to return to. */
	returnTo: string | null;
}

export type SwitchDecision =
	| { action: "up"; model: string; reason: string }
	| { action: "back"; model: string; reason: string }
	| { action: "none"; reason: string };

export function decideSwitch(input: SwitchInput): SwitchDecision {
	const { policy, advised, active, activeIsRouter, switchedTo, returnTo } = input;
	if (!policy.enabled) return { action: "none", reason: "harnessSwitch.enabled is off" };
	const onOurSwitch = switchedTo !== null && active === switchedTo;
	// The user picked something else by hand: never fight a manual choice.
	if (!activeIsRouter && !onOurSwitch) return { action: "none", reason: `active model ${active ?? "(none)"} was chosen by the user` };
	const native = nativeModelFor(policy, advised.tier);
	if (native === undefined) {
		if (onOurSwitch && returnTo !== null) return { action: "back", model: returnTo, reason: `${advised.tier} work: back to the router` };
		return { action: "none", reason: `${advised.tier} work stays on the router` };
	}
	if (advised.confidence < policy.minConfidence) {
		return { action: "none", reason: `${advised.tier} at confidence ${advised.confidence.toFixed(2)} < ${policy.minConfidence}` };
	}
	if (active === native) return { action: "none", reason: `already on ${native}` };
	return { action: "up", model: native, reason: `${advised.tier} work (confidence ${advised.confidence.toFixed(2)}) → ${native}` };
}
