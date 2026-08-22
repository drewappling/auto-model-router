/**
 * Pure toast selection logic, extracted from the omp extension so it can be
 * unit-tested without omp's runtime.
 *
 * The router ledger is ordered `created_at_ms DESC` (newest first). The toast
 * must:
 *   - only toast entries newer than the last one already seen;
 *   - skip `wasted` entries (escalation book-keeping — the abandoned probe
 *     attempt that was superseded and never served the client);
 *   - surface the attempt that actually served, oldest→newest.
 */

/** Subset of a ledger entry (see src/cost/types.ts LedgerEntry). */
export interface ToastDecision {
	id: string;
	slug: string;
	servedSlug: string | null;
	tier: string;
	reportedUsd: number | null;
	wasted: boolean;
	/** Harness id from the request header; empty for the default harness. */
	harnessId: string;
}

export interface ToastMessage {
	model: string;
	tier: string;
	costUsd: number | null;
	/** Human-readable line for `ctx.ui.notify`. */
	text: string;
}

export function toToastText(d: ToastDecision): string {
	const model = d.servedSlug ?? d.slug;
	const cost = d.reportedUsd === null ? "" : ` \u00b7 $${d.reportedUsd.toFixed(5)}`;
	return `${model} [${d.tier}]${cost}`;
}

/**
 * Given the newest-first ledger window and the last-toasted entry id, return
 * the new toasts to raise, oldest→newest. Pass `lastSeenId === null` on the
 * first tick to toast nothing (avoids a burst on startup).
 *
 * When `harnessId` is non-empty, only entries from that harness are toasted,
 * so multiple harnesses sharing one router don't spam each other's toasts.
 */
export function selectToasts(
	entries: ToastDecision[],
	lastSeenId: string | null,
	harnessId = "",
): ToastMessage[] {
	if (lastSeenId === null) return [];
	// `entries` is newest-first. Entries strictly newer than lastSeenId are the
	// contiguous prefix before it. `-1` (id rolled out of the window) → treat
	// every entry as new.
	const idx = entries.findIndex((e) => e.id === lastSeenId);
	const newer = idx === -1 ? entries : entries.slice(0, idx);
	const out: ToastMessage[] = [];
	for (let i = newer.length - 1; i >= 0; i--) {
		const d = newer[i];
		if (d === undefined) continue;
		if (d.wasted) continue;
		if (harnessId !== "" && d.harnessId !== harnessId) continue;
		out.push({ model: d.servedSlug ?? d.slug, tier: d.tier, costUsd: d.reportedUsd, text: toToastText(d) });
	}
	return out;
}

/** The newest entry id in a newest-first list, for advancing `lastSeenId`. */
export function newestId(entries: ToastDecision[]): string | null {
	const first = entries[0];
	return first === undefined ? null : first.id;
}
