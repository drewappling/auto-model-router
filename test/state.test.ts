import { describe, expect, test } from "bun:test";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConversationStore } from "../src/router/state.ts";
import { migrateStore } from "../src/util/schema.ts";
import { openSqlDb } from "../src/util/sql.ts";

async function mkStore() {
	// A file per store: the shim cannot share `:memory:` between handles, and a
	// real deployment is a file (or a database) anyway.
	const db = openSqlDb(join(tmpdir(), `state-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
	await migrateStore(db);
	return { db, store: createConversationStore(db) };
}

describe("conversation spend accounting", () => {
	test("accrue accumulates instead of overwriting", async () => {
		const { db, store } = await mkStore();
		try {
			await store.load("k1");
			await store.accrue("k1", { spentUsd: 0.25 });
			await store.accrue("k1", { spentUsd: 0.5 });
			await store.accrue("k1", { escalations: 1 });
			await store.accrue("k1", { escalations: 2 });

			const state = await store.get("k1");
			expect(state?.spentUsd).toBeCloseTo(0.75, 10);
			expect(state?.escalations).toBe(3);
		} finally {
			await db.close();
		}
	});

	test("save cannot clobber spend booked by a dispatch that never committed", async () => {
		// The live bug: a dispatch is billed by the upstream, aborts mid-stream,
		// and returns before the commit path. The NEXT dispatch had already loaded
		// a turn-start snapshot, and `save` wrote that snapshot's stale total back
		// over the aborted dispatch's cost. 30% of real spend vanished this way.
		const { db, store } = await mkStore();
		try {
			const snapshot = await store.load("k1");
			expect(snapshot.spentUsd).toBe(0);

			// An aborted dispatch books its cost while `snapshot` is still in hand.
			await store.accrue("k1", { spentUsd: 0.4, escalations: 1 });

			// The in-flight turn now commits using the state it loaded earlier.
			snapshot.turn = 1;
			snapshot.currentSlug = "cheap/model";
			await store.save(snapshot);

			const after = await store.get("k1");
			expect(after?.spentUsd).toBeCloseTo(0.4, 10);
			expect(after?.escalations).toBe(1);
			// The latest-wins fields still persist normally.
			expect(after?.turn).toBe(1);
			expect(after?.currentSlug).toBe("cheap/model");
		} finally {
			await db.close();
		}
	});

	test("interleaved dispatches both keep their money", async () => {
		const { db, store } = await mkStore();
		try {
			const a = await store.load("k1");
			const b = await store.get("k1");
			expect(b).not.toBeNull();

			await store.accrue("k1", { spentUsd: 0.1 });
			await store.save(a);
			await store.accrue("k1", { spentUsd: 0.2 });
			if (b !== null) await store.save(b);

			expect((await store.get("k1"))?.spentUsd).toBeCloseTo(0.3, 10);
		} finally {
			await db.close();
		}
	});

	test("a zero delta does not touch the row", async () => {
		// Bumping updated_at_ms for a no-op write would keep a dead conversation
		// alive against `prune`, which reaps on that timestamp.
		const { db, store } = await mkStore();
		try {
			await store.load("k1");
			const before = (await store.get("k1"))?.updatedAtMs ?? 0;
			expect(before).toBeGreaterThan(0);
			await store.accrue("k1", { spentUsd: 0, escalations: 0 });
			expect((await store.get("k1"))?.updatedAtMs).toBe(before);
		} finally {
			await db.close();
		}
	});
});
