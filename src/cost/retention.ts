/**
 * Ledger retention: how long turns are kept, and who is allowed to say so.
 *
 * The rule lives here rather than in the server's timer callback for two
 * reasons. The interval has to be enforced in ONE place — the housekeeping
 * timer ticks every minute, the boot path runs early, and `POST
 * /v1/router/prune` can arrive at any moment, and a delete over the whole
 * ledger is not something that should be able to run on every one of those.
 * And a front door of the team edition must never delete from the ledger
 * itself (it holds a read-only handle by design), so the route is the only way
 * it can ask, which makes the once-an-hour gate part of the contract rather
 * than a detail of the caller.
 */

import type { Ledger, PruneResult } from "./types.ts";

/** Floor between two scheduled prunes. A retention window is measured in days; an hour is fine grain for it. */
export const RETENTION_INTERVAL_MS = 3_600_000;

export interface RetentionRunner {
	/** Prunes when the interval has elapsed since the last run; null when it was skipped. */
	maybeRun(nowMs?: number): PruneResult | null;
	/** Prunes regardless (the route), and satisfies the schedule for the next hour. */
	runNow(nowMs?: number): PruneResult;
	/** The configured window this runner would apply, for a caller that reports it. */
	retentionDays(): number | null;
}

/**
 * Builds the runner over a live config read.
 *
 * `retentionDays` is read through a function, not captured, so a hot reload or
 * an embedder's `reconfigure` changes the window without restarting anything —
 * and so lowering it takes effect on the next tick rather than the next boot.
 */
export function createRetentionRunner(opts: {
	ledger: Ledger;
	retentionDays: () => number | null;
	intervalMs?: number;
}): RetentionRunner {
	const intervalMs = opts.intervalMs ?? RETENTION_INTERVAL_MS;
	// Never run: the first call is always due, so a lowered window applies at boot.
	let lastRunMs: number | null = null;
	const run = (nowMs: number): PruneResult => {
		lastRunMs = nowMs;
		return opts.ledger.prune?.(opts.retentionDays(), nowMs) ?? { deleted: 0, oldestKeptMs: null };
	};
	return {
		maybeRun(nowMs = Date.now()) {
			if (lastRunMs !== null && nowMs - lastRunMs < intervalMs) return null;
			return run(nowMs);
		},
		runNow(nowMs = Date.now()) {
			return run(nowMs);
		},
		retentionDays: opts.retentionDays,
	};
}
