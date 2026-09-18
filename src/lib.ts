/**
 * Public programmatic API of auto-model-router, for projects that embed the
 * router rather than run the binary (the team edition does). Everything else
 * under src/ is internal and may change between patch releases; this file is
 * the contract.
 *
 *   import { startServer, loadConfig } from "auto-model-router";
 *
 *   const cfg = loadConfig({ overrides: { server: { host: "127.0.0.1", port: 0, apiKey: "internal" } } });
 *   const router = startServer(cfg);
 *   router.server.port; // the bound port; talk HTTP to it, or embed further
 *   await router.stop();
 */

export { startServer, type ReconfigureResult, type StartedServer } from "./server/http.ts";
export { loadConfig, apiKeySource } from "./config/load.ts";
export { DEFAULT_CONFIG } from "./config/defaults.ts";
export type { RedactionConfig, RedactionRule, RouterConfig, UpstreamEntry, UpstreamKind, UpstreamModelConfig } from "./config/types.ts";
// A front door that lets an operator type a redaction rule validates it with
// the same guard the router refuses it with, before the rule is ever saved.
export { validateRedactionPattern, validateRedactionRule, defaultReplacement, MAX_REDACTION_RULES } from "./config/redaction.ts";
export { RESERVED_UPSTREAM_IDS } from "./config/schema.ts";
// `benchmarks.extraScores`: a front door supplies scores for axes the feeds leave
// empty. The row shape and the two provenances config may claim are exported so
// it can build and check the table against the same rules the router applies —
// including the cap, past which the excess is dropped. There is deliberately no
// writer for `local_scores` here: that table belongs to the eval runner and is
// gated by `benchmarks.useLocalScores`, and a front door writing into it would
// make the router's own switch a lie.
export { MAX_EXTRA_SCORES, SUPPLIED_SOURCES, FILL_ORDER, type FeedScore, type FeedSource } from "./catalog/benchmark-feeds.ts";
export { setKnownUpstreamIds, providerOfSlug } from "./cost/report.ts";
export type { DeepPartial } from "./config/load.ts";
export { buildUsageReport, renderUsageReport, type UsageReport, type ReportTotals } from "./cost/report.ts";
export { buildDailySummary, renderDailySummary, type DailySummary } from "./cost/summary.ts";
export { openDb } from "./util/sqlite.ts";
// A front door reads the ledger through the engine-agnostic handle: the store
// may be a file or a shared database, and the view functions take this.
export { dialectOf, openSqlDb, num, numOrNull, type Dialect, type SqlDb } from "./util/sql.ts";
export { spendUsdSince, feedbackView, exportRows, exportCsv, decisionEntries, harnessScopeParam, type HarnessScope, type ExportRow, type FeedbackRow, type FeedbackByModel, type FeedbackView, type DecisionEntry, type DecisionFilter } from "./cost/views.ts";
export { createSqlLedger } from "./cost/ledger-sql.ts";
export { migrateStore, STORE_TABLES } from "./util/schema.ts";
export { createFeedbackStore, type FeedbackStore, type FeedbackRecord } from "./cost/feedback.ts";
export { buildExecutable, collectPackageFiles, executableFileName, hostTarget, isExecutableTarget, EXECUTABLE_TARGETS, type ExecutableTarget, type BuildExecutableResult } from "./cli/build-executable.ts";
export { parseSkillsBundle, type SkillsBundle } from "./cli/skills.ts";
export type { RequestPolicy } from "./wire/types.ts";
export type { CatalogView, CatalogViewModel } from "./server/catalog-view.ts";
export type { AsyncLedger, LedgerEntry, PruneResult } from "./cost/types.ts";
// Retention: a front door asks through `POST /v1/router/prune` rather than
// deleting from the ledger itself. The interval is exported so it can say when.
export { RETENTION_INTERVAL_MS } from "./cost/retention.ts";
// Request ids. A front door that stamps `x-request-id` and then looks a turn up
// by it judges an id with the SAME rules the router carried it under, and tells
// a minted id from one its own edge assigned — rather than reimplementing either.
export { acceptRequestId, isRequestId, isMintedRequestId, mintRequestId, requestIdFor, MINTED_REQUEST_ID_PREFIX, REQUEST_ID_MAX_LENGTH } from "./util/requestid.ts";
