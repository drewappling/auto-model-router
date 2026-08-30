/**
 * End-to-end verification of compaction plan stability.
 *
 * Two properties, both measured against a real router process over a growing
 * agentic conversation:
 *
 *  1. STABILITY — an edit applied on one turn is re-applied byte-identically on
 *     every later turn. Any change to already-sent bytes invalidates the
 *     upstream prompt cache from that message onward.
 *  2. CHURN — how many turns change the plan at all. Each change is a cache
 *     invalidation; live ledger data puts a changed-plan turn at 15.4% cold vs
 *     8.9% when the plan holds, and a cold prompt costs 4.34x a warm one per
 *     token. `compaction.floorRatio` trades a little extra elision for far
 *     fewer changes.
 *
 * Run: bun tools/verify-plan-persist.ts [floorRatio]
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config/load.ts";
import { startServer } from "../src/server/http.ts";
import { startMockOpenRouter } from "./mock-openrouter.ts";

const floorRatio = Number.parseFloat(process.argv[2] ?? "0.75");
const home = mkdtempSync(join(tmpdir(), "verify-plan-persist-"));
const mock = await startMockOpenRouter("test/fixtures/openrouter-models.json");

const cfg = loadConfig({});
cfg.server = { ...cfg.server, host: "127.0.0.1", port: 0 };
cfg.openrouter.baseUrl = `${mock.url}/api/v1`;
cfg.openrouter.apiKey = "sk-mock";
cfg.ledger.path = join(home, "router.db");
cfg.logLevel = "error";
cfg.classifier.ambiguityThreshold = 0;
cfg.benchmarks.enabled = false;
cfg.context.enabled = false;
// Scaled-down budget so the fixture behaves like a 40k-budget real conversation.
cfg.compaction.enabled = true;
cfg.compaction.budgetTokens = 1_500;
cfg.compaction.floorRatio = floorRatio;
cfg.compaction.maxToolResultBytes = 256;
cfg.compaction.keepHeadBytes = 16;
cfg.compaction.keepTailBytes = 16;

const app = startServer(cfg);
const base = `http://127.0.0.1:${app.server.port}`;

const big = (marker: string): string => `${marker}: ${"payload ".repeat(60)}`;
const call = (id: string, name: string, args: unknown): unknown => ({
	role: "assistant",
	content: null,
	tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const result = (id: string, content: string): unknown => ({ role: "tool", tool_call_id: id, content });
const cycle = (n: number): unknown[] => [
	call(`c${n}`, "read", { path: `src/file${n}.ts` }),
	result(`c${n}`, big(`READ${n}`)),
	{ role: "assistant", content: `read file${n}` },
];

async function dispatch(messages: unknown[]): Promise<{ role: string; content: unknown }[]> {
	const res = await fetch(`${base}/v1/chat/completions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ model: "auto", messages, stream: true }),
	});
	await res.text();
	const body = mock.requests.at(-1)?.body as Record<string, unknown>;
	return body.messages as { role: string; content: unknown }[];
}

const fail = (label: string, detail?: unknown): never => {
	console.error(`FAIL ${label}`, detail === undefined ? "" : JSON.stringify(detail).slice(0, 500));
	process.exit(1);
};
const shrunkOf = (msgs: { content: unknown }[]): Map<number, string> => {
	const out = new Map<number, string>();
	msgs.forEach((m, i) => {
		if (typeof m.content === "string" && m.content.includes("omp-router: elided")) out.set(i, m.content);
	});
	return out;
};

// A 20-cycle conversation, dispatched turn by turn exactly as omp would: the
// full history every time, one cycle longer each turn.
const TURNS = 20;
let history: unknown[] = [{ role: "user", content: "audit the project" }];
let prev = new Map<number, string>();
let changes = 0;
let firstPlanTurn = 0;

for (let n = 1; n <= TURNS; n++) {
	history = [...history, ...cycle(n)];
	const msgs = await dispatch(history);
	const shrunk = shrunkOf(msgs);

	// STABILITY: every previously-shrunk message must still be shrunk, with the
	// same bytes. A dropped or altered edit rewrites the cached prefix.
	for (const [i, content] of prev) {
		const now = shrunk.get(i);
		if (now === undefined) {
			fail(`turn ${n}: edit at message ${i} was DROPPED (bytes re-inflated mid-prefix)`, { turn: n, i });
		} else if (now !== content) {
			fail(`turn ${n}: edit at message ${i} changed bytes`, { was: content.slice(0, 90), now: now.slice(0, 90) });
		}
	}

	const added = [...shrunk.keys()].filter((i) => !prev.has(i));
	if (added.length > 0) {
		changes++;
		if (firstPlanTurn === 0) firstPlanTurn = n;
		console.log(`turn ${String(n).padStart(2)}: plan CHANGED (+${added.length} edits, ${shrunk.size} total)`);
	} else if (shrunk.size > 0) {
		console.log(`turn ${String(n).padStart(2)}: plan held (${shrunk.size} edits)`);
	} else {
		console.log(`turn ${String(n).padStart(2)}: no compaction`);
	}
	prev = shrunk;
}

const planningTurns = TURNS - firstPlanTurn + 1;
console.log(`\nfloorRatio ${floorRatio}`);
console.log(`PASS stability: no edit was ever dropped or rewritten across ${TURNS} turns`);
console.log(`plan changes: ${changes} over ${planningTurns} compacting turns (${((changes / planningTurns) * 100).toFixed(0)}% of turns invalidate cache)`);

await app.stop();
await mock.stop();
process.exit(0);
