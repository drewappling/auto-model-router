/**
 * Turn orchestrator — where money is actually spent.
 *
 * One turn = up to `escalation.maxAttempts` dispatches. Each attempt routes,
 * dispatches, and runs the guarded probe. The probe holds output until the
 * generation proves itself; on rejection the attempt is aborted (so no further
 * tokens bill), recorded as wasted, and retried one tier up. Once a single
 * byte reaches the client the attempt is committed and NEVER retried.
 */

import type { CatalogSource } from "../catalog/types.ts";
import type { RouterConfig } from "../config/types.ts";
import { EMPTY_USAGE, type Ledger, type UsageCounts } from "../cost/types.ts";
import { createProbe, type Probe } from "../router/escalate.ts";
import { resolveHoldTurns } from "../router/explore.ts";
import {
	TIER_ORDER,
	type ConversationStore,
	type Decision,
	type ProbeVerdict,
	type Router,
	type Tier,
} from "../router/types.ts";
import { UpstreamError, type Dispatch, type UpstreamClient } from "../upstream/types.ts";
import { createLogger } from "../util/log.ts";
import type { NormRequest, ResponseSink, TurnSummary, UpstreamChunk } from "../wire/types.ts";

/**
 * Same-tier failovers allowed per turn. A retryable upstream error (404
 * model_unavailable, 429 rate_limit, 5xx upstream_error) indicts the slug,
 * not the tier, so a failed model is first swapped for a sibling. Bounded
 * because an exhausted tier must escalate rather than spin through the whole
 * catalog while the client waits; `escalation.maxAttempts` caps total
 * attempts regardless.
 */
const MAX_SAME_TIER_FAILOVERS = 2;

export interface TurnDeps {
	config: RouterConfig;
	router: Router;
	upstream: UpstreamClient;
	ledger: Ledger;
	conversations: ConversationStore;
	catalog: CatalogSource;
}

/** A dead client connection surfaces as the sink throwing mid-stream. */
class SinkError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "SinkError";
	}
}

export async function runTurn(
	req: NormRequest,
	sink: ResponseSink,
	deps: TurnDeps,
	signal: AbortSignal,
): Promise<void> {
	const { config, router, upstream, ledger, conversations } = deps;
	const log = createLogger(config.logLevel);
	const state = conversations.load(req.conversationKey);
	const turnNumber = state.turn + 1;

	// The trigger list is the source of truth for enabled signals, except
	// length_stop, which rides on its own toggle (escalation.escalateOnLengthStop).
	const triggers = new Set(config.escalation.triggers);
	if (config.escalation.escalateOnLengthStop) triggers.add("length_stop");
	else triggers.delete("length_stop");

	const maxAttempts = Math.max(1, config.escalation.maxAttempts);
	let escalateFrom: Tier | undefined;
	let escalations = 0;
	// Slugs that returned a retryable upstream error on THIS turn, fed back
	// into routing as excludeSlugs so a failover retry cannot re-pick the
	// model that just failed.
	const failedSlugs: string[] = [];
	let sameTierFailovers = 0;
	// A failover decision already routed inside onUpstreamError; the next
	// loop iteration dispatches it instead of routing again.
	let pendingDecision: Decision | null = null;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		// Client disconnected before anything was dispatched: spend nothing.
		if (signal.aborted) return;

		let decision: Decision;
		if (pendingDecision !== null) {
			decision = pendingDecision;
			pendingDecision = null;
		} else {
			try {
				const opts: { attempt: number; escalateFrom?: Tier; excludeSlugs?: readonly string[] } = { attempt };
				if (escalateFrom !== undefined) opts.escalateFrom = escalateFrom;
				if (failedSlugs.length > 0) opts.excludeSlugs = failedSlugs;
				decision = await router.route(req, opts);
			} catch (err) {
				await sink.error({ status: 500, code: "router_error", message: err instanceof Error ? err.message : String(err) });
				return;
			}
		}

		const body = req.renderUpstreamBody({
			slug: decision.slug,
			fallbacks: decision.fallbacks,
			sessionId: decision.sessionId,
			cacheBreakpointMessageIndices: decision.cacheBreakpointMessageIndices,
			reasoning: decision.reasoning,
			maxTokens: decision.maxTokens,
			stripAssistantReasoning: decision.stripAssistantReasoning,
		});

		// Our own abort composes with the client's: escalation teardown and
		// client disconnect both kill the upstream connection.
		const attemptAbort = new AbortController();
		const attemptSignal = AbortSignal.any([signal, attemptAbort.signal]);
		const startedAt = Date.now();
		let usage: UsageCounts = { ...EMPTY_USAGE };
		let reportedUsd: number | null = null;
		let servedSlug: string | null = null;
		let finishReason: string | null = null;
		let ttftMs: number | null = null;
		let committed = false;
		let dispatch: Dispatch | null = null;
		let probe: Probe | null = null;
		let generationId: string | null = null;

		const writeEntry = async (fields: {
			wasted: boolean;
			escalationSignal: string | null;
			error: string | null;
		}): Promise<void> => {
			if (generationId === null && dispatch !== null) {
				generationId = await dispatch.generationId().catch(() => null);
			}
			ledger.record({
				id: crypto.randomUUID(),
				createdAtMs: Date.now(),
				conversationKey: req.conversationKey,
				sessionId: decision.sessionId,
				turn: turnNumber,
				requestedModel: req.requestedModel,
				harnessId: req.harnessId,
				ompSessionId: req.ompSessionId,
				slug: decision.slug,
				servedSlug,
				tier: decision.tier,
				classificationSource: decision.classification.source,
				reasons: decision.reasons,
				features: decision.features,
				score: decision.classification.score,
				confidence: decision.classification.confidence,
				task: decision.classification.task,
				classifierReasons: decision.classification.reasons,
				exploredFrom: decision.explored?.from ?? null,
				holdArm: resolveHoldTurns(config, req.conversationKey, escalations > 0).arm,
				predictedUsd: decision.forecast.expectedUsd,
				reportedUsd,
				usage,
				attempt,
				escalationSignal: fields.escalationSignal,
				latencyMs: Date.now() - startedAt,
				ttftMs,
				finishReason,
				wasted: fields.wasted,
				upstreamGenerationId: generationId,
				error: fields.error,
			});
		};

		// "retry" re-enters the attempt loop; "done" means the turn is settled
		// (client told, or client gone) and runTurn must return.
		const onUpstreamError = async (err: unknown): Promise<"retry" | "done"> => {
			const uerr =
				err instanceof UpstreamError
					? err
					: new UpstreamError("network", 0, err instanceof Error ? err.message : String(err), true);
			if (uerr.kind === "aborted" || signal.aborted) {
				// Client is gone; nothing to retry and no one to notify. Record the
				// spend so far so the ledger stays honest.
				await writeEntry({ wasted: !committed, escalationSignal: null, error: uerr.message });
				return "done";
			}
			if (committed) {
				// Bytes already reached the client: retrying is impossible. Report
				// the failure; never sink.finish a truncated stream.
				await writeEntry({ wasted: false, escalationSignal: null, error: `${uerr.kind}: ${uerr.message}` });
				await sink.error(uerr.toWireError());
				return "done";
			}
			if (uerr.retryable && attempt + 1 < maxAttempts) {
				failedSlugs.push(decision.slug);
				if (sameTierFailovers < MAX_SAME_TIER_FAILOVERS) {
					// Before jumping a tier, try a DIFFERENT model in the same
					// tier: a 404/429/5xx indicts the slug, not the tier.
					let failover: Decision | null = null;
					try {
						failover = await router.route(req, { attempt: attempt + 1, excludeSlugs: failedSlugs });
					} catch {
						// A routing failure here must not kill the turn; tier
						// escalation below may still find a model.
						failover = null;
					}
					if (failover !== null && failover.tier === decision.tier && !failedSlugs.includes(failover.slug)) {
						sameTierFailovers++;
						failover.reasons = [
							...failover.reasons,
							`failover: ${decision.slug} returned ${uerr.kind}; retrying ${failover.slug} in ${failover.tier}`,
						];
						pendingDecision = failover;
						await writeEntry({ wasted: true, escalationSignal: null, error: `${uerr.kind}: ${uerr.message}` });
						return "retry";
					}
					// No different candidate at this tier — the router widened on
					// its own or only the failed slug qualifies. Fall through to
					// tier escalation.
				}
				const topTier = TIER_ORDER[TIER_ORDER.length - 1];
				if (decision.tier !== topTier) {
					escalations++;
					escalateFrom = decision.tier;
					await writeEntry({
						wasted: true,
						escalationSignal: "upstream_error",
						error: `${uerr.kind}: ${uerr.message}`,
					});
					return "retry";
				}
			}
			// Non-retryable, or out of runway: fail the turn openly.
			await writeEntry({ wasted: false, escalationSignal: null, error: `${uerr.kind}: ${uerr.message}` });
			await sink.error(uerr.toWireError());
			return "done";
		};

		let escalateVerdict: Extract<ProbeVerdict, { action: "escalate" }> | null = null;
		let streamError: unknown = null;
		let sinkDied = false;

		try {
			dispatch = await upstream.dispatch({ body, sessionId: decision.sessionId, signal: attemptSignal });
		} catch (err) {
			streamError = err;
		}

		if (dispatch !== null) {
			probe = createProbe(decision.probe, req, triggers);
			const emit = async (chunk: UpstreamChunk): Promise<void> => {
				try {
					await sink.chunk(chunk);
				} catch (err) {
					throw new SinkError(err);
				}
			};
			try {
				for await (const chunk of dispatch.chunks) {
					for (const ev of chunk.events) {
						switch (ev.type) {
							case "start":
								servedSlug = ev.servedSlug;
								if (ev.generationId !== null) generationId = ev.generationId;
								break;
							case "text":
							case "reasoning":
								if (ttftMs === null) ttftMs = Date.now() - startedAt;
								break;
							case "finish":
								finishReason = ev.reason;
								break;
							case "usage":
								usage = ev.usage;
								reportedUsd = ev.reportedCostUsd;
								break;
							default:
								break;
						}
					}
					if (committed) {
						await emit(chunk);
						continue;
					}
					const verdict = probe.observe(chunk);
					if (verdict === null) continue;
					if (verdict.action === "commit") {
						committed = true;
						for (const heldChunk of probe.held()) await emit(heldChunk);
						continue;
					}
					// Abort BEFORE breaking so the pending upstream read rejects and
					// no further tokens bill while we tear down.
					escalateVerdict = verdict;
					attemptAbort.abort();
					break;
				}
				if (!committed && escalateVerdict === null) {
					const verdict = probe.verdictOnEnd();
					if (verdict.action === "commit") {
						committed = true;
						for (const heldChunk of probe.held()) await emit(heldChunk);
					} else {
						escalateVerdict = verdict;
						attemptAbort.abort();
					}
				}
			} catch (err) {
				if (escalateVerdict !== null || attemptAbort.signal.aborted) {
					// Teardown noise from our own abort; the escalate path owns the outcome.
				} else if (err instanceof SinkError) {
					sinkDied = true;
				} else {
					streamError = err;
				}
			} finally {
				// Never leak the upstream connection, whatever happened above.
				attemptAbort.abort();
			}
		}

		if (sinkDied) {
			await writeEntry({ wasted: !committed, escalationSignal: null, error: "client connection lost" });
			return;
		}
		if (streamError !== null) {
			if ((await onUpstreamError(streamError)) === "retry") continue;
			return;
		}

		if (escalateVerdict !== null) {
			const hasRunway = attempt + 1 < maxAttempts && decision.probe.escalateTo !== null;
			if (hasRunway) {
				escalations++;
				escalateFrom = decision.tier;
				await writeEntry({ wasted: true, escalationSignal: escalateVerdict.signal, error: null });
				log.info("escalating turn", {
					signal: escalateVerdict.signal,
					reason: escalateVerdict.reason,
					from: decision.tier,
					attempt,
				});
				continue;
			}
			// No higher tier or no attempts left: commit what was held. A mediocre
			// answer beats an error.
			if (probe !== null) {
				committed = true;
				for (const heldChunk of probe.held()) await sink.chunk(heldChunk);
			}
		}

		await writeEntry({ wasted: false, escalationSignal: null, error: null });

		state.turn = turnNumber;
		state.currentSlug = servedSlug ?? decision.slug;
		// Capture the previously-served tier BEFORE overwriting it, so the
		// hysteresis re-arm below can tell whether this turn changed tier.
		const prevTier = state.currentTier;
		state.currentTier = decision.tier;
		state.escalations += escalations;
		// Hysteresis window. Only re-arm when the served tier actually changed
		// (or this turn escalated). Re-arming on EVERY turn — even a trivial one
		// served by a held hard model — extends the lock forever: the classifier
		// keeps saying trivial, but the window keeps getting pushed out, so the
		// router never downgrades. A stable tier needs no new hold; let the
		// existing window expire so the router can move down when the work is
		// actually easy.
		const tierChanged = prevTier !== decision.tier;
		if (tierChanged || escalations > 0) {
			state.stickyUntilTurn = turnNumber + resolveHoldTurns(config, req.conversationKey, escalations > 0).turns;
		}
		// Reported cost is authoritative; fall back to the forecast so the
		// budget guard still works when the provider omits cost.
		state.spentUsd += reportedUsd ?? decision.forecast.expectedUsd;
		state.lastPromptTokens = usage.promptTokens;
		if (usage.cachedTokens > 0 || usage.cacheWriteTokens > 0) {
			// Non-zero cache traffic is direct evidence the upstream cache exists.
			state.cacheWarmSlug = servedSlug ?? decision.slug;
			state.cacheWarmAtMs = Date.now();
		}
		state.updatedAtMs = Date.now();
		conversations.save(state);

		const summary: TurnSummary = {
			servedSlug: servedSlug ?? decision.slug,
			tier: decision.tier,
			attempts: attempt + 1,
			predictedUsd: decision.forecast.expectedUsd,
			reportedUsd,
			usage,
			reasons: decision.reasons,
			escalated: escalations > 0,
		};
		await sink.finish(summary);
		return;
	}

	// Every attempt looped without settling; the retry paths above always
	// continue or return, so reaching here means maxAttempts was 0-guarded and
	// the first iteration never ran. Fail openly rather than silently.
	await sink.error({ status: 502, code: "attempts_exhausted", message: "all routing attempts exhausted" });
}
