import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "bun";
import { createProviders } from "./providers.ts";
import { createBridgeFromConfig } from "../context/index.ts";
import { createFeedbackStore, type Verdict } from "../cost/feedback.ts";
import { createLedger } from "../cost/ledger.ts";
import { createRetentionRunner } from "../cost/retention.ts";
import { redactionRulesFor } from "../config/redaction.ts";
import { createSessionOverrides } from "./overrides.ts";
import { catalogView } from "./catalog-view.ts";
import { buildUpstreamModels } from "../catalog/static-catalog.ts";
import { invalidateFeedCache } from "../catalog/benchmark-feeds.ts";
import { applyRequestPolicy, resolveProfile } from "../router/index.ts";
import { parsePolicyHeader } from "../wire/openai/request.ts";
import { createDigester } from "./digest.ts";
import { runEval, type Completer } from "../eval/run.ts";
import type { QualityAxis } from "../config/types.ts";
import { fitCalibration, pickAnchors, toLocalFeedScores, MIN_ANCHORS } from "../eval/calibrate.ts";
import { makeJudge } from "../eval/judge.ts";
import { loadLocalScores, saveLocalScores } from "../catalog/benchmark-feeds.ts";
import { advise } from "./advise.ts";
import { TIER_ORDER, type Tier } from "../router/types.ts";
import { baselinePrices, buildUsageReport, renderUsageReport } from "../cost/report.ts";
import { decisionEntries, exportCsv, exportRows, feedbackView, harnessScopeParam, spendUsdSince } from "../cost/views.ts";
import { anthropicErrorResponse, countAnthropicTokens, createMessagesWire } from "../wire/anthropic/messages.ts";
import { buildDailySummary, createKv, markSummaryShown, renderDailySummary, summaryDue, summaryHasNews, type SummaryOllama } from "../cost/summary.ts";
import type { Ledger, ModelTrust } from "../cost/types.ts";
import { createRouter } from "../router/index.ts";
import { createConversationStore } from "../router/state.ts";
import { UpstreamError } from "../upstream/types.ts";
import { apiKeySource, ollamaKeySource } from "../config/load.ts";
import { ollamaMeter } from "../upstream/ollama-usage.ts";
import { routerConfigPath } from "../cli/config-cmd.ts";
import { applyConfigPatch, touched } from "../config/apply.ts";
import type { DeepPartial } from "../config/load.ts";
import { PINNED_CONFIG_PATHS, watchConfig } from "../config/hot-reload.ts";
import type { RouterConfig } from "../config/types.ts";
import { createLogger } from "../util/log.ts";
import { openDb } from "../util/sqlite.ts";
import { WireErrorException, renderErrorEnvelope } from "../wire/openai/errors.ts";
import { renderModelList } from "../wire/openai/models.ts";
import { parseChatRequest } from "../wire/openai/request.ts";
import { createResponsesBufferedSink, createResponsesStreamingSink, parseResponsesRequest } from "../wire/openai/responses.ts";
import { createBufferedSink, createStreamingSink } from "../wire/openai/sink.ts";
import type { NormRequest, ResponseSink, WireError } from "../wire/types.ts";
import { runTurn } from "./turn.ts";

export interface StartedServer {
	// No websocket upgrade path, so the Server payload type is `undefined`.
	server: Server<undefined>;
	/**
	 * Applies a config change to the RUNNING router and reports the dotted paths
	 * that changed. Everything a turn reads through the config (tiers, filters,
	 * budgets, provider keys) takes effect on the next turn; the pieces built
	 * from config — the agentdox bridge, the catalogs — are re-pointed here. No
	 * socket closes and no turn in flight is cut.
	 *
	 * `server.*` and `ledger.path` are the exceptions: the listener and the
	 * database file are the process. Changing those still means a restart, and
	 * they are rejected rather than half-applied.
	 */
	reconfigure(patch: DeepPartial<RouterConfig>): Promise<ReconfigureResult>;
	stop(): Promise<void>;
}

export interface ReconfigureResult {
	/** Dotted config paths whose value changed. */
	changed: string[];
	/** Paths that were refused because they belong to construction (`server.*`, `ledger.path`). */
	rejected: string[];
	/** True when an upstream changed and a catalog re-fetch was started in the background. */
	catalogRefreshing: boolean;
}

/** Config a running router cannot change: the bound socket and the ledger file. */
const RESTART_ONLY_PATHS: readonly string[] = ["server", "ledger.path"];

export interface ModelSpendRow {
	slug: string;
	requests: number;
	spendUsd: number;
	/** Fraction of window spend attributable to this model, 0-1. */
	share: number;
}

export interface RouterStats {
	generatedAtMs: number;
	/** Window the entry aggregation covers; null ⇒ all retained entries. */
	windowDays: number | null;
	spendTodayUsd: number;
	spend7dUsd: number;
	spendAllTimeUsd: number;
	windowSpendUsd: number;
	requests: number;
	escalations: number;
	escalationRate: number;
	/** Mean |reported - predicted| / predicted over reported entries; null without samples. */
	meanPredictionError: number | null;
	perModel: ModelSpendRow[];
	trust: ModelTrust[];
}

/**
 * Aggregates the ledger for `/v1/router/stats` and `auto-model-router stats`.
 *
 * The ledger exposes no aggregate queries, so per-model breakdowns are
 * computed over a bounded tail of recent entries; the headline spend numbers
 * use `spendSince`, which is exact.
 */
export function computeStats(ledger: Ledger, opts?: { windowDays?: number; nowMs?: number }): RouterStats {
	const nowMs = opts?.nowMs ?? Date.now();
	const windowDays = opts?.windowDays;
	const cutoffMs = windowDays === undefined ? 0 : nowMs - windowDays * 86_400_000;

	// 100k turns is operational eternity for a single-operator router; the cap
	// only bounds memory on this read, never what the ledger retains.
	const entries = ledger.recentEntries(100_000).filter((e) => e.createdAtMs >= cutoffMs);

	const dayStart = new Date(nowMs);
	dayStart.setHours(0, 0, 0, 0);

	let escalations = 0;
	let errorSamples = 0;
	let errorSum = 0;
	let windowSpendUsd = 0;
	const perModel = new Map<string, { requests: number; spendUsd: number }>();

	for (const e of entries) {
		if (e.escalationSignal !== null) escalations += 1;
		if (e.reportedUsd !== null && e.predictedUsd > 0) {
			errorSamples += 1;
			errorSum += Math.abs(e.reportedUsd - e.predictedUsd) / e.predictedUsd;
		}
		// Reported cost is authoritative; predicted stands in while it is missing.
		const spend = e.reportedUsd ?? e.predictedUsd;
		windowSpendUsd += spend;
		const row = perModel.get(e.slug) ?? { requests: 0, spendUsd: 0 };
		row.requests += 1;
		row.spendUsd += spend;
		perModel.set(e.slug, row);
	}

	const rows: ModelSpendRow[] = [];
	for (const [slug, row] of perModel) {
		rows.push({
			slug,
			requests: row.requests,
			spendUsd: row.spendUsd,
			share: windowSpendUsd > 0 ? row.spendUsd / windowSpendUsd : 0,
		});
	}
	rows.sort((a, b) => b.spendUsd - a.spendUsd);

	return {
		generatedAtMs: nowMs,
		windowDays: windowDays ?? null,
		spendTodayUsd: ledger.spendSince(dayStart.getTime()),
		spend7dUsd: ledger.spendSince(nowMs - 7 * 86_400_000),
		spendAllTimeUsd: ledger.spendSince(0),
		windowSpendUsd,
		requests: entries.length,
		escalations,
		escalationRate: entries.length > 0 ? escalations / entries.length : 0,
		meanPredictionError: errorSamples > 0 ? errorSum / errorSamples : null,
		perModel: rows,
		trust: ledger.allTrust(),
	};
}

/** Days of included credits left at the last 7 days' burn (ledger, scaled by the calibration). */
export function ollamaRunway(
	meter: { usedUsd: number; creditsUsd: number } | null,
	ledgerUsd7d: number,
	factor: number,
): { dailyBurnUsd: number; creditsLeftUsd: number; days: number | null } | null {
	if (meter === null) return null;
	const dailyBurnUsd = (ledgerUsd7d / 7) * factor;
	const creditsLeftUsd = Math.max(0, meter.creditsUsd - meter.usedUsd);
	return { dailyBurnUsd, creditsLeftUsd, days: dailyBurnUsd > 0 ? creditsLeftUsd / dailyBurnUsd : null };
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function wireErrorResponse(err: WireError): Response {
	return new Response(JSON.stringify(renderErrorEnvelope(err)), {
		status: err.status,
		headers: { "content-type": "application/json" },
	});
}

/** Maps any failure thrown or rejected inside the turn pipeline to a wire error. */
function toWireError(err: unknown): WireError {
	if (err instanceof WireErrorException) return err.wireError;
	if (err instanceof UpstreamError) return err.toWireError();
	// Never forward the raw exception text to the client: it can contain
	// filesystem paths, internal URLs, or unexpected exception detail that aids
	// reconnaissance. The caller logs the real message server-side.
	return {
		status: 500,
		code: "internal_error",
		message: "internal error",
	};
}

/** True when the server is bound to a loopback address (the default). */
function isLoopbackHost(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "::";
}

/**
 * True when a request's Host header names a loopback address. Blunts DNS
 * rebinding: a malicious page that resolves a host to 127.0.0.1 sends a Host
 * header naming its own domain, which this rejects. Only enforced when the
 * server itself is bound to loopback; an operator who explicitly widens the
 * bind to 0.0.0.0 opts out of the check.
 */
function isLoopbackHostHeader(hostHeader: string | null): boolean {
	if (hostHeader === null) return false;
	const host = hostHeader.split(":")[0] ?? "";
	return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

/** `?days=` bounded to [1, 365], `dflt` when absent or unparsable. */
function clampDays(raw: string | null, dflt: number): number {
	const n = raw === null ? dflt : Number.parseInt(raw, 10);
	return Number.isInteger(n) ? Math.min(Math.max(n, 1), 365) : dflt;
}

export function startServer(cfg: RouterConfig): StartedServer {
	const log = createLogger(cfg.logLevel);

	if (cfg.ledger.path !== ":memory:") mkdirSync(dirname(cfg.ledger.path), { recursive: true });
	const db = openDb(cfg.ledger.path);
	const ledger = createLedger(db, cfg);
	const providers = createProviders(cfg, db, log);
	const { upstream, catalog, ollama, ollamaServing, ollamaUsage, ollamaCostScale } = providers;
	const conversations = createConversationStore(db);
	const router = createRouter({ config: cfg, catalog, ledger, conversations, upstream });
	const context = createBridgeFromConfig(cfg, db);
	const overrides = createSessionOverrides();
	const feedback = createFeedbackStore(db);
	const kv = createKv(db);
	const digester = createDigester({ cfg, catalog, ledger, upstream, log });
	const turnDeps = { config: cfg, router, upstream, ledger, conversations, catalog, context, overrides, ollamaCostScale, digester };

	// Hot reload: ranking knobs (tiers, filters, escalation, budgets, …) take
	// effect on the next turn without a restart, because every consumer reads
	// the shared config object at call time. Construction-captured settings
	// (server socket, upstream clients, agentdox bridge, ledger file) are
	// pinned by path (PINNED_CONFIG_PATHS); editing those still requires a
	// restart. The blocks are deep-copied so a reload cannot mutate the pin.
	const pinned = structuredClone(cfg);
	const configWatcher = watchConfig(
		routerConfigPath(),
		cfg,
		pinned,
		PINNED_CONFIG_PATHS,
		{
			onReload: ({ changed }) => {
				log.info("config reloaded", { changed: changed.join(", ") });
				// The file is a config change like any other: same live application.
				void applyLive(changed).catch((err: unknown) => log.warn("applying the reloaded config failed", { error: err instanceof Error ? err.message : String(err) }));
			},
			onError: (message) => {
				log.warn("config reload rejected; keeping the running config", { error: message });
			},
		},
	);

	// Compile the redaction rules before the listener exists: a rule that does
	// not load is a hole in the guard, and an operator who configured redaction
	// must not get a router that started and forwarded anyway. Programmatic
	// overrides (an embedder's) never pass through the config schema, so this is
	// the only place their rules are checked.
	const redactionRules = redactionRulesFor(cfg.redaction);
	if (redactionRules.length > 0) {
		// Names only. The patterns describe the secrets and the matches are the
		// secrets; neither belongs in a log line.
		log.info("redaction enabled", { rules: redactionRules.map((r) => r.name).join(","), scanTools: cfg.redaction.scanTools });
	}

	if (context.enabled) {
		log.info("agentdox context bridge enabled", {
			url: cfg.context.baseUrl,
			defaultScope: cfg.context.defaultScope === "" ? "(per-request header only)" : cfg.context.defaultScope,
			recordTurns: cfg.context.recordTurns,
		});
	}

	if (cfg.openrouter.apiKey === "") {
		if (cfg.ollama.enabled) log.warn("no OpenRouter key: routing over Ollama Cloud models only (OpenRouter's catalog is read for metadata, never served)");
		else log.warn("OPENROUTER_API_KEY is not set and Ollama is off; /v1/chat/completions will fail at dispatch time");
	}
	for (const u of cfg.upstreams) {
		if (!u.enabled) continue;
		log.info(`named upstream enabled: ${u.id}`, { kind: u.kind, baseUrl: u.baseUrl, models: u.models.length, apiKeyConfigured: u.apiKey !== "" });
	}
	if (cfg.ollama.enabled) {
		log.info("ollama cloud upstream enabled", {
			baseUrl: cfg.ollama.baseUrl,
			// Provenance only; never the key itself.
			apiKeySource: ollamaKeySource(cfg).source,
			costBias: cfg.ollama.costBias,
		});
	}

	// Warm the catalog without blocking listen; the first request may race it,
	// which CatalogSource.get() already serializes.
	catalog.get().catch((err: unknown) => {
		log.warn("initial catalog fetch failed", { error: err instanceof Error ? err.message : String(err) });
	});

	// Ledger retention. The runner owns the once-an-hour floor, so the minute
	// timer below, the boot run and `POST /v1/router/prune` cannot between them
	// run a whole-ledger delete more often than that. It reads the window live,
	// so a hot reload that lowers it applies on the next tick.
	const retention = createRetentionRunner({ ledger, retentionDays: () => cfg.ledger.retentionDays });
	const retain = (): void => {
		try {
			const result = retention.maybeRun();
			if (result !== null && result.deleted > 0) {
				log.info("pruned ledger rows past retention", { deleted: result.deleted, retentionDays: cfg.ledger.retentionDays });
			}
		} catch (err) {
			log.warn("ledger retention prune failed", { error: err instanceof Error ? err.message : String(err) });
		}
	};

	// One housekeeping timer for all three tables. `unref`'d so it never holds
	// the process open.
	const pruneTimer = setInterval(() => {
		try {
			const dropped = conversations.prune(cfg.ledger.conversationTtlMs);
			if (dropped > 0) log.debug("pruned stale conversations", { dropped });
		} catch (err) {
			log.warn("conversation prune failed", { error: err instanceof Error ? err.message : String(err) });
		}
		try {
			// Past the staleness TTL every pin refreshes anyway, so an unreferenced
			// block of that age has no future reader. Nothing else reclaims these:
			// blocks are content-addressed and shared, so they accumulated for the
			// life of the install (measured: 220 rows / 2.7 MB, 68 unreferenced).
			const dropped = context.pruneBlocks(cfg.context.maxStalenessMs);
			if (dropped > 0) log.debug("pruned unreferenced context blocks", { dropped });
		} catch (err) {
			log.warn("context block prune failed", { error: err instanceof Error ? err.message : String(err) });
		}
		retain();
	}, 60_000);
	pruneTimer.unref();

	// Once shortly after boot, so a lowered window takes effect without waiting
	// out an hour; the runner's own floor governs everything after that.
	setTimeout(retain, 5_000).unref();

	// Periodically refetch the (key-scoped) catalog in the background so
	// guardrail/preference changes are picked up without needing traffic and a
	// TTL expiry. catalogRefreshMs === 0 disables this.
	let catalogRefreshTimer: ReturnType<typeof setInterval> | undefined;
	if (cfg.openrouter.catalogRefreshMs > 0) {
		catalogRefreshTimer = setInterval(() => {
			catalog.refresh().catch((err: unknown) => {
				log.warn("periodic catalog refresh failed; keeping last snapshot", {
					error: err instanceof Error ? err.message : String(err),
				});
			});
		}, cfg.openrouter.catalogRefreshMs);
		catalogRefreshTimer.unref();
	}

	// Cap concurrent in-flight turns so a burst of requests cannot hold many
	// upstream streams at once (each can run up to idleTimeout). Excess requests
	// are rejected with 429 rather than queued, so a local flood cannot pile up
	// unbounded upstream spend or memory.
	//
	// This budget is per ROUTER PROCESS, and since v0.2.23 one process serves
	// every omp session on the machine (the port is deterministic, so peers
	// reuse it). It therefore has to cover N interactive sessions plus their
	// subagents, not one session — hence configurable, and defaulted higher
	// than the 8 that used to be private to a single session.
	const MAX_CONCURRENT_TURNS = cfg.server.maxConcurrentTurns;
	let inFlightTurns = 0;
	const acquireTurn = (): boolean => {
		if (inFlightTurns >= MAX_CONCURRENT_TURNS) return false;
		inFlightTurns++;
		return true;
	};
	const releaseTurn = (): void => {
		inFlightTurns--;
	};

	/** A wire: how a request body becomes a NormRequest and how the turn is rendered back. */
	interface Wire {
		parse(body: unknown, headers: Headers): NormRequest;
		streaming(model: string): { sink: ResponseSink; response: Response };
		buffered(model: string): { sink: ResponseSink; response: Promise<Response> };
		/** How a failure before the sink exists is rendered; the OpenAI envelope when absent. */
		error?: (err: WireError) => Response;
	}
	const CHAT_WIRE: Wire = { parse: parseChatRequest, streaming: createStreamingSink, buffered: createBufferedSink };
	const RESPONSES_WIRE: Wire = { parse: parseResponsesRequest, streaming: createResponsesStreamingSink, buffered: createResponsesBufferedSink };
	const MESSAGES_WIRE: Wire = createMessagesWire(cfg.anthropic.models);

	const handleTurn = async (req: Request, wire: Wire): Promise<Response> => {
		let normReq: NormRequest;
		try {
			normReq = wire.parse(await req.json(), req.headers);
		} catch (err) {
			// The slot was acquired before parsing; a rejected body never reaches
			// runTurn's `finally`, so it must be released here or every malformed
			// request permanently consumes one of maxConcurrentTurns.
			releaseTurn();
			const render = wire.error ?? wireErrorResponse;
			if (err instanceof WireErrorException) return render(err.wireError);
			return render({
				status: 400,
				code: "invalid_json",
				message: err instanceof Error ? err.message : "request body is not valid JSON",
			});
		}

		const { sink, response } = normReq.stream ? wire.streaming(normReq.requestedModel) : wire.buffered(normReq.requestedModel);

		// The client signal aborts the upstream dispatch on disconnect. runTurn is
		// expected to render its own failures into the sink; this catch is the last
		// line of defence so a rejected turn can never wedge the response.
		runTurn(normReq, sink, turnDeps, req.signal)
			.catch((err: unknown) => {
				log.error("turn failed", { error: err instanceof Error ? err.message : String(err) });
				// sink.error() is SYNCHRONOUS: it runs before Promise.resolve wraps
				// anything, so a throw out of it escapes this .catch() handler and
				// becomes an unhandled rejection that kills the process. Wrap it.
				try {
					Promise.resolve(sink.error(toWireError(err))).catch(() => {});
				} catch {
					// Stream already gone; the response cannot carry the error.
				}
			})
			.finally(() => {
				// Release the concurrency slot when the turn settles, not when the
				// streaming response object is handed back.
				releaseTurn();
			});

		return response;
	};

	const server: Server<undefined> = Bun.serve({
		hostname: cfg.server.host,
		port: cfg.server.port,
		// Bun's default idleTimeout is 10s, which is far shorter than a real
		// generation can sit silent: the escalation guard holds the first tokens
		// for up to maxHoldMs while a reasoning model is still producing its
		// first token, and frontier models can think for tens of seconds between
		// chunks. A 10s gap would close the socket mid-stream and surface to omp
		// as "socket connection was closed unexpectedly". idleTimeout is in
		// SECONDS (max 255), so convert from the ms upstream timeout and cap.
		idleTimeout: Math.min(Math.ceil(cfg.openrouter.timeoutMs / 1000), 255),
		async fetch(req: Request): Promise<Response> {
			// Reject requests whose Host header does not name a loopback address
			// when the server is bound to loopback. This blunts DNS rebinding: a
			// malicious page resolving a host to 127.0.0.1 sends its own domain as
			// the Host header, which this rejects. An operator who explicitly
			// widens the bind to 0.0.0.0 opts out of the check.
			if (isLoopbackHost(cfg.server.host) && !isLoopbackHostHeader(req.headers.get("host"))) {
				return wireErrorResponse({ status: 403, code: "forbidden", message: "invalid host" });
			}

			const url = new URL(req.url);
			// The Messages wire renders its own error envelope; everything else speaks OpenAI's.
			const errorResponse = url.pathname.startsWith("/v1/messages") ? anthropicErrorResponse : wireErrorResponse;
			if (cfg.server.apiKey !== undefined && cfg.server.apiKey !== "") {
				// Anthropic clients (Claude Code) present the key as x-api-key rather than a bearer.
				const presented = req.headers.get("authorization") === `Bearer ${cfg.server.apiKey}` || req.headers.get("x-api-key") === cfg.server.apiKey;
				if (!presented) return errorResponse({ status: 401, code: "unauthorized", message: "invalid or missing API key" });
			}

			try {
				if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
					if (!acquireTurn()) {
						return wireErrorResponse({ status: 429, code: "too_many_requests", message: "too many concurrent turns" });
					}
					return await handleTurn(req, CHAT_WIRE);
				}
				if (req.method === "POST" && url.pathname === "/v1/responses") {
					// The Responses API wire (Codex CLI). Same turn, different rendering.
					if (!acquireTurn()) {
						return wireErrorResponse({ status: 429, code: "too_many_requests", message: "too many concurrent turns" });
					}
					return await handleTurn(req, RESPONSES_WIRE);
				}
				if (req.method === "POST" && url.pathname === "/v1/messages") {
					if (!acquireTurn()) {
						return anthropicErrorResponse({ status: 429, code: "too_many_requests", message: "too many concurrent turns" });
					}
					return await handleTurn(req, MESSAGES_WIRE);
				}
				if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
					try {
						return json({ input_tokens: countAnthropicTokens(await req.json(), cfg.anthropic.models, ledger) });
					} catch (err) {
						if (err instanceof WireErrorException) return anthropicErrorResponse(err.wireError);
						return anthropicErrorResponse({ status: 400, code: "invalid_json", message: err instanceof Error ? err.message : "request body is not valid JSON" });
					}
				}
				if (req.method === "GET" && url.pathname === "/v1/models") {
					return json(renderModelList(cfg, ledger.blendedRate(cfg.ledger.blendWindowDays)));
				}
				if (req.method === "GET" && url.pathname === "/v1/router/stats") {
					return json(computeStats(ledger));
				}
				if (req.method === "GET" && url.pathname === "/v1/router/catalog") {
					// The catalog as data, judged under `?policy=` (the X-Omp-Policy
					// JSON) when one is given: a front door's governance view. Never
					// blocks on a fetch; before the first one it is empty.
					const rawPolicy = url.searchParams.get("policy");
					let verdict: { filters: RouterConfig["filters"]; pin?: string } | undefined;
					if (rawPolicy !== null) {
						// The header parser forgives a malformed value (a turn must not
						// fail on it); a view asked about one must say so instead.
						let parsed: unknown;
						try {
							parsed = JSON.parse(rawPolicy);
						} catch {
							parsed = undefined;
						}
						if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
							return wireErrorResponse({ status: 400, code: "invalid_request_error", message: "policy must be a JSON object (the X-Omp-Policy shape)" });
						}
						const policed = applyRequestPolicy(resolveProfile(cfg, "auto"), cfg, parsePolicyHeader(rawPolicy), undefined);
						verdict = { filters: policed.cfg.filters, ...(policed.forceSlug === undefined ? {} : { pin: policed.forceSlug }) };
					}
					const snap = catalog.peekAll?.() ?? catalog.peek();
					// A disabled named upstream's models are not built for routing; list them too, so "why not" has an answer.
					const disabled = snap === null ? [] : cfg.upstreams.filter((u) => !u.enabled).flatMap((u) => buildUpstreamModels(u, snap.models));
					const unserved = (provider: string): string | null => {
						if (provider === "openrouter") return cfg.openrouter.apiKey === "" ? "upstream openrouter has no API key" : null;
						if (provider === "ollama") return !cfg.ollama.enabled ? "upstream ollama is disabled" : ollama.available() ? null : "upstream ollama is in cooldown";
						const entry = cfg.upstreams.find((u) => u.id === provider);
						if (entry === undefined) return `upstream ${provider} is not configured`;
						if (!entry.enabled) return `upstream ${provider} is disabled`;
						return providers.named(provider)?.available() ?? true ? null : `upstream ${provider} is in cooldown`;
					};
					return json(catalogView({ models: snap === null ? [] : [...snap.models, ...disabled], fetchedAtMs: snap?.fetchedAtMs ?? 0, ...(verdict === undefined ? {} : { verdict }), unserved }));
				}
				if (req.method === "GET" && url.pathname === "/v1/router/spend") {
					// Spend since an instant over a harness set: what a front door's
					// budget check needs when it cannot read the ledger file.
					const since = Number.parseInt(url.searchParams.get("sinceMs") ?? "", 10);
					if (!Number.isFinite(since)) return wireErrorResponse({ status: 400, code: "invalid_request_error", message: "sinceMs required" });
					// `scope` narrows to one agentdox context scope: a project's own spend.
					const contextScope = url.searchParams.get("scope") ?? "";
					return json({ sinceMs: since, usd: spendUsdSince(db, since, harnessScopeParam(url.searchParams.get("harness")), contextScope), ...(contextScope === "" ? {} : { scope: contextScope }) });
				}
				if (req.method === "GET" && url.pathname === "/v1/router/feedback") {
					const days = clampDays(url.searchParams.get("days"), 30);
					return json({ days, ...feedbackView(db, Date.now() - days * 86_400_000, harnessScopeParam(url.searchParams.get("harness"))) });
				}
				if (req.method === "GET" && url.pathname === "/v1/router/export") {
					const days = clampDays(url.searchParams.get("days"), 30);
					const rows = exportRows(db, Date.now() - days * 86_400_000, harnessScopeParam(url.searchParams.get("harness")));
					if (url.searchParams.get("format") === "json") return json({ days, rows });
					return new Response(exportCsv(rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="auto-model-router-export-${new Date().toISOString().slice(0, 10)}.csv"` } });
				}
				if (req.method === "GET" && url.pathname === "/v1/router/report") {
					// Usage analytics for `/router report` and the CLI: bounded window,
					// optional harness scope (the X-Omp-Harness header value).
					const windowDays = clampDays(url.searchParams.get("days"), 7);
					const harnessId = url.searchParams.get("harness") ?? "";
					const report = buildUsageReport(db, { windowDays, harnessId, baselines: baselinePrices(cfg.report.baselines, (s) => catalog.find(s)) });
					// ?format=text: the rendered report for harnesses without a renderer of their own (the Hermes plugin).
					if (url.searchParams.get("format") === "text") return new Response(renderUsageReport(report), { headers: { "content-type": "text/plain; charset=utf-8" } });
					return json(report);
				}
				if (req.method === "GET" && url.pathname === "/v1/router/advise/policy") {
					const h = cfg.harnessSwitch;
					return json({ enabled: h.enabled, models: h.models, minConfidence: h.minConfidence });
				}
				if (req.method === "POST" && url.pathname === "/v1/router/advise") {
					// Harness-side switch: classify a prompt before the harness builds
					// the request. Heuristic only; nothing is dispatched or recorded.
					const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
					if (body === null || typeof body.text !== "string") {
						return wireErrorResponse({ status: 400, code: "invalid_request_error", message: "text required" });
					}
					return json(
						advise(cfg, ledger, {
							ompSessionId: typeof body.ompSessionId === "string" ? body.ompSessionId : "",
							harnessId: typeof body.harnessId === "string" ? body.harnessId : "",
							text: body.text.slice(0, 16_000),
						}),
					);
				}
				if (req.method === "GET" && url.pathname === "/v1/router/summary") {
					// The last 24 hours in a few lines. `auto=1` is the session-start
					// caller: it gets `due: false` unless report.dailySummary is on, no
					// summary was posted for this harness in the last 20h, and there is
					// something to say; posting is then marked so other windows skip it.
					const harnessId = url.searchParams.get("harness") ?? "";
					const auto = url.searchParams.get("auto") === "1";
					if (auto && !cfg.report.dailySummary) return json({ due: false, reason: "report.dailySummary is off", summary: null });
					if (auto && !summaryDue(kv, harnessId)) return json({ due: false, reason: "posted in the last 20h", summary: null });
					const meter = ollamaMeter(ollamaUsage.peek(), cfg.ollama.planCreditsUsd);
					const runway = ollamaRunway(meter, ledger.providerSpendSince?.("ollama/", Date.now() - 7 * 86_400_000) ?? 0, ollamaUsage.calibration()?.factor ?? 1);
					const ollamaSummary: SummaryOllama | null =
						!cfg.ollama.enabled || meter === null ? null : { plan: meter.plan ?? null, usedUsd: meter.usedUsd, creditsUsd: meter.creditsUsd, runwayDays: runway?.days ?? null };
					const summary = buildDailySummary(db, {
						harnessId,
						baselines: baselinePrices(cfg.report.baselines, (s) => catalog.find(s)),
						spikes: ledger.softFailureSpikes?.() ?? [],
						ollama: ollamaSummary,
					});
					if (auto && !summaryHasNews(summary)) return json({ due: false, reason: "nothing to report", summary: null });
					if (auto) markSummaryShown(kv, harnessId);
					if (url.searchParams.get("format") === "text") return new Response(renderDailySummary(summary), { headers: { "content-type": "text/plain; charset=utf-8" } });
					return json({ due: true, summary });
				}
				if (req.method === "GET" && url.pathname === "/v1/router/decisions") {
					// The decision trail, newest first. ?session=<omp session id> narrows to one
					// session (/router why); ?harness=a,b to a harness set (a team's user or group),
					// ?since=<ms> or ?days=N to a window, ?slug= and ?tier= to a model or a tier.
					const rawLimit = url.searchParams.get("limit");
					const parsed = rawLimit === null ? 50 : Number.parseInt(rawLimit, 10);
					const limit = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 1_000) : 50;
					const sinceRaw = Number.parseInt(url.searchParams.get("since") ?? "", 10);
					const daysRaw = url.searchParams.get("days");
					const sinceMs = Number.isFinite(sinceRaw) ? sinceRaw : daysRaw === null ? 0 : Date.now() - clampDays(daysRaw, 30) * 86_400_000;
					const entries = decisionEntries(db, {
						sinceMs,
						harness: harnessScopeParam(url.searchParams.get("harness")),
						limit,
						slug: url.searchParams.get("slug") ?? "",
						tier: url.searchParams.get("tier") ?? "",
						ompSessionId: url.searchParams.get("session") ?? "",
					});
					return json({ entries });
				}
				if (url.pathname === "/v1/router/override") {
					// Per-session pin / tier overrides from omp. GET shows, POST sets or clears.
					if (req.method === "GET") {
						const session = url.searchParams.get("session") ?? "";
						return json(session === "" ? { overrides: overrides.list() } : { override: overrides.get(session) });
					}
					if (req.method === "POST") {
						const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
						const session = typeof body?.ompSessionId === "string" ? body.ompSessionId : "";
						if (session === "") return wireErrorResponse({ status: 400, code: "invalid_request_error", message: "ompSessionId required" });
						if (body?.clear === true) {
							overrides.clear(session);
							return json({ override: null });
						}
						const tier = body?.tier;
						if (tier !== undefined && tier !== null && !(TIER_ORDER as readonly string[]).includes(String(tier))) {
							return wireErrorResponse({ status: 400, code: "invalid_request_error", message: `unknown tier ${String(tier)}` });
						}
						const slug = body?.slug;
						if (typeof slug === "string" && slug !== "" && catalog.find(slug) === undefined) {
							return wireErrorResponse({ status: 404, code: "not_found", message: `no model ${slug} in the catalog` });
						}
						const turns = typeof body?.turns === "number" ? body.turns : undefined;
						const set = overrides.set(session, {
							...(tier === undefined ? {} : { tier: tier === null ? null : (String(tier) as Tier) }),
							...(slug === undefined ? {} : { slug: typeof slug === "string" && slug !== "" ? slug : null }),
							...(turns === undefined ? {} : { turns }),
						});
						return json({ override: set });
					}
				}
				if (req.method === "GET" && url.pathname === "/v1/router/digest/policy") {
					const d = cfg.digest;
					return json({ enabled: d.enabled, minBytes: d.minBytes, maxBytes: d.maxBytes, tools: d.tools, toolAliases: d.toolAliases, fromTier: d.fromTier });
				}
				if (req.method === "POST" && url.pathname === "/v1/router/digest") {
					const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
					if (body === null || typeof body.content !== "string" || typeof body.toolName !== "string") {
						return wireErrorResponse({ status: 400, code: "invalid_request_error", message: "toolName and content required" });
					}
					return json(
						await digester.digest({
							ompSessionId: typeof body.ompSessionId === "string" ? body.ompSessionId : "",
							harnessId: typeof body.harnessId === "string" ? body.harnessId : "",
							toolName: body.toolName,
							input: typeof body.input === "object" && body.input !== null ? (body.input as Record<string, unknown>) : {},
							content: body.content,
							query: typeof body.query === "string" ? body.query : "",
						}),
					);
				}
				if (req.method === "POST" && url.pathname === "/v1/router/prune") {
					// A front door of the team edition holds a READ-ONLY handle on the
					// ledger file by design, so this route is the only way it can act
					// on its own retention policy — and the once-an-hour floor is the
					// runner's, not the caller's, so calling it in a loop is harmless.
					const result = retention.runNow();
					if (result.deleted > 0) log.info("pruned ledger rows past retention", { deleted: result.deleted, retentionDays: cfg.ledger.retentionDays });
					return json({ ...result, retentionDays: cfg.ledger.retentionDays });
				}
				if (req.method === "POST" && url.pathname === "/v1/router/benchmark") {
					// Score one model with our OWN eval suite, for the models no feed covers: a
					// third of a live catalog carries no published score on any axis, and a model
					// with no score cannot clear any floor, so routing may never pick it.
					//
					// A raw mean is not comparable with a published index, so the run also evals
					// ANCHOR models that do have published scores and fits raw → published per
					// axis. Anchors are chosen from the catalog across its score range unless the
					// caller names them, so one slug is all this needs.
					//
					// The result is written to `local_scores`, which only reaches routing when
					// `benchmarks.useLocalScores` is on — measuring a model and trusting it are
					// deliberately two decisions.
					const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
					const slug = typeof body?.slug === "string" ? body.slug.trim() : "";
					if (slug === "") return wireErrorResponse({ status: 400, code: "invalid_request_error", message: "slug required" });
					const snap = catalog.peekAll?.() ?? catalog.peek();
					const models = snap?.models ?? [];
					if (models.find((m) => m.slug === slug) === undefined) return wireErrorResponse({ status: 404, code: "invalid_request_error", message: `${slug} is not in the catalog` });
					const named = Array.isArray(body?.anchors) ? (body.anchors as unknown[]).filter((a): a is string => typeof a === "string") : [];
					const anchors = named.length > 0 ? [...new Set(named)] : pickAnchors(models, slug);
					if (anchors.length < MIN_ANCHORS) return wireErrorResponse({ status: 422, code: "invalid_request_error", message: `need at least ${MIN_ANCHORS} scored, tool-capable anchor models to calibrate against` });
					// A rate-limited dispatch is not a failed task. Ollama Cloud answers "too many
					// concurrent requests" well below four models in flight, and the runner folds a
					// throwing completion in as grade 0 — which would score a provider's throttle as
					// the model being wrong. Retry with backoff, and keep the default concurrency
					// low enough that the throttle is rarely reached in the first place.
					const complete: Completer = async (target, messages) => {
						let last: unknown = null;
						for (let attempt = 0; attempt < 4; attempt++) {
							if (attempt > 0) {
								const { promise, resolve } = Promise.withResolvers<void>();
								setTimeout(resolve, attempt * 4000);
								await promise;
							}
							try {
								const out = await upstream.complete({ model: target, stream: false, temperature: 0, max_tokens: 1024, messages }, AbortSignal.timeout(120_000));
								return out.text;
							} catch (err) {
								last = err;
							}
						}
						throw last instanceof Error ? last : new Error(String(last));
					};
					const judgeSlug = typeof body?.judge === "string" && body.judge !== "" ? body.judge : "";
					const asked = typeof body?.concurrency === "number" ? Math.floor(body.concurrency) : 2;
					const results = await runEval({
						slugs: [slug, ...anchors],
						complete,
						concurrency: Math.min(Math.max(1, asked), 8),
						...(judgeSlug === "" ? {} : { judge: makeJudge(complete, judgeSlug) }),
					});
					const target = results[0]!;
					const anchorResults = results.slice(1);
					const published = (s: string, axis: QualityAxis): number | undefined => models.find((m) => m.slug === s)?.quality[axis];
					const cal = fitCalibration(anchorResults, published);
					const authorOf = (s: string): string => models.find((m) => m.slug === s)?.author ?? "";
					const fresh = toLocalFeedScores([target], cal, authorOf);
					if (fresh.length === 0) {
						return json({ slug, anchors, calibrated: null, raw: target.axes, errors: target.errors, applied: false, reason: "no axis produced a usable fit; try more or better-spread anchors" });
					}
					// Merge, never replace: other models' measurements are not this run's to discard.
					const kept = loadLocalScores(db).filter((s) => s.key !== fresh[0]!.key);
					saveLocalScores(db, [...kept, ...fresh]);
					log.info("benchmarked a model with the local eval suite", { slug, anchors: anchors.length, errors: target.errors, useLocalScores: cfg.benchmarks.useLocalScores });
					return json({ slug, anchors, raw: target.axes, calibrated: fresh[0], errors: target.errors, applied: cfg.benchmarks.useLocalScores });
				}
				if (req.method === "POST" && url.pathname === "/v1/router/feedback") {
					// A user verdict on the newest routed turn of an omp session.
					const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
					const session = typeof body?.ompSessionId === "string" ? body.ompSessionId : "";
					const verdict = body?.verdict;
					if (session === "" || (verdict !== "good" && verdict !== "bad")) {
						return wireErrorResponse({ status: 400, code: "invalid_request_error", message: "ompSessionId and verdict (good|bad) required" });
					}
					const target =
						typeof body?.ledgerId === "string"
							? (ledger.recentEntries(1_000).find((e) => e.id === body.ledgerId) ?? null)
							: (ledger.latestForSession?.(session) ?? null);
					if (target === null) return wireErrorResponse({ status: 404, code: "not_found", message: "no routed turn for that session yet" });
					const id = feedback.record({
						ledgerId: target.id,
						ompSessionId: session,
						slug: target.servedSlug ?? target.slug,
						tier: target.tier,
						verdict: verdict as Verdict,
						note: typeof body?.note === "string" ? body.note : "",
					});
					return json({ id, ledgerId: target.id, slug: target.servedSlug ?? target.slug, tier: target.tier, verdict });
				}
				if (req.method === "GET" && url.pathname === "/health") {
					const snap = catalog.peek();
					return json({
						status: "ok",
						apiKeyConfigured: cfg.openrouter.apiKey !== "",
						// Which upstreams turns can actually be served from: OpenRouter needs
						// its key; Ollama needs to be on and out of cooldown.
						serving: [...(cfg.openrouter.apiKey !== "" ? ["openrouter"] : []), ...(ollamaServing() ? ["ollama"] : []), ...providers.namedServing()],
						// Named direct upstreams: never the key. `available` is each one's breaker.
						upstreams: cfg.upstreams.map((u) => {
							const client = providers.named(u.id);
							return { id: u.id, kind: u.kind, enabled: u.enabled, baseUrl: u.baseUrl, apiKeyConfigured: u.apiKey !== "", models: u.models.length, available: client?.available() ?? true, cooldownUntilMs: client?.cooldownUntilMs() ?? null, lastTrip: client?.lastTrip() ?? null };
						}),
						// Provenance only; never the key itself.
						apiKeySource: apiKeySource(cfg).source,
						// Provenance only; never the agentdox token itself.
						agentdox: context.enabled
							? { url: cfg.context.baseUrl, defaultScope: cfg.context.defaultScope, recordTurns: cfg.context.recordTurns }
							: null,
						// Never the key. `available` is the circuit breaker: false while a
						// 402/429 cooldown routes every turn around Ollama.
						ollama:
							!cfg.ollama.enabled
								? null
								: {
										baseUrl: cfg.ollama.baseUrl,
										apiKeySource: ollamaKeySource(cfg).source,
										models: catalog.ollamaModels?.().length ?? 0,
										available: ollama.available(),
										cooldownUntilMs: ollama.cooldownUntilMs(),
										lastTrip: ollama.lastTrip(),
										// Plan usage as ollama.com reports it (share of included monthly
										// credits) and the cost multiplier currently in force.
										usage: ollamaUsage.peek(),
										// The dashboard's dollar figure: plan share × included credits, when known.
										meter: ollamaMeter(ollamaUsage.peek(), cfg.ollama.planCreditsUsd),
										// Ledger vs meter, and how long the credits last at the recent burn.
										calibration: ollamaUsage.calibration(),
										runway: ollamaRunway(ollamaMeter(ollamaUsage.peek(), cfg.ollama.planCreditsUsd), ledger.providerSpendSince?.("ollama/", Date.now() - 7 * 86_400_000) ?? 0, ollamaUsage.calibration()?.factor ?? 1),
										costBias: { configured: cfg.ollama.costBias, effective: catalog.ollamaBias?.() ?? cfg.ollama.costBias, biasUntilUsage: cfg.ollama.biasUntilUsage },
									},
						// Models failing well above their own baseline in the last hour.
						// Visibility only: nothing routes around a spike.
						softFailures: { recentMs: 3_600_000, baselineDays: 7, spikes: ledger.softFailureSpikes?.() ?? [] },
						catalog: snap === null
							? null
							: {
									models: snap.models.length,
									fetchedAtMs: snap.fetchedAtMs,
									ageMs: Date.now() - snap.fetchedAtMs,
									keyScoped: snap.keyScoped === true,
									// Non-null after a refresh kept < half the previous models;
									// the one signal that the key narrowed (or upstream blipped)
									// and routing is now on whatever survived.
									shrink: catalog.lastShrink?.() ?? null,
								},
					});
				}
				return wireErrorResponse({ status: 404, code: "not_found", message: `no route for ${req.method} ${url.pathname}` });
			} catch (err) {
				log.error("request failed", { path: url.pathname, error: err instanceof Error ? err.message : String(err) });
				return wireErrorResponse(toWireError(err));
			}
		},
	});

	/**
	 * The one place that turns a config change into a live router. The watcher
	 * (file edits) and `reconfigure` (an embedder, e.g. the team edition) both
	 * come through here, so the two can never drift apart.
	 */
	async function applyLive(changed: readonly string[]): Promise<boolean> {
		if (changed.length === 0) return false;
		if (touched(changed, "context")) {
			await context.reconfigure();
			log.info("agentdox bridge reconfigured", {
				enabled: context.enabled,
				url: cfg.context.baseUrl === "" ? "(none)" : cfg.context.baseUrl,
				defaultScope: cfg.context.defaultScope === "" ? "(per-request header only)" : cfg.context.defaultScope,
			});
		}
		const benchmarksChanged = touched(changed, "benchmarks");
		if (!touched(changed, "openrouter", "ollama") && !benchmarksChanged) return false;
		if (benchmarksChanged) {
			// The feed cache keeps its own ~daily TTL, so a refresh alone would rebuild
			// the catalog from yesterday's feeds and the new Artificial Analysis key
			// would do nothing until it expired. Age the row out so the refresh below
			// re-fetches; the payload stays put, so a fetch that fails leaves the
			// scores already serving in place. Only a benchmarks change does this —
			// every other reconfigure keeps the cadence the cache is there for.
			invalidateFeedCache(db);
		}
		// A key change makes the catalog key-scoped (or not), and enabling Ollama adds
		// its models: the snapshot is rebuilt before the next turn ranks. Started, not
		// awaited — the caller is a settings save, not a network client, and the
		// previous snapshot serves turns until the new one lands.
		void catalog
			.refresh()
			.then((snap) => log.info("catalog refreshed after a live config change", { models: snap.models.length, ollama: cfg.ollama.enabled, benchmarks: benchmarksChanged }))
			.catch((err: unknown) => log.warn("catalog refresh after a live config change failed; the previous snapshot stands", { error: err instanceof Error ? err.message : String(err) }));
		return true;
	}

	return {
		server,
		async reconfigure(patch) {
			const rejected: string[] = [];
			const rec = patch as Record<string, unknown>;
			for (const block of RESTART_ONLY_PATHS) {
				const [head, key] = block.split(".") as [string, string | undefined];
				const value = rec[head];
				if (value === undefined) continue;
				if (key === undefined) rejected.push(head);
				else if ((value as Record<string, unknown>)[key] !== undefined) rejected.push(block);
			}
			const safe = structuredClone(rec);
			for (const block of rejected) {
				const [head, key] = block.split(".") as [string, string | undefined];
				if (key === undefined) delete safe[head];
				else delete (safe[head] as Record<string, unknown>)[key];
			}
			const changed = applyConfigPatch(cfg, safe as DeepPartial<RouterConfig>);
			const catalogRefreshing = await applyLive(changed);
			if (changed.length > 0) log.info("config reconfigured", { changed: changed.join(", ") });
			if (rejected.length > 0) log.warn("config change needs a restart; not applied", { paths: rejected.join(", ") });
			return { changed, rejected, catalogRefreshing };
		},
		stop: async () => {
			configWatcher.close();
			clearInterval(pruneTimer);
			await server.stop(true);
			// Drain queued agentdox write-backs before the DB closes under them.
			context.close();
			await context.flush();
			db.close();
		},
	};
}
