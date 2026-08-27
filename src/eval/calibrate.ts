/**
 * Calibration: map raw suite scores (mean grade, 0-1) onto the Artificial
 * Analysis 0-100 index the tier floors are defined against.
 *
 * A home-grown "0.72" is meaningless next to AA's "72" unless the two scales are
 * tied together. We do that empirically: run the SAME suite on models AA has
 * already scored (the anchors), fit raw -> AA per axis by least squares, then
 * apply that line to the unscored targets. Without enough anchors on an axis we
 * emit nothing for it — honest degradation, never an imputed number.
 */

import type { QualityAxis } from "../config/types.ts";
import type { FeedScore } from "../catalog/benchmark-feeds.ts";
import { normalizeModelKey } from "../catalog/benchmark-feeds.ts";
import type { AxisScore, EvalResult } from "./run.ts";

/** Minimum anchor models with a known AA score on an axis before we trust a fit. */
export const MIN_ANCHORS = 3;

/** Minimum Pearson correlation between raw suite scores and AA before a fit is trusted. */
export const MIN_R = 0.5;

export interface LineFit {
	slope: number;
	intercept: number;
	/** Pearson correlation of the anchor fit, 0-1. A quality signal on the calibration itself. */
	r: number;
	/** Anchors used. */
	n: number;
}

export type Calibration = Partial<Record<QualityAxis, LineFit>>;

export interface AnchorPoint {
	/** Raw mean grade on the axis, 0-1. */
	raw: number;
	/** Known AA index on the axis, 0-100. */
	aa: number;
}

/**
 * OLS fit, or null when the calibration cannot be trusted: too few points, no
 * spread, a non-positive slope, or weak correlation. A suite that does not track
 * AA positively and with real correlation would turn a target's score into noise
 * dressed as signal, so we refuse it and emit nothing for that axis.
 */
export function fitAxis(points: readonly AnchorPoint[]): LineFit | null {
	if (points.length < MIN_ANCHORS) return null;
	const n = points.length;
	let sx = 0;
	let sy = 0;
	for (const p of points) {
		sx += p.raw;
		sy += p.aa;
	}
	const mx = sx / n;
	const my = sy / n;
	let sxx = 0;
	let syy = 0;
	let sxy = 0;
	for (const p of points) {
		const dx = p.raw - mx;
		const dy = p.aa - my;
		sxx += dx * dx;
		syy += dy * dy;
		sxy += dx * dy;
	}
	// No spread on either axis ⇒ undefined slope or correlation.
	if (sxx < 1e-9 || syy < 1e-9) return null;
	const slope = sxy / sxx;
	const r = sxy / Math.sqrt(sxx * syy);
	// The suite must rank models the same way AA does, and meaningfully so.
	if (slope <= 0 || r < MIN_R) return null;
	return { slope, intercept: my - slope * mx, r, n };
}

export function applyFit(fit: LineFit, raw: number): number {
	const y = fit.slope * raw + fit.intercept;
	return Math.min(100, Math.max(0, y));
}

const AXES: readonly QualityAxis[] = ["coding", "intelligence", "agentic"];

/**
 * Fit every axis from the anchors' raw suite scores paired with their known AA
 * scores. `anchorAa` supplies the AA index per slug+axis (absent ⇒ that anchor
 * is not used on that axis).
 */
export function fitCalibration(
	anchors: readonly EvalResult[],
	anchorAa: (slug: string, axis: QualityAxis) => number | undefined,
): Calibration {
	const cal: Calibration = {};
	for (const axis of AXES) {
		const points: AnchorPoint[] = [];
		for (const r of anchors) {
			const raw = axisMean(r.axes[axis]);
			const aa = anchorAa(r.slug, axis);
			if (raw !== null && aa !== undefined) points.push({ raw, aa });
		}
		const fit = fitAxis(points);
		if (fit !== null) cal[axis] = fit;
	}
	return cal;
}

function axisMean(a: AxisScore | undefined): number | null {
	return a === undefined || a.n === 0 ? null : a.sum / a.n;
}

/** Calibrated local FeedScores for the targets, one axis at a time, skipping axes with no fit. */
export function toLocalFeedScores(
	targets: readonly EvalResult[],
	cal: Calibration,
	authorOf: (slug: string) => string,
): FeedScore[] {
	const out: FeedScore[] = [];
	for (const r of targets) {
		const entry: FeedScore = { key: normalizeModelKey(r.slug), creator: authorOf(r.slug), source: "local" };
		let any = false;
		for (const axis of AXES) {
			const fit = cal[axis];
			const raw = axisMean(r.axes[axis]);
			if (fit === undefined || raw === null) continue;
			entry[axis] = applyFit(fit, raw);
			any = true;
		}
		if (any) out.push(entry);
	}
	return out;
}
