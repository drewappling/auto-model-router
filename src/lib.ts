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
export { setKnownUpstreamIds, providerOfSlug } from "./cost/report.ts";
export type { DeepPartial } from "./config/load.ts";
export { buildUsageReport, renderUsageReport, type UsageReport, type ReportTotals } from "./cost/report.ts";
export { buildDailySummary, renderDailySummary, type DailySummary } from "./cost/summary.ts";
export { openDb } from "./util/sqlite.ts";
export { spendUsdSince, feedbackView, exportRows, exportCsv, decisionEntries, harnessScopeParam, type HarnessScope, type ExportRow, type FeedbackRow, type FeedbackByModel, type FeedbackView, type DecisionEntry, type DecisionFilter } from "./cost/views.ts";
export { createLedger } from "./cost/ledger.ts";
export { createFeedbackStore, type FeedbackStore, type FeedbackRecord } from "./cost/feedback.ts";
export { buildExecutable, collectPackageFiles, executableFileName, hostTarget, isExecutableTarget, EXECUTABLE_TARGETS, type ExecutableTarget, type BuildExecutableResult } from "./cli/build-executable.ts";
export { parseSkillsBundle, type SkillsBundle } from "./cli/skills.ts";
export type { RequestPolicy } from "./wire/types.ts";
export type { CatalogView, CatalogViewModel } from "./server/catalog-view.ts";
export type { Ledger, LedgerEntry, PruneResult } from "./cost/types.ts";
// Retention: a front door asks through `POST /v1/router/prune` rather than
// deleting from the ledger itself. The interval is exported so it can say when.
export { RETENTION_INTERVAL_MS } from "./cost/retention.ts";
