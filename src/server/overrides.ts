/**
 * Per-session routing overrides set from omp (`/router pin`, `/router tier`).
 *
 * Keyed by the omp session id the embed extension sends as `X-Omp-Session`,
 * so an override never leaks into another session sharing the router.
 * Process-local on purpose: an override is a user's momentary intent, not
 * state to survive a restart. `turns` counts down per committed dispatch;
 * 0 means until cleared or the entry expires.
 */

import type { Tier } from "../router/types.ts";

export interface SessionOverride {
	/** Model to route every turn to, when set. */
	slug: string | null;
	/** Tier to classify every turn as, when set. */
	tier: Tier | null;
	/** Dispatches left; 0 ⇒ unlimited. */
	turnsLeft: number;
	setAtMs: number;
}

export interface SessionOverrides {
	get(ompSessionId: string): SessionOverride | null;
	set(ompSessionId: string, override: { slug?: string | null; tier?: Tier | null; turns?: number }, nowMs?: number): SessionOverride;
	clear(ompSessionId: string): void;
	/** A committed dispatch used one turn of the override. */
	consume(ompSessionId: string): void;
	/** Every live override, for status. */
	list(): Array<{ ompSessionId: string } & SessionOverride>;
}

/** Overrides older than this are forgotten: a session that idled a day is a new session. */
export const OVERRIDE_TTL_MS = 12 * 60 * 60 * 1000;

export function createSessionOverrides(): SessionOverrides {
	const map = new Map<string, SessionOverride>();
	const live = (id: string, nowMs: number): SessionOverride | null => {
		const o = map.get(id);
		if (o === undefined) return null;
		if (nowMs - o.setAtMs > OVERRIDE_TTL_MS) {
			map.delete(id);
			return null;
		}
		return o;
	};
	return {
		get(id) {
			if (id === "") return null;
			const o = live(id, Date.now());
			return o !== null && (o.slug !== null || o.tier !== null) ? o : null;
		},
		set(id, over, nowMs = Date.now()) {
			const prev = live(id, nowMs) ?? { slug: null, tier: null, turnsLeft: 0, setAtMs: nowMs };
			const next: SessionOverride = {
				slug: over.slug === undefined ? prev.slug : over.slug,
				tier: over.tier === undefined ? prev.tier : over.tier,
				turnsLeft: over.turns === undefined ? prev.turnsLeft : Math.max(0, Math.floor(over.turns)),
				setAtMs: nowMs,
			};
			map.set(id, next);
			return next;
		},
		clear(id) {
			map.delete(id);
		},
		consume(id) {
			const o = map.get(id);
			if (o === undefined || o.turnsLeft === 0) return;
			o.turnsLeft -= 1;
			if (o.turnsLeft === 0) map.delete(id);
		},
		list() {
			const now = Date.now();
			const out: Array<{ ompSessionId: string } & SessionOverride> = [];
			for (const [id] of map) {
				const o = live(id, now);
				if (o !== null) out.push({ ompSessionId: id, ...o });
			}
			return out;
		},
	};
}
