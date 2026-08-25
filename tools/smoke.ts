/**
 * End-to-end smoke test: real router process, real HTTP, real SQLite ledger,
 * mock OpenRouter upstream. Proves the pipeline actually routes, escalates,
 * and accounts for spend without needing an API key or spending money.
 *
 * Responses are parsed with schemas rather than asserted with casts, so the
 * harness also verifies the client-facing wire contract.
 *
 * Run: bun run tools/smoke.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { loadConfig } from "../src/config/load.ts";
import { startServer } from "../src/server/http.ts";
import { startMockOpenRouter } from "./mock-openrouter.ts";

const failures: string[] = [];
let checks = 0;

function check(label: string, ok: boolean, detail?: unknown) {
	checks++;
	if (ok) {
		console.log(`  PASS  ${label}`);
		return;
	}
	failures.push(label);
	console.log(`  FAIL  ${label}${detail === undefined ? "" : `\n        ${JSON.stringify(detail)}`}`);
}

const HealthSchema = z
	.object({
		status: z.string(),
		apiKeyConfigured: z.boolean(),
		catalog: z.object({ models: z.number(), fetchedAtMs: z.number(), ageMs: z.number() }).nullable(),
	})
	.loose();
const ModelListSchema = z.object({ data: z.array(z.object({ id: z.string() }).loose()) });
const StatsSchema = z
	.object({
		spendAllTimeUsd: z.number(),
		requests: z.number(),
		escalations: z.number(),
		perModel: z.array(z.object({ slug: z.string(), spendUsd: z.number() }).loose()),
	})
	.loose();
const DecisionsSchema = z.object({
	entries: z.array(
		z.object({ wasted: z.boolean(), slug: z.string(), tier: z.string(), attempt: z.number() }).loose(),
	),
});
const BufferedSchema = z
	.object({
		choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }).loose() }).loose()),
		usage: z.object({ prompt_tokens: z.number(), completion_tokens: z.number() }).loose(),
	})
	.loose();

/** Streaming frame, modelled loosely: unknown fields must survive passthrough. */
const FrameSchema = z.object({
	model: z.string().optional(),
	x_auto_model_router: z.object({ model: z.string().optional(), tier: z.string().optional() }).loose().optional(),
	choices: z
		.array(
			z.object({
				delta: z
					.object({
						content: z.string().nullish(),
						tool_calls: z
							.array(z.object({ function: z.object({ arguments: z.string().optional() }).loose().optional() }).loose())
							.optional(),
					})
					.loose()
					.optional(),
			}).loose(),
		)
		.optional(),
}).loose();

const TOOLS = [
	{
		type: "function",
		function: {
			name: "read",
			description: "Read a file from disk",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
		},
	},
	{
		type: "function",
		function: {
			name: "bash",
			description: "Run a shell command",
			parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
		},
	},
];

const SYSTEM = "You are a coding agent operating in a repository. Use tools to inspect files before editing.";

interface Turn {
	role: string;
	content: unknown;
	tool_calls?: unknown[];
	tool_call_id?: string;
	name?: string;
}

function body(messages: Turn[], opts: { tools?: boolean; model?: string; stream?: boolean } = {}) {
	const out: Record<string, unknown> = {
		model: opts.model ?? "auto",
		messages: [{ role: "system", content: SYSTEM }, ...messages],
		stream: opts.stream ?? true,
	};
	if (opts.tools !== false) out.tools = TOOLS;
	return out;
}

/** Drains an SSE response into concatenated content, tool arguments, and router metadata. */
async function drain(res: Response) {
	const text = await res.text();
	let content = "";
	let toolArgs = "";
	let seenModel = "";
	let meta: { model?: string; tier?: string } | undefined;

	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const payload = line.slice(6).trim();
		if (payload === "[DONE]") break;
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			continue;
		}
		const frame = FrameSchema.safeParse(parsed);
		if (!frame.success) continue;
		if (frame.data.model !== undefined) seenModel = frame.data.model;
		if (frame.data.x_auto_model_router !== undefined) meta = frame.data.x_auto_model_router;
		const delta = frame.data.choices?.[0]?.delta;
		if (typeof delta?.content === "string") content += delta.content;
		for (const call of delta?.tool_calls ?? []) toolArgs += call.function?.arguments ?? "";
	}
	return { content, meta, toolArgs, seenModel, raw: text };
}

const home = mkdtempSync(join(tmpdir(), "auto-model-router-smoke-"));
const mock = await startMockOpenRouter("test/fixtures/openrouter-models.json");
console.log(`mock openrouter: ${mock.url}`);

const cfg = loadConfig({});
cfg.server = { host: "127.0.0.1", port: 0 };
cfg.openrouter.baseUrl = `${mock.url}/api/v1`;
cfg.openrouter.apiKey = "sk-mock";
cfg.ledger.path = join(home, "router.db");
cfg.logLevel = "warn";
// The adjudicator would call the mock and obscure which tier the heuristic chose.
cfg.classifier.ambiguityThreshold = 0;

const app = startServer(cfg);
const base = `http://127.0.0.1:${app.server.port}`;
console.log(`auto-model-router: ${base}\n`);

const post = (path: string, payload: unknown) =>
	fetch(`${base}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});


const TIER_RANK = ["trivial", "simple", "moderate", "hard"];
const tierRank = (tier: string): number => TIER_RANK.indexOf(tier);

/**
 * Tier the most recent turn's FIRST attempt used. `/decisions` is newest-first,
 * so the first `attempt === 0` row belongs to the turn that just finished.
 */
async function firstAttemptTier(): Promise<string> {
	const res = await fetch(`${base}/v1/router/decisions?limit=50`);
	const entries = DecisionsSchema.parse(await res.json()).entries;
	return entries.find((e) => e.attempt === 0)?.tier ?? "";
}

try {
	console.log("[1] discovery surface");
	// The server warms the catalog without blocking listen, so poll rather than race it.
	let health = HealthSchema.parse(await (await fetch(`${base}/health`)).json());
	for (let i = 0; i < 100 && health.catalog === null; i++) {
		await Bun.sleep(100);
		health = HealthSchema.parse(await (await fetch(`${base}/health`)).json());
	}
	check("health reports a warm catalog", (health.catalog?.models ?? 0) > 50, health);
	const models = ModelListSchema.parse(await (await fetch(`${base}/v1/models`)).json());
	const ids = models.data.map((m) => m.id);
	check("advertises the auto profiles", ids.includes("auto") && ids.includes("auto-cheap"), ids);

	console.log("\n[2] plain chat turn routes cheap");
	mock.requests.length = 0;
	const chat = await drain(await post("/v1/chat/completions", body([{ role: "user", content: "hi" }], { tools: false })));
	const chatSlug = mock.requests[0]?.model ?? "";
	check("dispatched exactly one upstream generation", mock.requests.length === 1, mock.requests.length);
	check("client sees the virtual model, not the slug", chat.seenModel === "auto", chat.seenModel);
	check("served slug is reported in metadata", typeof chat.meta?.model === "string", chat.meta);
	check("never routes to an openrouter meta-model", !chatSlug.startsWith("openrouter/"), chatSlug);
	check("never routes to a batch endpoint", !chatSlug.endsWith(":batch"), chatSlug);
	check("never routes to a floating alias", !chatSlug.startsWith("~"), chatSlug);
	check("forwards a session id for cache stickiness", Boolean(mock.requests[0]?.sessionId), mock.requests[0]?.sessionId);
	console.log(`        -> ${chatSlug} (tier ${chat.meta?.tier})`);

	console.log("\n[3] complexity separates tiers within one conversation");
	mock.requests.length = 0;
	const hardRes = await drain(
		await post(
			"/v1/chat/completions",
			body([
				{
					role: "user",
					content:
						"Our worker pool deadlocks under load. Walk through the root cause, explain the race between the queue drain and the shutdown path, and propose an architecture that removes the invariant violation.",
				},
			]),
		),
	);
	const hardSlug = mock.requests[0]?.model ?? "";
	const hardFirstTier = await firstAttemptTier();

	mock.requests.length = 0;
	const mechRes = await drain(
		await post(
			"/v1/chat/completions",
			body([
				{ role: "user", content: "read src/index.ts" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"src/index.ts"}' } }],
				},
				{ role: "tool", tool_call_id: "c1", name: "read", content: "export const version = '1.0.0';\n" },
			]),
		),
	);
	const mechSlug = mock.requests[0]?.model ?? "";
	const mechFirstTier = await firstAttemptTier();

	check("hard reasoning and mechanical tool-result turns route differently", hardSlug !== mechSlug, {
		hard: hardSlug,
		mechanical: mechSlug,
	});
	// Compare what CLASSIFICATION chose, i.e. each turn's first attempt. The
	// final tier is a poor probe here: the mock replays the same tool call the
	// request already contains, so the mechanical turn legitimately trips
	// `repeat_tool_call` and escalates, which would mask the classifier's
	// separation with an escalation artifact.
	check("the hard turn classified into a higher tier than the mechanical one", tierRank(hardFirstTier) > tierRank(mechFirstTier), {
		hard: hardFirstTier,
		mechanical: mechFirstTier,
	});
	console.log(`        hard       -> ${hardSlug} (classified ${hardFirstTier}, served ${hardRes.meta?.tier})`);
	console.log(`        mechanical -> ${mechSlug} (classified ${mechFirstTier}, served ${mechRes.meta?.tier})`);

	console.log("\n[4] guarded probe escalates on a malformed tool call");
	mock.requests.length = 0;
	// Truncate only the first generation, whichever model serves it: the retry
	// must then succeed on a stronger model.
	mock.control.truncateFirstN = 1;
	const escalated = await drain(
		await post(
			"/v1/chat/completions",
			body([
				{ role: "user", content: "open the config file" },
				{
					role: "assistant",
					content: null,
					tool_calls: [{ id: "c9", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
				},
				{ role: "tool", tool_call_id: "c9", name: "bash", content: "config.yml\n" },
			]),
		),
	);
	let toolArgsValid = false;
	try {
		JSON.parse(escalated.toolArgs);
		toolArgsValid = escalated.toolArgs.length > 0;
	} catch {
		toolArgsValid = false;
	}
	const attemptSlugs = mock.requests.map((r) => r.model);
	check("retried upstream after the malformed tool call", mock.requests.length >= 2, attemptSlugs);
	check("escalated to a different model", new Set(attemptSlugs).size >= 2, attemptSlugs);
	check("client received only well-formed tool arguments", toolArgsValid, escalated.toolArgs);
	mock.control.truncateFirstN = 0;
	console.log(`        attempts -> ${attemptSlugs.join(" then ")}`);

	console.log("\n[5] buffered (non-streaming) responses");
	mock.requests.length = 0;
	const buffered = BufferedSchema.parse(
		await (
			await post("/v1/chat/completions", body([{ role: "user", content: "say hello" }], { tools: false, stream: false }))
		).json(),
	);
	check("buffered response carries assembled content", Boolean(buffered.choices[0]?.message.content), buffered.choices);
	check("buffered response reports usage", buffered.usage.prompt_tokens > 0, buffered.usage);

	console.log("\n[6] ledger accounting");
	const stats = StatsSchema.parse(await (await fetch(`${base}/v1/router/stats`)).json());
	const decisions = DecisionsSchema.parse(await (await fetch(`${base}/v1/router/decisions?limit=50`)).json()).entries;
	check("ledger recorded every attempt", decisions.length >= 6, decisions.length);
	check("stats report non-zero spend", stats.spendAllTimeUsd > 0, stats);
	const wasted = decisions.filter((d) => d.wasted).length;
	check("the abandoned escalation attempt is booked as wasted spend", wasted >= 1, wasted);
} finally {
	await app.stop();
	await mock.stop();
	rmSync(home, { recursive: true, force: true });
}

console.log(`\n${checks - failures.length}/${checks} checks passed`);
if (failures.length > 0) {
	console.log(`failed:\n  ${failures.join("\n  ")}`);
	process.exit(1);
}
