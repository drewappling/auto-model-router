#!/usr/bin/env bun
/**
 * Fit the learned escalation-risk model on the ledger and write it out.
 *
 *   bun tools/train-classifier.ts                 # evaluate + write $AUTO_MODEL_ROUTER_HOME/classifier-learned.json
 *   bun tools/train-classifier.ts --dry-run       # evaluate only
 *   bun tools/train-classifier.ts --days 30       # bound the training window
 *   bun tools/train-classifier.ts --out path.json
 *
 * Label: the served turn escalated — a cheaper attempt was probe-rejected
 * first (attempt > 0). Split: the oldest 80% train, the newest 20% test, so
 * the score is what the model would have done on turns it had not seen.
 * Prints holdout AUC for the learned model and for the heuristic's own score,
 * plus precision/recall at a few thresholds. Read-only on the ledger.
 *
 * Then set `classifier.learnedModelPath` to the written file: the router
 * records `learned: p(escalate)=…` on every decision, advisory only.
 */

import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { loadConfig } from "../src/config/load.ts";
import { auc, FEATURE_NAMES, LEARNED_MODEL_VERSION, learnedVector, type LearnedModel, trainLogistic } from "../src/router/learned.ts";
import type { Features } from "../src/router/types.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};
const dryRun = argv.includes("--dry-run");
const days = Number.parseInt(flag("--days") ?? "0", 10);
const cfg = loadConfig({});
const out = flag("--out") ?? join(dirname(cfg.ledger.path), "classifier-learned.json");

const db = new Database(cfg.ledger.path, { readonly: true });
const since = days > 0 ? Date.now() - days * 86_400_000 : 0;
// For the heuristic baseline on an escalated turn, the score that MATTERS is
// the one the rejected first attempt was routed on; the served row carries the
// escalation classification (score 1 by construction), which would leak the label.
const rows = db
	.query(
		`SELECT l.features, l.attempt,
			COALESCE((SELECT w.score FROM ledger w WHERE w.conversation_key = l.conversation_key AND w.turn = l.turn AND w.attempt = 0 AND w.wasted = 1 LIMIT 1), l.score) AS score
		 FROM ledger l
		 WHERE l.features IS NOT NULL AND l.wasted = 0 AND l.error IS NULL AND l.created_at_ms >= ?
		 ORDER BY l.created_at_ms ASC`,
	)
	.all(since) as { features: string; attempt: number; score: number | null }[];
db.close();
if (rows.length < 200) {
	console.error(`only ${rows.length} rows with features; need a few hundred to fit anything`);
	process.exit(2);
}

const xs = rows.map((r) => learnedVector(JSON.parse(r.features) as Partial<Features>));
const ys: number[] = rows.map((r) => (r.attempt > 0 ? 1 : 0));
const heuristic = rows.map((r) => r.score ?? 0);
const split = Math.floor(rows.length * 0.8);
const fit = trainLogistic(xs.slice(0, split), ys.slice(0, split));
const model: LearnedModel = {
	version: LEARNED_MODEL_VERSION,
	trainedAtMs: Date.now(),
	rows: rows.length,
	positives: ys.reduce((s, y) => s + y, 0),
	names: [...FEATURE_NAMES],
	means: fit.means,
	stds: fit.stds,
	weights: fit.weights,
	bias: fit.bias,
	auc: 0,
};
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const score = (x: number[]): number => {
	let z = model.bias;
	for (let j = 0; j < x.length; j++) z += model.weights[j]! * ((x[j]! - model.means[j]!) / model.stds[j]!);
	return sigmoid(z);
};
const testX = xs.slice(split);
const testY = ys.slice(split);
const testP = testX.map(score);
model.auc = auc(testP, testY);
const heuristicAuc = auc(heuristic.slice(split), testY);

console.log(`rows ${rows.length} (train ${split}, test ${rows.length - split}); positives ${model.positives} (${((100 * model.positives) / rows.length).toFixed(2)}%)`);
console.log(`holdout AUC: learned ${model.auc.toFixed(3)}   heuristic score ${heuristicAuc.toFixed(3)}`);
console.log("\nprecision / recall on the holdout at p(escalate) thresholds:");
for (const t of [0.5, 0.7, 0.8, 0.9]) {
	let tp = 0;
	let fp = 0;
	let fn = 0;
	testP.forEach((p, i) => {
		const y = testY[i]!;
		if (p >= t && y === 1) tp++;
		else if (p >= t) fp++;
		else if (y === 1) fn++;
	});
	const prec = tp + fp > 0 ? tp / (tp + fp) : 0;
	const rec = tp + fn > 0 ? tp / (tp + fn) : 0;
	console.log(`  p ≥ ${t.toFixed(1)}  flagged ${String(tp + fp).padStart(5)}  precision ${(100 * prec).toFixed(1).padStart(5)}%  recall ${(100 * rec).toFixed(1).padStart(5)}%`);
}
console.log("\nweights (standardised; positive ⇒ more likely to escalate):");
const ranked = model.names.map((n, i) => [n, model.weights[i]!] as const).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
for (const [n, w] of ranked.slice(0, 12)) console.log(`  ${n.padEnd(30)} ${w >= 0 ? "+" : ""}${w.toFixed(3)}`);

if (dryRun) {
	console.log("\ndry run: nothing written");
} else {
	await Bun.write(out, JSON.stringify(model, null, 1));
	console.log(`\nwrote ${out}\nset classifier.learnedModelPath to it to record learned risk on every decision (advisory).`);
}
