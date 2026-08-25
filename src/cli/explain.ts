/**
 * `auto-model-router explain` - route a real request and show the reasoning, without
 * dispatching it.
 *
 * The only network call this can make is a catalog refresh; no completion is
 * ever requested, so it never spends money on inference. It is also
 * side-effect-free on conversation state, because `createRouter` is read-only
 * there by construction.
 */

import { existsSync } from "node:fs";

import { createCatalog } from "../catalog/openrouter-catalog.ts";
import { loadConfig } from "../config/load.ts";
import { createLedger } from "../cost/ledger.ts";
import { createRouter } from "../router/index.ts";
import { createConversationStore } from "../router/state.ts";
import type { Candidate, Decision, Features, Rejection } from "../router/types.ts";
import { createOpenRouterClient } from "../upstream/openrouter.ts";
import { openDb } from "../util/sqlite.ts";
import { parseChatRequest } from "../wire/openai/request.ts";
import { configOpts, flagString, type CliArgs } from "./args.ts";

/** Sub-cent routing decisions need real significant figures, not two decimals. */
function usd(value: number): string {
	return `$${value.toFixed(6)}`;
}

/**
 * Feature rows worth printing even at zero, because their absence is itself
 * the signal that explains a cheap route.
 */
const ALWAYS_SHOW: Record<string, true> = {
	promptTokens: true,
	newContentTokens: true,
	toolCount: true,
	isToolResultContinuation: true,
	toolLoopDepth: true,
	lastToolFailed: true,
	repeatedToolCall: true,
	turnDepth: true,
};

function renderFeatures(f: Features): void {
	console.log("features:");
	const entries = Object.entries(f) as [string, unknown][];
	const width = Math.max(...entries.map(([k]) => k.length));
	for (const [key, value] of entries) {
		const empty =
			value === false ||
			value === 0 ||
			value === undefined ||
			(Array.isArray(value) && value.length === 0);
		if (empty && ALWAYS_SHOW[key] !== true) continue;
		const rendered = Array.isArray(value) ? (value.length === 0 ? "-" : value.join(", ")) : String(value);
		console.log(`  ${key.padEnd(width)}  ${rendered}`);
	}
}

function renderCandidates(considered: Candidate[]): void {
	console.log("\nranked candidates:");
	if (considered.length === 0) {
		console.log("  (none survived filtering)");
		return;
	}
	const rows = considered.slice(0, 10);
	const width = Math.max(5, ...rows.map((c) => c.model.slug.length));
	console.log(
		`  ${"model".padEnd(width)}  ${"qual".padStart(5)}  ${"trust".padStart(5)}  ${"expected".padStart(10)}  ${"cold".padStart(10)}  ${"score".padStart(12)}`,
	);
	for (const c of rows) {
		console.log(
			`  ${c.model.slug.padEnd(width)}  ${c.qualityScore.toFixed(1).padStart(5)}  ${c.trustScore.toFixed(2).padStart(5)}  ${usd(c.forecast.expectedUsd).padStart(10)}  ${usd(c.forecast.coldUsd).padStart(10)}  ${c.score.toExponential(3).padStart(12)}`,
		);
	}
	if (considered.length > rows.length) console.log(`  ... ${considered.length - rows.length} more`);
}

function renderRejections(rejected: Rejection[]): void {
	if (rejected.length === 0) return;
	const byReason = new Map<string, string[]>();
	for (const r of rejected) {
		const list = byReason.get(r.reason);
		if (list === undefined) byReason.set(r.reason, [r.slug]);
		else list.push(r.slug);
	}
	console.log("\nexcluded:");
	for (const [reason, slugs] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
		console.log(`  ${reason.padEnd(22)} ${String(slugs.length).padStart(4)}  e.g. ${slugs.slice(0, 3).join(", ")}`);
	}
}

function renderDecision(d: Decision): void {
	console.log("\ndecision:");
	console.log(`  model            ${d.slug}`);
	console.log(`  fallbacks        ${d.fallbacks.length === 0 ? "-" : d.fallbacks.join(", ")}`);
	console.log(`  tier             ${d.tier}`);
	console.log(`  sticky           ${d.sticky}`);
	console.log(`  budgetDowngraded ${d.budgetDowngraded}`);
	console.log(`  expected cost    ${usd(d.forecast.expectedUsd)}  (cold ${usd(d.forecast.coldUsd)})`);
	console.log(`  reasoning        ${d.reasoning ?? "-"}`);
	console.log(`  maxTokens        ${d.maxTokens ?? "-"}`);
	console.log(`  stripReasoning   ${d.stripAssistantReasoning}`);
	console.log(
		`  cache points     ${d.cacheBreakpointMessageIndices.length === 0 ? "none" : d.cacheBreakpointMessageIndices.join(", ")}`,
	);
	console.log(
		`  probe            ${d.probe.enabled ? `${d.probe.maxTokens} tokens / ${d.probe.maxHoldMs}ms, escalate to ${d.probe.escalateTo ?? "-"}` : "disabled"}`,
	);
	console.log(`  session          ${d.sessionId}`);
	if (d.reasons.length > 0) {
		console.log("  why:");
		for (const reason of d.reasons) console.log(`    - ${reason}`);
	}
}

export async function explainCommand(args: CliArgs): Promise<void> {
	const cfg = loadConfig(configOpts(args));
	const file = flagString(args, "file");
	const raw = file === undefined ? await Bun.stdin.text() : await Bun.file(file).text();
	if (raw.trim() === "") throw new Error("no request body supplied (pass --file <request.json> or pipe JSON on stdin)");

	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch (err) {
		throw new Error(`request body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
	}

	const req = parseChatRequest(body, new Headers());

	const db = openDb(cfg.ledger.path);
	try {
		const ledger = createLedger(db, cfg);
		const upstream = createOpenRouterClient(cfg);
		const catalog = createCatalog(cfg, upstream, db);
		const conversations = createConversationStore(db);
		const router = createRouter({ config: cfg, catalog, ledger, conversations, upstream });

		const decision = await router.route(req, { attempt: 0 });

		if (args.flags.has("json")) {
			console.log(JSON.stringify(decision, null, 2));
			return;
		}

		const state = conversations.get(req.conversationKey);
		console.log(`request: ${req.messages.length} messages, ${req.tools.length} tools, model "${req.requestedModel}"`);
		console.log(`conversation: ${req.conversationKey} (turn ${state?.turn ?? 0}, prior model ${state?.currentSlug ?? "none"})`);
		console.log(
			`ledger: ${existsSync(cfg.ledger.path) ? `${cfg.ledger.path}` : "(new)"}  spent so far ${usd(state?.spentUsd ?? 0)}`,
		);
		console.log("");
		renderFeatures(decision.features);
		const c = decision.classification;
		console.log(
			`\nclassification: ${c.tier}  (score ${c.score.toFixed(3)}, confidence ${c.confidence.toFixed(3)}, source ${c.source})`,
		);
		for (const reason of c.reasons) console.log(`  - ${reason}`);
		renderCandidates(decision.considered);
		renderRejections(decision.rejected);
		renderDecision(decision);
		console.log("\n(no completion was dispatched; nothing was billed)");
	} finally {
		db.close();
	}
}
