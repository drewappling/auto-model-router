import { describe, expect, test } from "bun:test";

import { createConversationStore } from "../src/router/state.ts";
import { openDb } from "../src/util/sqlite.ts";

function mkStore() {
	const db = openDb(":memory:");
	return { db, store: createConversationStore(db) };
}

describe("conversation spend accounting", () => {
	test("accrue accumulates instead of overwriting", () => {
		const { db, store } = mkStore();
		try {
			store.load("k1");
			store.accrue("k1", { spentUsd: 0.25 });
			store.accrue("k1", { spentUsd: 0.5 });
			store.accrue("k1", { escalations: 1 });
			store.accrue("k1", { escalations: 2 });

			const state = store.get("k1");
			expect(state?.spentUsd).toBeCloseTo(0.75, 10);
			expect(state?.escalations).toBe(3);
		} finally {
			db.close();
		}
	});

	test("save cannot clobber spend booked by a dispatch that never committed", () => {
		// The live bug: a dispatch is billed by the upstream, aborts mid-stream,
		// and returns before the commit path. The NEXT dispatch had already loaded
		// a turn-start snapshot, and `save` wrote that snapshot's stale total back
		// over the aborted dispatch's cost. 30% of real spend vanished this way.
		const { db, store } = mkStore();
		try {
			const snapshot = store.load("k1");
			expect(snapshot.spentUsd).toBe(0);

			// An aborted dispatch books its cost while `snapshot` is still in hand.
			store.accrue("k1", { spentUsd: 0.4, escalations: 1 });

			// The in-flight turn now commits using the state it loaded earlier.
			snapshot.turn = 1;
			snapshot.currentSlug = "cheap/model";
			store.save(snapshot);

			const after = store.get("k1");
			expect(after?.spentUsd).toBeCloseTo(0.4, 10);
			expect(after?.escalations).toBe(1);
			// The latest-wins fields still persist normally.
			expect(after?.turn).toBe(1);
			expect(after?.currentSlug).toBe("cheap/model");
		} finally {
			db.close();
		}
	});

	test("interleaved dispatches both keep their money", () => {
		const { db, store } = mkStore();
		try {
			const a = store.load("k1");
			const b = store.get("k1");
			expect(b).not.toBeNull();

			store.accrue("k1", { spentUsd: 0.1 });
			store.save(a);
			store.accrue("k1", { spentUsd: 0.2 });
			if (b !== null) store.save(b);

			expect(store.get("k1")?.spentUsd).toBeCloseTo(0.3, 10);
		} finally {
			db.close();
		}
	});

	test("a zero delta does not touch the row", () => {
		// Bumping updated_at_ms for a no-op write would keep a dead conversation
		// alive against `prune`, which reaps on that timestamp.
		const { db, store } = mkStore();
		try {
			store.load("k1");
			const before = store.get("k1")?.updatedAtMs ?? 0;
			expect(before).toBeGreaterThan(0);
			store.accrue("k1", { spentUsd: 0, escalations: 0 });
			expect(store.get("k1")?.updatedAtMs).toBe(before);
		} finally {
			db.close();
		}
	});
});
