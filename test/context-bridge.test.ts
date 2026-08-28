import { describe, expect, test } from "bun:test";

import type { AgentDoxClient } from "../src/context/agentdox.ts";
import { createContextBridge } from "../src/context/bridge.ts";
import { createContextStore } from "../src/context/store.ts";
import type { ContextResolveInput } from "../src/context/types.ts";
import { createLogger } from "../src/util/log.ts";
import { openDb } from "../src/util/sqlite.ts";
import { injectForTest } from "./helpers/inject.ts";

const log = createLogger("silent");

interface FakeClient extends AgentDoxClient {
	assembleCalls: number;
	appended: { sessionId: string; role: string; content: string; refs: string[] }[];
	sessionsCreated: number;
	prompt: string;
}

function mkClient(prompt = "MEMORY: player digs in 3/4 top-down"): FakeClient {
	const c: FakeClient = {
		assembleCalls: 0,
		appended: [],
		sessionsCreated: 0,
		prompt,
		async assemble() {
			c.assembleCalls++;
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
			});
			bridge.recordTurn({
				scope: "ashlands",
				conversationKey: "k1",
				title: "movement fix",
				userText: "now the camera",
				assistantText: "ok",
				slug: "anthropic/claude-opus-4.5",
				tier: "hard",
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
			});
			await bridge.flush();
			expect(client.appended).toHaveLength(0);
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
