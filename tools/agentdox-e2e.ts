/**
 * Live end-to-end check of the agentdox bridge against a running server.
 *
 * Exercises the real HTTP client, the real pin/refresh policy, and the real
 * write-back — no fakes. Run with a token that has write on the scope:
 *
 *   AGENTDOX_URL=http://localhost:3003 \
 *   AGENTDOX_TOKEN=<pat> AGENTDOX_SCOPE=omp-router \
 *   bun tools/agentdox-e2e.ts
 */

import { createAgentDoxClient } from "../src/context/agentdox.ts";
import { createContextBridge } from "../src/context/bridge.ts";
import { createContextStore } from "../src/context/store.ts";
import type { ContextResolveInput } from "../src/context/types.ts";
import { createLogger } from "../src/util/log.ts";
import { openDb } from "../src/util/sqlite.ts";

const baseUrl = process.env.AGENTDOX_URL ?? "http://localhost:3003";
const token = process.env.AGENTDOX_TOKEN ?? "";
const scope = process.env.AGENTDOX_SCOPE ?? "omp-router";

if (token === "") {
	console.error("AGENTDOX_TOKEN is required");
	process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : `  (${detail})`}`);
	if (!ok) failures++;
}

const log = createLogger("warn");
const db = openDb(":memory:");
const client = createAgentDoxClient({ baseUrl, token, timeoutMs: 5_000, log });
const bridge = createContextBridge({
	client,
	store: createContextStore(db),
	log,
	maxStalenessMs: 900_000,
	maxBlockChars: 24_000,
	recordTurns: true,
	maxQueue: 64,
});

const conversationKey = `e2e-${Date.now().toString(36)}`;
function input(over: Partial<ContextResolveInput> = {}): ContextResolveInput {
	return {
		scope,
		conversationKey,
		pinnedVersion: null,
		pinnedFetchedAtMs: 0,
		modelSwitching: false,
		retrying: false,
		query: "cache prompt context injection",
		...over,
	};
}

// 1. Assemble a real context slice.
const first = await bridge.resolve(input());
check("resolve returns a block from the live server", first !== null);
check(
	"block carries the agentdox delimiter",
	first !== null && first.block.includes("<project-context source=\"agentdox\">"),
);
console.log(`      block chars: ${first?.block.length ?? 0}, version ${first?.version.slice(0, 12) ?? "-"}`);

// 2. Steady state must NOT re-fetch, and must return byte-identical bytes.
const pinnedInput = input({
	pinnedVersion: first?.version ?? null,
	pinnedFetchedAtMs: first?.fetchedAtMs ?? 0,
});
const second = await bridge.resolve(pinnedInput);
check("pinned turn re-injects identical bytes", second?.block === first?.block);
check("pinned turn keeps the same version", second?.version === first?.version);

// 3. A model switch refreshes — and unchanged content keeps the SAME version,
//    which is what protects the prompt cache.
const switched = await bridge.resolve({ ...pinnedInput, modelSwitching: true });
check(
	"model switch refreshes but unchanged content keeps the version",
	switched !== null && switched.version === first?.version,
);

// 4. Write back a turn, attributed to the model that served it.
bridge.recordTurn({
	scope,
	conversationKey,
	title: `bridge e2e ${conversationKey}`,
	userText: "does the bridge record which model served this turn?",
	assistantText: "yes - refs carry model: and tier:.",
	slug: "anthropic/claude-haiku-4.5",
	tier: "simple",
});
await bridge.flush();

// 5. Read it back through the REST API to prove it landed.
const res = await fetch(`${baseUrl}/sessions?scope=${encodeURIComponent(scope)}`, {
	headers: { authorization: `Bearer ${token}` },
});
const sessions = (await res.json()) as { id: string; title: string }[];
const mine = sessions.find((s) => s.title === `bridge e2e ${conversationKey}`);
check("write-back created a session in agentdox", mine !== undefined, mine?.id ?? "not found");

if (mine !== undefined) {
	const full = await fetch(`${baseUrl}/sessions/${mine.id}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const session = (await full.json()) as { messages: { role: string; content: string; refs?: string[] }[] };
	const assistant = session.messages.find((m) => m.role === "assistant");
	check("transcript has both turns", session.messages.length === 2, `${session.messages.length} messages`);
	check(
		"assistant turn is model-attributed",
		assistant?.refs?.includes("model:anthropic/claude-haiku-4.5") === true,
		JSON.stringify(assistant?.refs ?? []),
	);
}

db.close();
console.log(failures === 0 ? "\nAll bridge e2e checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
