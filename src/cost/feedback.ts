/**
 * User verdicts on routed turns, from omp (`/router feedback good|bad`).
 *
 * The router otherwise learns only from escalation signals. A person saying
 * a cheap model's answer was wrong — or that it was fine — is the label the
 * de-escalation question needs. Each verdict is tied to the ledger row it
 * judged, so it aggregates by served model, tier and task.
 */

import type { Database } from "bun:sqlite";

export type Verdict = "good" | "bad";

export interface FeedbackRecord {
	ledgerId: string;
	ompSessionId: string;
	slug: string;
	tier: string;
	verdict: Verdict;
	note: string;
}

export interface FeedbackCounts {
	good: number;
	bad: number;
}

export interface FeedbackStore {
	record(rec: FeedbackRecord, nowMs?: number): string;
	/** Verdict counts per served slug since `sinceMs`. */
	countsBySlug(sinceMs: number, harnessId?: string): Map<string, FeedbackCounts>;
	/** Verdicts for one ledger row (a user may re-judge). */
	forLedgerId(ledgerId: string): Array<{ verdict: Verdict; note: string; createdAtMs: number }>;
}

export function createFeedbackStore(db: Database): FeedbackStore {
	const insert = db.query(
		`INSERT INTO feedback (id, ledger_id, omp_session_id, slug, tier, verdict, note, created_at_ms)
		 VALUES ($id, $ledgerId, $ompSessionId, $slug, $tier, $verdict, $note, $createdAtMs)`,
	);
	const bySlug = db.query(
		`SELECT f.slug, f.verdict, COUNT(*) AS n FROM feedback f
		 LEFT JOIN ledger l ON l.id = f.ledger_id
		 WHERE f.created_at_ms >= $since AND ($harness = '' OR l.harness_id = $harness)
		 GROUP BY f.slug, f.verdict`,
	);
	const forRow = db.query("SELECT verdict, note, created_at_ms FROM feedback WHERE ledger_id = ? ORDER BY created_at_ms DESC");
	return {
		record(rec, nowMs = Date.now()) {
			const id = crypto.randomUUID();
			insert.run({
				$id: id,
				$ledgerId: rec.ledgerId,
				$ompSessionId: rec.ompSessionId,
				$slug: rec.slug,
				$tier: rec.tier,
				$verdict: rec.verdict,
				$note: rec.note.slice(0, 500),
				$createdAtMs: nowMs,
			});
			return id;
		},
		countsBySlug(sinceMs, harnessId = "") {
			const out = new Map<string, FeedbackCounts>();
			for (const r of bySlug.all({ $since: sinceMs, $harness: harnessId }) as { slug: string; verdict: string; n: number }[]) {
				const c = out.get(r.slug) ?? { good: 0, bad: 0 };
				if (r.verdict === "good") c.good += r.n;
				else c.bad += r.n;
				out.set(r.slug, c);
			}
			return out;
		},
		forLedgerId(ledgerId) {
			return (forRow.all(ledgerId) as { verdict: Verdict; note: string; created_at_ms: number }[]).map((r) => ({
				verdict: r.verdict,
				note: r.note,
				createdAtMs: r.created_at_ms,
			}));
		},
	};
}
