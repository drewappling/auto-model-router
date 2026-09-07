/**
 * omp extension: harness-side model switch (experimental).
 *
 * Before omp starts a turn on a user prompt, ask the router which tier the
 * prompt is, and when that tier is mapped to a harness-native model in the
 * router's `harnessSwitch.models` (a Claude subscription model, typically),
 * move omp's active model there; when a later prompt is advised below the
 * mapped tiers, move back to the router model we left. A model the user
 * picked by hand is never touched.
 *
 * Nothing is proxied and no token leaves omp: the native turns bill the
 * subscription, the router serves the rest and keeps the ledger for those.
 * Off unless `harnessSwitch.enabled` is set in the router config.
 *
 *   # ~/.omp/agent/config.yml
 *   extensions:
 *     - /path/to/auto-model-router/omp-extension/router-embed.ts
 *     - /path/to/auto-model-router/omp-extension/router-switch.ts
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { EMBED_PROVIDER_ID } from "./embed-logic.ts";
import { routerAuthHeaders, routerBaseUrl } from "./router-url.ts";
import { DISABLED_SWITCH, decideSwitch, parseSwitchPolicy, type SwitchPolicy, type TierName } from "./switch-logic.ts";

const HARNESS_ID = process.env.OMP_HARNESS_ID ?? "";
const POLICY_TTL_MS = 60_000;

export default function (pi: ExtensionAPI): void {
	pi.setLabel("auto-model-router switch");

	let policy: SwitchPolicy = DISABLED_SWITCH;
	let policyAtMs = 0;
	let switchedTo: string | null = null;
	let returnTo: string | null = null;

	async function refreshPolicy(): Promise<void> {
		if (Date.now() - policyAtMs < POLICY_TTL_MS) return;
		policyAtMs = Date.now();
		try {
			const res = await fetch(`${routerBaseUrl()}/v1/router/advise/policy`, { headers: routerAuthHeaders(), signal: AbortSignal.timeout(2_000) });
			policy = res.ok ? parseSwitchPolicy(await res.json()) : DISABLED_SWITCH;
		} catch {
			policy = DISABLED_SWITCH;
		}
	}

	pi.on("session_start", async () => {
		policyAtMs = 0;
		switchedTo = null;
		returnTo = null;
		await refreshPolicy();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const e = event as { prompt?: string };
		if (typeof e.prompt !== "string" || e.prompt.trim() === "") return undefined;
		await refreshPolicy();
		if (!policy.enabled) return undefined;
		const activeModel = ctx.model;
		const active = activeModel === undefined ? null : `${activeModel.provider}/${activeModel.id}`;
		const activeIsRouter = activeModel?.provider === EMBED_PROVIDER_ID;
		let advised: { tier: TierName; confidence: number };
		try {
			const res = await fetch(`${routerBaseUrl()}/v1/router/advise`, {
				method: "POST",
				headers: { ...routerAuthHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ ompSessionId: ctx.sessionManager.getSessionId(), harnessId: HARNESS_ID, text: e.prompt.slice(0, 8_000) }),
				signal: AbortSignal.timeout(2_000),
			});
			if (!res.ok) return undefined;
			advised = (await res.json()) as { tier: TierName; confidence: number };
		} catch {
			return undefined;
		}
		const decision = decideSwitch({ policy, advised, active, activeIsRouter, switchedTo, returnTo });
		if (decision.action === "none") return undefined;
		const [provider = "", ...rest] = decision.model.split("/");
		const target = ctx.modelRegistry.find(provider, rest.join("/"));
		if (target === undefined) {
			if (ctx.hasUI) ctx.ui.notify(`router switch: ${decision.model} is not in omp's model registry`, "warn");
			return undefined;
		}
		const ok = await ctx.setModel(target);
		if (!ok) {
			if (ctx.hasUI) ctx.ui.notify(`router switch: omp has no key for ${decision.model}`, "warn");
			return undefined;
		}
		if (decision.action === "up") {
			if (activeIsRouter) returnTo = active;
			switchedTo = decision.model;
		} else {
			switchedTo = null;
			returnTo = null;
		}
		if (ctx.hasUI) ctx.ui.notify(`router switch: ${decision.reason}`, "info");
		return undefined;
	});
}
