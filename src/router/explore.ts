/**
 * Exploration primitives.
 *
 * Two experiments share one rule: the draw must be a pure function of the
 * turn's identity, never `Math.random()`. Every stage of this pipeline is
 * deterministic so `auto-model-router explain` can replay a past decision
 * offline, and a random draw would silently break that. Hashing also keeps a
 * draw stable across the failover retries of a single turn.
 */

import type { RouterConfig } from "../config/types.ts";
import { sha256Hex } from "../util/hash.ts";

/** Deterministic uniform draw in [0,1) from an arbitrary seed string. */
export function explorationDraw(seed: string): number {
	// 8 hex chars = 32 bits of the digest, divided by 2^32.
	return Number.parseInt(sha256Hex(seed).slice(0, 8), 16) / 0x1_0000_0000;
}

/** The hold length in force for a conversation, and whether it was drawn. */
export interface HoldChoice {
	turns: number;
	/**
	 * The randomised arm this conversation was assigned, or null when hold
	 * exploration is off. Recorded on every turn of the conversation, not only
	 * the ones the hold actually affects, so the comparison between arms is a
	 * clean intention-to-treat one.
	 */
	arm: number | null;
}

/**
 * Resolves how long to hold a tier after this turn.
 *
 * Only the POST-ESCALATION hold is randomised. That is the one that governs
 * expensive spend -- a turn escalates once and the hold then bills the next
 * several turns at the escalated tier -- and leaving the ordinary hold alone
 * keeps the experiment narrow enough to read.
 *
 * The arm is drawn from the conversation key alone, so it is constant for the
 * life of a conversation. A length that changed mid-hold would measure
 * nothing.
 */
export function resolveHoldTurns(cfg: RouterConfig, conversationKey: string, escalated: boolean): HoldChoice {
	const hx = cfg.exploration.holdTurns;
	const exploring = cfg.exploration.enabled && hx.enabled && hx.values.length > 0;

	const arm = exploring ? drawArm(hx.values, conversationKey) : null;
	if (!escalated) return { turns: cfg.hysteresis.holdTurns, arm };
	return { turns: arm ?? cfg.hysteresis.holdTurnsAfterEscalation, arm };
}

function drawArm(values: readonly number[], conversationKey: string): number | null {
	const draw = explorationDraw(`hold:${conversationKey}`);
	// Math.min guards the draw === 1 boundary, which the division cannot
	// produce today but would if the bit width ever changed.
	const idx = Math.min(Math.floor(draw * values.length), values.length - 1);
	return values[idx] ?? null;
}
