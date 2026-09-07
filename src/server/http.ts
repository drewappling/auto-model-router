import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "bun";
import { createProviders } from "./providers.ts";
import { createBridgeFromConfig } from "../context/index.ts";
import { createFeedbackStore, type Verdict } from "../cost/feedback.ts";
import { createLedger } from "../cost/ledger.ts";
import { createSessionOverrides } from "./overrides.ts";
import { createDigester } from "./digest.ts";
import { TIER_ORDER, type Tier } from "../router/types.ts";
import { baselinePrices, buildUsageReport } from "../cost/report.ts";
import { buildDailySummary, createKv, markSummaryShown, summaryDue, summaryHasNews, type SummaryOllama } from "../cost/summary.ts";
import type { Ledger, ModelTrust } from "../cost/types.ts";
import { createRouter } from "../router/index.ts";
import { createConversationStore } from "../router/state.ts";
import { UpstreamError } from "../upstream/types.ts";
import { apiKeySource, ollamaKeySource } from "../config/load.ts";
import { ollamaMeter } from "../upstream/ollama-usage.ts";
import { routerConfigPath } from "../cli/config-cmd.ts";
import { PINNED_CONFIG_PATHS, watchConfig } from "../config/hot-reload.ts";
import type { RouterConfig } from "../config/types.ts";
import { createLogger } from "../util/log.ts";
import { openDb } from "../util/sqlite.ts";
import { WireErrorException, renderErrorEnvelope } from "../wire/openai/errors.ts";
import { renderModelList } from "../wire/openai/models.ts";
import { parseChatRequest } from "../wire/openai/request.ts";
import { createBufferedSink, createStreamingSink } from "../wire/openai/sink.ts";
import type { NormRequest, WireError } from "../wire/types.ts";
import { runTurn } from "./turn.ts";

export interface StartedServer {
	// No websocket upgrade path, so the Server payload type is `undefined`.
	server: Server<undefined>;
	stop(): Promise<void>;
}

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

export function startServer(cfg: RouterConfig): StartedServer {
	const log = createLogger(cfg.logLevel);

	if (cfg.ledger.path !== ":memory:") mkdirSync(dirname(cfg.ledger.path), { recursive: true });
	const db = openDb(cfg.ledger.path);
	const ledger = createLedger(db, cfg);
	const { upstream, catalog, ollama, ollamaUsage, ollamaCostScale } = createProviders(cfg, db, log);
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
			},
			onError: (message) => {
				log.warn("config reload rejected; keeping the running config", { error: message });
			},
		},
	);

	if (context.enabled) {
		log.info("agentdox context bridge enabled", {
			url: cfg.context.baseUrl,
			defaultScope: cfg.context.defaultScope === "" ? "(per-request header only)" : cfg.context.defaultScope,
			recordTurns: cfg.context.recordTurns,
		});
	}

	if (cfg.openrouter.apiKey === "") {
		log.warn("OPENROUTER_API_KEY is not set; /v1/chat/completions will fail at dispatch time");
	}
	if (ollama !== null) {
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

	// One housekeeping timer for both tables. `unref`'d so it never holds the
	// process open.
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
	}, 60_000);
	pruneTimer.unref();

	// Ledger retention: hourly, and once at boot so a lowered setting takes
	// effect without waiting. Reads the live config, so it hot-reloads.
	const retain = (): void => {
		try {
			const dropped = ledger.prune?.(cfg.ledger.retentionDays) ?? 0;
			if (dropped > 0) log.info("pruned ledger rows past retention", { dropped, retentionDays: cfg.ledger.retentionDays });
		} catch (err) {
			log.warn("ledger retention prune failed", { error: err instanceof Error ? err.message : String(err) });
		}
	};
	const retentionTimer = setInterval(retain, 3_600_000);
	retentionTimer.unref();
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

	const handleChatCompletions = async (req: Request): Promise<Response> => {
		let normReq: NormRequest;
		try {
			normReq = parseChatRequest(await req.json(), req.headers);
		} catch (err) {
			// The slot was acquired before parsing; a rejected body never reaches
			// runTurn's `finally`, so it must be released here or every malformed
			// request permanently consumes one of maxConcurrentTurns.
			releaseTurn();
			if (err instanceof WireErrorException) return wireErrorResponse(err.wireError);
			return wireErrorResponse({
				status: 400,
				code: "invalid_json",
				message: err instanceof Error ? err.message : "request body is not valid JSON",
			});
		}

		const { sink, response } = normReq.stream
			? createStreamingSink(normReq.requestedModel)
			: createBufferedSink(normReq.requestedModel);

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

			if (cfg.server.apiKey !== undefined && cfg.server.apiKey !== "") {
				if (req.headers.get("authorization") !== `Bearer ${cfg.server.apiKey}`) {
					return wireErrorResponse({ status: 401, code: "unauthorized", message: "invalid or missing bearer token" });
				}
			}

			const url = new URL(req.url);
			try {
				if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
					if (!acquireTurn()) {
						return wireErrorResponse({ status: 429, code: "too_many_requests", message: "too many concurrent turns" });
					}
					return await handleChatCompletions(req);
				}
				if (req.method === "GET" && url.pathname === "/v1/models") {
					return json(renderModelList(cfg, ledger.blendedRate(cfg.ledger.blendWindowDays)));
				}
				if (req.method === "GET" && url.pathname === "/v1/router/stats") {
					return json(computeStats(ledger));
				}
				if (req.method === "GET" && url.pathname === "/v1/router/report") {
					// Usage analytics for `/router report` and the CLI: bounded window,
					// optional harness scope (the X-Omp-Harness header value).
					const rawDays = url.searchParams.get("days");
					const parsedDays = rawDays === null ? 7 : Number.parseInt(rawDays, 10);
					const windowDays = Number.isInteger(parsedDays) ? Math.min(Math.max(parsedDays, 1), 365) : 7;
					const harnessId = url.searchParams.get("harness") ?? "";
					return json(buildUsageReport(db, { windowDays, harnessId, baselines: baselinePrices(cfg.report.baselines, (s) => catalog.find(s)) }));
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
						ollama === null || meter === null ? null : { plan: meter.plan ?? null, usedUsd: meter.usedUsd, creditsUsd: meter.creditsUsd, runwayDays: runway?.days ?? null };
					const summary = buildDailySummary(db, {
						harnessId,
						baselines: baselinePrices(cfg.report.baselines, (s) => catalog.find(s)),
						spikes: ledger.softFailureSpikes?.() ?? [],
						ollama: ollamaSummary,
					});
					if (auto && !summaryHasNews(summary)) return json({ due: false, reason: "nothing to report", summary: null });
					if (auto) markSummaryShown(kv, harnessId);
					return json({ due: true, summary });
				}
				if (req.method === "GET" && url.pathname === "/v1/router/decisions") {
					const rawLimit = url.searchParams.get("limit");
					const parsed = rawLimit === null ? 50 : Number.parseInt(rawLimit, 10);
					const limit = Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 1_000) : 50;
					// ?session=<omp session id> narrows to one session (/router why).
					const session = url.searchParams.get("session") ?? "";
					const entries = session === "" ? ledger.recentEntries(limit) : (ledger.entriesForSession?.(session, limit) ?? []);
					return json({ entries: entries.map((e) => ({ ...e, feedback: feedback.forLedgerId(e.id) })) });
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
					return json({ enabled: d.enabled, minBytes: d.minBytes, maxBytes: d.maxBytes, tools: d.tools, fromTier: d.fromTier });
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
						// Provenance only; never the key itself.
						apiKeySource: apiKeySource(cfg).source,
						// Provenance only; never the agentdox token itself.
						agentdox: context.enabled
							? { url: cfg.context.baseUrl, defaultScope: cfg.context.defaultScope, recordTurns: cfg.context.recordTurns }
							: null,
						// Never the key. `available` is the circuit breaker: false while a
						// 402/429 cooldown routes every turn around Ollama.
						ollama:
							ollama === null
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

	return {
		server,
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
