import { describe, expect, test } from "bun:test";

import { createContextStore } from "../src/context/store.ts";
import { createConversationStore } from "../src/router/state.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateStore } from "../src/util/schema.ts";
import { openSqlDb } from "../src/util/sql.ts";

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

	async function seed() {
		// A file: the shim cannot share `:memory:` between handles, and both
		// stores here read the same tables.
		const db = openSqlDb(join(tmpdir(), `ctxprune-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
		await migrateStore(db);
		const blocks = createContextStore(db);
		const conversations = createConversationStore(db);
		const now = Date.now();

		await blocks.put("scope", { version: "old-pinned", block: "A", fetchedAtMs: now - 5 * HOUR });
		await blocks.put("scope", { version: "old-orphan", block: "B", fetchedAtMs: now - 5 * HOUR });
		await blocks.put("scope", { version: "fresh-orphan", block: "C", fetchedAtMs: now });

		// One live conversation still pins `old-pinned`.
		const state = await conversations.load("conv-1");
		state.contextVersion = "old-pinned";
		state.contextFetchedAtMs = now - 5 * HOUR;
		await conversations.save(state);

		return { db, blocks };
	}

	test("drops an old block that nothing references", async () => {
		const { db, blocks } = await seed();
		expect(await blocks.prune(HOUR)).toBe(1);
		expect(await blocks.get("old-orphan")).toBeNull();
		await db.close();
	});

	test("keeps an old block a conversation still pins", async () => {
		const { db, blocks } = await seed();
		await blocks.prune(HOUR);
		// Deleting this one would cost that conversation its warm prefix.
		expect((await blocks.get("old-pinned"))?.block).toBe("A");
		await db.close();
	});

	test("keeps a block younger than the age cutoff", async () => {
		const { db, blocks } = await seed();
		await blocks.prune(HOUR);
		expect((await blocks.get("fresh-orphan"))?.block).toBe("C");
		await db.close();
	});

	test("is a no-op once the unreferenced blocks are gone", async () => {
		const { db, blocks } = await seed();
		expect(await blocks.prune(HOUR)).toBe(1);
		expect(await blocks.prune(HOUR)).toBe(0);
		await db.close();
	});

	test("reclaims a block as soon as its last pin is dropped", async () => {
		const { db, blocks } = await seed();
		const conversations = createConversationStore(db);
		// The conversation moves to a new context version (a refresh), which is
		// what leaves the old block orphaned in production.
		const state = await conversations.load("conv-1");
		state.contextVersion = "fresh-orphan";
		await conversations.save(state);

		expect(await blocks.prune(HOUR)).toBe(2); // old-pinned is now unreferenced too
		expect(await blocks.get("old-pinned")).toBeNull();
		expect((await blocks.get("fresh-orphan"))?.block).toBe("C");
		await db.close();
	});
});
