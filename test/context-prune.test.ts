import { describe, expect, test } from "bun:test";

import { createContextStore } from "../src/context/store.ts";
import { createConversationStore } from "../src/router/state.ts";
import { openDb } from "../src/util/sqlite.ts";

/**
 * `context_blocks` is content-addressed and shared between conversations, so
 * nothing reclaims a block when the conversation that fetched it goes away.
 * Until the prune below was wired into the server's housekeeping timer the table
 * grew for the life of the install (measured on a real install: 220 rows /
 * 2.7 MB, 68 of them referenced by nothing).
 *
 * Age alone is the wrong test, though: a block past the staleness TTL may still
 * be PINNED, and deleting it forces that conversation to refetch and inject
 * different bytes — housekeeping causing a prompt-cache miss. So the safe set is
 * "old AND unreferenced".
 */
describe("context block prune", () => {
	const HOUR = 3_600_000;

	function seed() {
		const db = openDb(":memory:");
		const blocks = createContextStore(db);
		const conversations = createConversationStore(db);
		const now = Date.now();

		blocks.put("scope", { version: "old-pinned", block: "A", fetchedAtMs: now - 5 * HOUR });
		blocks.put("scope", { version: "old-orphan", block: "B", fetchedAtMs: now - 5 * HOUR });
		blocks.put("scope", { version: "fresh-orphan", block: "C", fetchedAtMs: now });

		// One live conversation still pins `old-pinned`.
		const state = conversations.load("conv-1");
		state.contextVersion = "old-pinned";
		state.contextFetchedAtMs = now - 5 * HOUR;
		conversations.save(state);

		return { db, blocks };
	}

	test("drops an old block that nothing references", () => {
		const { db, blocks } = seed();
		expect(blocks.prune(HOUR)).toBe(1);
		expect(blocks.get("old-orphan")).toBeNull();
		db.close();
	});

	test("keeps an old block a conversation still pins", () => {
		const { db, blocks } = seed();
		blocks.prune(HOUR);
		// Deleting this one would cost that conversation its warm prefix.
		expect(blocks.get("old-pinned")?.block).toBe("A");
		db.close();
	});

	test("keeps a block younger than the age cutoff", () => {
		const { db, blocks } = seed();
		blocks.prune(HOUR);
		expect(blocks.get("fresh-orphan")?.block).toBe("C");
		db.close();
	});

	test("is a no-op once the unreferenced blocks are gone", () => {
		const { db, blocks } = seed();
		expect(blocks.prune(HOUR)).toBe(1);
		expect(blocks.prune(HOUR)).toBe(0);
		db.close();
	});

	test("reclaims a block as soon as its last pin is dropped", () => {
		const { db, blocks } = seed();
		const conversations = createConversationStore(db);
		// The conversation moves to a new context version (a refresh), which is
		// what leaves the old block orphaned in production.
		const state = conversations.load("conv-1");
		state.contextVersion = "fresh-orphan";
		conversations.save(state);

		expect(blocks.prune(HOUR)).toBe(2); // old-pinned is now unreferenced too
		expect(blocks.get("old-pinned")).toBeNull();
		expect(blocks.get("fresh-orphan")?.block).toBe("C");
		db.close();
	});
});
