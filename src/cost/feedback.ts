/**
 * User verdicts on routed turns, from omp (`/router feedback good|bad`).
 *
 * The router otherwise learns only from escalation signals. A person saying
 * a cheap model's answer was wrong — or that it was fine — is the label the
 * de-escalation question needs. Each verdict is tied to the ledger row it
 * judged, so it aggregates by served model, tier and task.
 */

import { num, type SqlDb } from "../util/sql.ts";

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

/** Asynchronous throughout: the store may be a shared database, not a file. */
export interface FeedbackStore {
	record(rec: FeedbackRecord, nowMs?: number): Promise<string>;
	/** Verdict counts per served slug since `sinceMs`. */
	countsBySlug(sinceMs: number, harnessId?: string): Promise<Map<string, FeedbackCounts>>;
	/** Verdicts for one ledger row (a user may re-judge). */
	forLedgerId(ledgerId: string): Promise<Array<{ verdict: Verdict; note: string; createdAtMs: number }>>;
}

export function createFeedbackStore(db: SqlDb): FeedbackStore {
	const { sql } = db;
	return {
		async record(rec, nowMs = Date.now()) {
			const id = crypto.randomUUID();
			await sql`
				INSERT INTO feedback (id, ledger_id, omp_session_id, slug, tier, verdict, note, created_at_ms)
				VALUES (${id}, ${rec.ledgerId}, ${rec.ompSessionId}, ${rec.slug}, ${rec.tier}, ${rec.verdict},
					${rec.note.slice(0, 500)}, ${nowMs})`;
			return id;
		},

		async countsBySlug(sinceMs, harnessId = "") {
			const out = new Map<string, FeedbackCounts>();
			// An empty harness means "every harness"; the join only matters when
			// scoping, because the judging harness lives on the ledger row.
			const rows = await db.query<{ slug: string; verdict: string; n: unknown }>(
				`SELECT f.slug, f.verdict, COUNT(*) AS n FROM feedback f
				 LEFT JOIN ledger l ON l.id = f.ledger_id
				 WHERE f.created_at_ms >= $since AND ($harness = '' OR l.harness_id = $harness)
				 GROUP BY f.slug, f.verdict`,
				{ since: sinceMs, harness: harnessId },
			);
			for (const r of rows) {
				const c = out.get(r.slug) ?? { good: 0, bad: 0 };
				if (r.verdict === "good") c.good += num(r.n);
				else c.bad += num(r.n);
				out.set(r.slug, c);
			}
			return out;
		},

		async forLedgerId(ledgerId) {
			const rows = await db.query<{ verdict: Verdict; note: string; created_at_ms: unknown }>(
				"SELECT verdict, note, created_at_ms FROM feedback WHERE ledger_id = $id ORDER BY created_at_ms DESC",
				{ id: ledgerId },
			);
			return rows.map((r) => ({ verdict: r.verdict, note: r.note, createdAtMs: num(r.created_at_ms) }));
		},
	};
}
