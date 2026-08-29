import { describe, expect, test } from "bun:test";

import type { AgentDoxClient, AssembleLimits } from "../src/context/agentdox.ts";
import { createContextBridge } from "../src/context/bridge.ts";
import { createContextStore } from "../src/context/store.ts";
import type { ContextResolveInput, TurnRecord } from "../src/context/types.ts";
import { createLogger } from "../src/util/log.ts";
import { openDb } from "../src/util/sqlite.ts";
import { injectForTest } from "./helpers/inject.ts";

const log = createLogger("silent");

interface FakeClient extends AgentDoxClient {
	assembleCalls: number;
	appended: { sessionId: string; role: string; content: string; refs: string[] }[];
	sessionsCreated: number;
	prompt: string;
	lastLimits: AssembleLimits | null;
}

function mkClient(prompt = "MEMORY: player digs in 3/4 top-down"): FakeClient {
	const c: FakeClient = {
		assembleCalls: 0,
		lastLimits: null,
		appended: [],
		sessionsCreated: 0,
		prompt,
		async assemble(_scope, _query, limits) {
			c.assembleCalls++;
			c.lastLimits = limits;
			return c.prompt;
		},
		async createSession() {
			c.sessionsCreated++;
			return `ses_${c.sessionsCreated}`;
		},
		async append(sessionId, role, content, refs) {
			c.appended.push({ sessionId, role, content, refs });
			return true;
		},
	};
	return c;
}

type BridgeOpts = Parameters<typeof createContextBridge>[0];

function mkBridge(client: AgentDoxClient, over: Partial<BridgeOpts> = {}) {
	const db = openDb(":memory:");
	const opts: BridgeOpts = {
		client,
		store: createContextStore(db),
		log,
		maxStalenessMs: 900_000,
		maxBlockChars: 24_000,
		memoryLimit: 8,
		sessionLimit: 6,
		recordTurns: true,
		maxQueue: 64,
		...over,
	};
	return { db, bridge: createContextBridge(opts) };
}

function input(over: Partial<ContextResolveInput> = {}): ContextResolveInput {
	return {
		scope: "ashlands",
		conversationKey: "k1",
		pinnedVersion: null,
		pinnedFetchedAtMs: 0,
		modelSwitching: false,
		retrying: false,
		query: "movement rules",
		...over,
	};
}

describe("context bridge refresh policy", () => {
	test("fetches on the first turn, then pins without re-fetching", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			const first = await bridge.resolve(input());
			expect(first).not.toBeNull();
			expect(client.assembleCalls).toBe(1);

			// Steady state: same model, not retrying, not stale => no fetch, same bytes.
			const second = await bridge.resolve(
				input({ pinnedVersion: first?.version ?? null, pinnedFetchedAtMs: first?.fetchedAtMs ?? 0 }),
			);
			expect(client.assembleCalls).toBe(1);
			expect(second?.block).toBe(first?.block ?? "");
		} finally {
			db.close();
		}
	});

	test("assembly is bounded, so the block cannot grow until bytes get severed", async () => {
		// The block reached 23.5k chars (~5.9k tokens, 15 memory entries) against a
		// 24k maxBlockChars cap, at which point renderBlock slices mid-entry. Byte
		// truncation is blind to relevance, so the server must be told to rank and
		// select instead. The REST endpoint ignores snake_case limit keys, which
		// silently reads as unbounded — hence pinning that the limits are passed.
		const client = mkClient();
		const { bridge, db } = mkBridge(client, { memoryLimit: 5, sessionLimit: 2 });
		try {
			await bridge.resolve(input());
			expect(client.lastLimits).toEqual({ memoryLimit: 5, sessionLimit: 2 });
		} finally {
			db.close();
		}
	});

	test("refreshes when the model switches, because the cache is already forfeit", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			const first = await bridge.resolve(input());
			await bridge.resolve(
				input({
					pinnedVersion: first?.version ?? null,
					pinnedFetchedAtMs: first?.fetchedAtMs ?? 0,
					modelSwitching: true,
				}),
			);
			expect(client.assembleCalls).toBe(2);
		} finally {
			db.close();
		}
	});

	test("refreshes on a retry", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			const first = await bridge.resolve(input());
			await bridge.resolve(
				input({
					pinnedVersion: first?.version ?? null,
					pinnedFetchedAtMs: first?.fetchedAtMs ?? 0,
					retrying: true,
				}),
			);
			expect(client.assembleCalls).toBe(2);
		} finally {
			db.close();
		}
	});

	test("refreshes once the staleness TTL elapses", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client, { maxStalenessMs: 1_000 });
		try {
			const first = await bridge.resolve(input());
			await bridge.resolve(input({ pinnedVersion: first?.version ?? null, pinnedFetchedAtMs: Date.now() - 5_000 }));
			expect(client.assembleCalls).toBe(2);
		} finally {
			db.close();
		}
	});

	test("version is a content hash, so an unchanged re-assembly keeps the cache warm", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			const first = await bridge.resolve(input());
			// Force a refetch; agentdox returns byte-identical content.
			const second = await bridge.resolve(
				input({
					pinnedVersion: first?.version ?? null,
					pinnedFetchedAtMs: first?.fetchedAtMs ?? 0,
					modelSwitching: true,
				}),
			);
			expect(client.assembleCalls).toBe(2);
			expect(second?.version).toBe(first?.version ?? "");
			expect(second?.block).toBe(first?.block ?? "");
		} finally {
			db.close();
		}
	});

	test("changed content yields a new version", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			const first = await bridge.resolve(input());
			client.prompt = "MEMORY: player digs in 3/4 top-down; hard edges only";
			const second = await bridge.resolve(
				input({
					pinnedVersion: first?.version ?? null,
					pinnedFetchedAtMs: first?.fetchedAtMs ?? 0,
					modelSwitching: true,
				}),
			);
			expect(second?.version).not.toBe(first?.version ?? "");
		} finally {
			db.close();
		}
	});

	test("an unreachable agentdox keeps serving the pinned block", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			const first = await bridge.resolve(input());
			client.assemble = async () => null; // agentdox goes down
			const second = await bridge.resolve(
				input({
					pinnedVersion: first?.version ?? null,
					pinnedFetchedAtMs: first?.fetchedAtMs ?? 0,
					modelSwitching: true,
				}),
			);
			expect(second?.block).toBe(first?.block ?? "");
		} finally {
			db.close();
		}
	});

	test("an empty scope is inert", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			expect(await bridge.resolve(input({ scope: "" }))).toBeNull();
			expect(client.assembleCalls).toBe(0);
		} finally {
			db.close();
		}
	});

	test("blocks survive a restart, so the same bytes are re-injected", async () => {
		const client = mkClient();
		const db = openDb(":memory:");
		try {
			const opts: BridgeOpts = {
				client,
				store: createContextStore(db),
				log,
				maxStalenessMs: 900_000,
				maxBlockChars: 24_000,
				memoryLimit: 8,
				sessionLimit: 6,
				recordTurns: true,
				maxQueue: 64,
			};
			const first = await createContextBridge(opts).resolve(input());
			// A "restart": brand-new bridge over the same store.
			const after = await createContextBridge(opts).resolve(
				input({ pinnedVersion: first?.version ?? null, pinnedFetchedAtMs: first?.fetchedAtMs ?? 0 }),
			);
			expect(after?.block).toBe(first?.block ?? "");
			expect(client.assembleCalls).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe("context bridge write-back", () => {
	test("creates one session per conversation and attributes the model", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			bridge.recordTurn({
				scope: "ashlands",
				conversationKey: "k1",
				title: "movement fix",
				userText: "fix movement",
				assistantText: "done",
				slug: "anthropic/claude-haiku-4.5",
				tier: "simple",
				turnEnded: true,
			});
			bridge.recordTurn({
				scope: "ashlands",
				conversationKey: "k1",
				title: "movement fix",
				userText: "now the camera",
				assistantText: "ok",
				slug: "anthropic/claude-opus-4.5",
				tier: "hard",
				turnEnded: true,
			});
			await bridge.flush();

			expect(client.sessionsCreated).toBe(1);
			expect(client.appended).toHaveLength(4);
			const assistants = client.appended.filter((m) => m.role === "assistant");
			expect(assistants[0]?.refs).toEqual(["model:anthropic/claude-haiku-4.5", "tier:simple"]);
			expect(assistants[1]?.refs).toEqual(["model:anthropic/claude-opus-4.5", "tier:hard"]);
		} finally {
			db.close();
		}
	});

	test("recordTurns=false writes nothing", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client, { recordTurns: false });
		try {
			bridge.recordTurn({
				scope: "ashlands",
				conversationKey: "k1",
				title: "t",
				userText: "u",
				assistantText: "a",
				slug: "x",
				tier: "simple",
				turnEnded: true,
			});
			await bridge.flush();
			expect(client.appended).toHaveLength(0);
		} finally {
			db.close();
		}
	});

	/** One dispatch of a turn; `turnEnded` marks the one that yields to the user. */
	function mkRecord(over: Partial<TurnRecord> & { turnEnded: boolean }): TurnRecord {
		return {
			scope: "ashlands",
			conversationKey: "k1",
			title: "movement fix",
			userText: "fix movement",
			assistantText: "",
			slug: "z-ai/glm-5.3-flash",
			tier: "simple",
			...over,
		};
	}

	test("a tool loop records one turn, not one record per dispatch", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			// One user-visible turn: five tool round-trips, then the synthesis.
			// Every dispatch carries the SAME unchanged user text — recording per
			// dispatch appended it once per round-trip and buried the real answer
			// under near-empty assistant messages.
			for (const assistantText of ["let me look", "", "checking the ledger", "", "almost there"]) {
				bridge.recordTurn(mkRecord({ assistantText, turnEnded: false }));
			}
			bridge.recordTurn(mkRecord({ assistantText: "fixed: the damping was inverted.", turnEnded: true }));
			await bridge.flush();

			expect(client.sessionsCreated).toBe(1);
			const users = client.appended.filter((m) => m.role === "user");
			const assistants = client.appended.filter((m) => m.role === "assistant");
			expect(users).toHaveLength(1);
			expect(assistants).toHaveLength(1);
			// The loop's narration AND the closing synthesis survive, in order.
			expect(assistants[0]?.content).toBe(
				"let me look\n\nchecking the ledger\n\nalmost there\n\nfixed: the damping was inverted.",
			);
			expect(assistants[0]?.refs).toEqual(["model:z-ai/glm-5.3-flash", "tier:simple"]);
		} finally {
			db.close();
		}
	});

	test("a tool loop still running writes nothing", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			bridge.recordTurn(mkRecord({ assistantText: "let me look", turnEnded: false }));
			await bridge.flush();
			// The assistant has not answered yet. Writing here is what produced the
			// 4-char transcripts, so mid-loop must stay silent.
			expect(client.appended).toHaveLength(0);
			expect(client.sessionsCreated).toBe(0);
		} finally {
			db.close();
		}
	});

	test("interleaved conversations buffer independently", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			bridge.recordTurn(mkRecord({ conversationKey: "k1", assistantText: "k1 narration", turnEnded: false }));
			bridge.recordTurn(mkRecord({ conversationKey: "k2", assistantText: "k2 narration", turnEnded: false }));
			bridge.recordTurn(mkRecord({ conversationKey: "k2", assistantText: "k2 answer", turnEnded: true }));
			bridge.recordTurn(mkRecord({ conversationKey: "k1", assistantText: "k1 answer", turnEnded: true }));
			await bridge.flush();

			const assistants = client.appended.filter((m) => m.role === "assistant");
			expect(assistants).toHaveLength(2);
			expect(assistants[0]?.content).toBe("k2 narration\n\nk2 answer");
			expect(assistants[1]?.content).toBe("k1 narration\n\nk1 answer");
		} finally {
			db.close();
		}
	});

	test("a silent turn still records the user message", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			bridge.recordTurn(mkRecord({ assistantText: "", turnEnded: true }));
			await bridge.flush();
			expect(client.appended.filter((m) => m.role === "user")).toHaveLength(1);
			expect(client.appended.filter((m) => m.role === "assistant")).toHaveLength(0);
		} finally {
			db.close();
		}
	});
});

describe("context injection into the wire body", () => {
	test("appends to the last system message, leaving breakpoint indices valid", () => {
		const body = {
			model: "auto",
			messages: [
				{ role: "system", content: "you are omp" },
				{ role: "user", content: "hi" },
			],
		};
		const out = injectForTest(body, "BLOCK", [0]);
		const msgs = out.messages as Record<string, unknown>[];
		// No new message: the indices the core computed stay correct.
		expect(msgs).toHaveLength(2);
		const content = msgs[0]?.content;
		const text = Array.isArray(content) ? JSON.stringify(content) : String(content);
		expect(text).toContain("you are omp");
		expect(text).toContain("BLOCK");
		// The breakpoint landed on the system message that now carries the block.
		expect(text).toContain("cache_control");
	});

	test("prepends a system message and shifts breakpoints when there is none", () => {
		const body = { model: "auto", messages: [{ role: "user", content: "hi" }] };
		const out = injectForTest(body, "BLOCK", [0]);
		const msgs = out.messages as Record<string, unknown>[];
		expect(msgs).toHaveLength(2);
		expect(msgs[0]?.role).toBe("system");
		// The user message that was index 0 is now index 1, and the breakpoint
		// followed it — otherwise the marker would land on the injected block.
		expect(JSON.stringify(msgs[1]?.content ?? "")).toContain("cache_control");
	});

	test("no contextBlock leaves the body untouched", () => {
		const body = {
			model: "auto",
			messages: [
				{ role: "system", content: "sys" },
				{ role: "user", content: "hi" },
			],
		};
		const out = injectForTest(body, "", [0]);
		const msgs = out.messages as Record<string, unknown>[];
		expect(msgs).toHaveLength(2);
		expect(JSON.stringify(msgs)).not.toContain("project-context");
	});
});
