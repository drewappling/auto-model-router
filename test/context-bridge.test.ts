import { describe, expect, test } from "bun:test";

import { type AgentDoxClient, type AssembleLayers, type AssembleLimits, createAgentDoxClient } from "../src/context/agentdox.ts";
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
	/** The layers of the last assemble: undefined when the bridge sent none. */
	lastLayers: AssembleLayers | undefined;
}

function mkClient(prompt = "MEMORY: player digs in 3/4 top-down"): FakeClient {
	const c: FakeClient = {
		assembleCalls: 0,
		lastLimits: null,
		lastLayers: undefined,
		appended: [],
		sessionsCreated: 0,
		prompt,
		async assemble(scope, _query, limits, layers) {
			c.assembleCalls++;
			c.lastLimits = limits;
			c.lastLayers = layers;
			// Like the server: a personal layer renders last, so members differ.
			return layers !== undefined && layers.personal !== "" ? `${c.prompt}\n\n# Your thread in ${scope}\n${layers.personal}` : c.prompt;
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
		docsLimit: 2,
		sessionLimit: 6,
		briefChars: 0,
		layers: true,
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
		group: "",
		personal: "",
		user: "",
		firstFetch: true,
		...over,
	};
}

describe("context bridge refresh policy", () => {
	test("recent sessions ride only on a conversation's first block; refreshes ask for none", async () => {
		const client = mkClient();
		const { bridge } = mkBridge(client, { sessionLimit: 6 });
		await bridge.resolve(input({ firstFetch: true }));
		expect(client.lastLimits?.sessionLimit).toBe(6);
		// A refresh (model switch) on a conversation that already had a block.
		await bridge.resolve(input({ firstFetch: false, modelSwitching: true, pinnedVersion: "stale", pinnedFetchedAtMs: 1 }));
		expect(client.lastLimits?.sessionLimit).toBe(0);
		expect(client.assembleCalls).toBe(2);
	});

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
		// The block reached 23.5k chars against a 24k maxBlockChars cap, at which
		// point renderBlock slices mid-entry. Byte truncation is blind to relevance,
		// so the server must be told to rank and select instead. `docsLimit`
		// especially: docs are WHOLE documents and were left unbounded, and a single
		// ashlands note-doc measured 41,921 chars — over the whole cap by itself.
		// The REST endpoint also ignores snake_case limit keys, which silently reads
		// as unbounded, so pin that all four limits actually reach the client.
		const client = mkClient();
		const { bridge, db } = mkBridge(client, { memoryLimit: 5, docsLimit: 1, sessionLimit: 2, briefChars: 9000 });
		try {
			await bridge.resolve(input());
			expect(client.lastLimits).toEqual({ memoryLimit: 5, docsLimit: 1, sessionLimit: 2, briefChars: 9000 });
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
				docsLimit: 2,
				sessionLimit: 6,
				briefChars: 0,
				layers: true,
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
				harnessId: "",
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
				harnessId: "",
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
				harnessId: "",
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
			harnessId: "",
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

describe("context layers a team names (project memory, phase one)", () => {
	// A router without a team has no group or personal scope and no harness id:
	// the bridge must then send exactly what it did before, so a block on a
	// lone install is byte-identical to 0.15. A team front door names the
	// layers in headers and the member in the harness id.
	test("resolve passes the group, personal and user layers to assemble; a lone router passes empties", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			await bridge.resolve(input({ group: "group.g1", personal: "ashlands.u.u1", user: "u1" }));
			expect(client.lastLayers).toEqual({ group: "group.g1", personal: "ashlands.u.u1", user: "u1" });
			await bridge.resolve(input({ conversationKey: "k2" }));
			expect(client.lastLayers).toEqual({ group: "", personal: "", user: "" });
			// Either layer alone is a front door; the member goes with it.
			await bridge.resolve(input({ conversationKey: "k3", group: "group.g1", user: "u1" }));
			expect(client.lastLayers).toEqual({ group: "group.g1", personal: "", user: "u1" });
		} finally {
			db.close();
		}
	});

	test("a router on its own sends no user, even though it has a harness id", async () => {
		// Claude Code's wire path derives a harness id and omp sends one, so a
		// lone router is NOT harness-less. Sending it as `user` would make a new
		// agentdox filter the project's recent tail to that harness, dropping
		// every pre-0.16 message and every other harness's turns.
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			await bridge.resolve(input({ user: "claude-code" }));
			expect(client.lastLayers).toEqual({ group: "", personal: "", user: "" });
		} finally {
			db.close();
		}
	});

	test("layers: false sends none, whatever the request names", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client, { layers: false });
		try {
			const pin = await bridge.resolve(input({ group: "group.g1", personal: "ashlands.u.u1", user: "u1" }));
			expect(pin).not.toBeNull();
			expect(client.assembleCalls).toBe(1);
			expect(client.lastLayers).toBeUndefined();
		} finally {
			db.close();
		}
	});

	test("a personal layer pins a different block per member, and the same block for the same member", async () => {
		// The version is a hash of the block's content, so two members' blocks
		// never share a version even in one scope; the shared store keys on it.
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			const ada = await bridge.resolve(input({ conversationKey: "ada", personal: "ashlands.u.ada", user: "ada" }));
			const bob = await bridge.resolve(input({ conversationKey: "bob", personal: "ashlands.u.bob", user: "bob" }));
			const adaAgain = await bridge.resolve(input({ conversationKey: "ada-2", personal: "ashlands.u.ada", user: "ada" }));
			const nobody = await bridge.resolve(input({ conversationKey: "solo" }));
			expect(ada?.block).toContain("ashlands.u.ada");
			expect(bob?.block).toContain("ashlands.u.bob");
			expect(ada?.version).not.toBe(bob?.version);
			expect(adaAgain?.version).toBe(ada?.version ?? "");
			expect(nobody?.version).not.toBe(ada?.version);
			expect(nobody?.block).not.toContain("Your thread");
		} finally {
			db.close();
		}
	});

	test("the recorded turn carries user:<harnessId> on both messages only when the harness is set", async () => {
		const client = mkClient();
		const { bridge, db } = mkBridge(client);
		try {
			const rec = {
				scope: "ashlands",
				title: "movement fix",
				userText: "fix movement",
				assistantText: "done",
				slug: "anthropic/claude-haiku-4.5",
				tier: "simple",
				turnEnded: true,
			};
			bridge.recordTurn({ ...rec, conversationKey: "member", harnessId: "u_ada" });
			bridge.recordTurn({ ...rec, conversationKey: "solo", harnessId: "" });
			await bridge.flush();

			const member = client.appended.filter((m) => m.sessionId === "ses_1");
			expect(member.map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(member[0]?.refs).toEqual(["user:u_ada"]);
			expect(member[1]?.refs).toEqual(["model:anthropic/claude-haiku-4.5", "tier:simple", "user:u_ada"]);

			// No harness id: the refs are exactly what 0.15 wrote.
			const solo = client.appended.filter((m) => m.sessionId === "ses_2");
			expect(solo[0]?.refs).toEqual([]);
			expect(solo[1]?.refs).toEqual(["model:anthropic/claude-haiku-4.5", "tier:simple"]);
		} finally {
			db.close();
		}
	});

	test("the REST client posts the layer keys only when they are non-empty", async () => {
		// An older agentdox ignores unknown keys, so sending them is harmless —
		// but a lone router must post the same body as before, key for key, and
		// a half-named layer set must not post empty strings the server would
		// have to special-case.
		const bodies: Record<string, unknown>[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(JSON.stringify({ prompt: "P" }), { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;
		try {
			const client = createAgentDoxClient({ baseUrl: "http://agentdox.test", token: "t", timeoutMs: 1000, log });
			const limits = { memoryLimit: 8, docsLimit: 2, sessionLimit: 6, briefChars: 0 };
			await client.assemble("ashlands", "q", limits);
			await client.assemble("ashlands", "q", limits, { group: "", personal: "", user: "" });
			await client.assemble("ashlands", "q", limits, { group: "group.g1", personal: "", user: "u1" });
			await client.assemble("ashlands", "q", limits, { group: "group.g1", personal: "ashlands.u.u1", user: "u1" });

			const before = { scope: "ashlands", query: "q", ...limits };
			expect(bodies[0]).toEqual(before);
			expect(bodies[1]).toEqual(before);
			expect(bodies[2]).toEqual({ ...before, group: "group.g1", user: "u1" });
			expect(bodies[3]).toEqual({ ...before, group: "group.g1", personal: "ashlands.u.u1", user: "u1" });
		} finally {
			globalThis.fetch = realFetch;
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
