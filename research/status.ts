/**
 * Quick "is the experiment actually running?" check.
 *
 * Distinct from analyze-ledger.ts, which reads results. This answers the
 * narrower question you ask right after a restart: is the fork serving turns,
 * and are both experiments recording?
 *
 * Usage: bun run research/status.ts [path-to-router.db]
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

const path = process.argv[2] ?? join(homedir(), ".auto-model-router", "router.db");
const db = new Database(path, { readonly: true });

const one = <T>(sql: string): T => db.query(sql).get() as T;

const version = one<{ user_version: number }>("PRAGMA user_version").user_version;
const total = one<{ n: number }>("SELECT COUNT(*) AS n FROM ledger").n;

// Instrumented rows are the only ones the fork can have written, so they are
// the dividing line between "old build" and "this build" traffic.
const instrumented = one<{ n: number }>("SELECT COUNT(*) AS n FROM ledger WHERE features IS NOT NULL").n;
const withArm = one<{ n: number }>("SELECT COUNT(*) AS n FROM ledger WHERE hold_arm IS NOT NULL").n;
const explored = one<{ n: number }>("SELECT COUNT(*) AS n FROM ledger WHERE explored_from IS NOT NULL").n;
const newest = one<{ m: number | null }>("SELECT MAX(created_at_ms) AS m FROM ledger").m;
const newestInstrumented = one<{ m: number | null }>(
	"SELECT MAX(created_at_ms) AS m FROM ledger WHERE features IS NOT NULL",
).m;

const stamp = (ms: number | null): string => (ms === null ? "never" : new Date(ms).toISOString());
const ok = (b: boolean): string => (b ? "OK  " : "WAIT");

console.log(`db                 ${path}`);
console.log(`schema             v${version}${version === 8 ? "" : "   <-- expected v8"}`);
console.log(`rows               ${total}`);
console.log("");
console.log(`${ok(instrumented > 0)} instrumented    ${instrumented}  (feature vectors recorded)`);
console.log(`${ok(withArm > 0)} hold arms       ${withArm}  (should equal instrumented once the hold experiment is live)`);
console.log(`${ok(explored > 0)} explored        ${explored}  (sampled, so stays 0 for a while at low rates)`);
console.log("");
console.log(`newest row             ${stamp(newest)}`);
console.log(`newest instrumented    ${stamp(newestInstrumented)}`);

if (instrumented > 0 && withArm < instrumented) {
	console.log("");
	console.log(`note: ${instrumented - withArm} instrumented row(s) have no hold arm.`);
	console.log("      Rows written before the hold experiment shipped are expected to be null.");
	console.log("      If the count keeps growing, the running router predates it -- restart omp.");
}

db.close();
