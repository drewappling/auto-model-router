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
import type { ContextBridge } from "../context/types.ts";
import type { RouterConfig } from "../config/types.ts";
import { EMPTY_USAGE, type Ledger, type UsageCounts } from "../cost/types.ts";
import { createProbe, type Probe } from "../router/escalate.ts";
import { resolveHoldTurns } from "../router/explore.ts";
import { adjustPendingEstimate } from "../tokens/estimate.ts";
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

/**
 * Probe signals that indict the PROVIDER rather than the tier: an empty
 * stream, a refusal, or an error finish says nothing about whether the work
 * needed a stronger model. Measured on 7 days of live traffic, 49 of 71
 * escalations re-dispatched the very slug that had just failed, one tier up,
 * paying the tier premium for a provider hiccup. These signals get the same
 * same-tier failover an HTTP 5xx gets, and only then step up a tier. Structural
 * signals (malformed arguments, a repeated call) still escalate directly — a
 * stronger model is the remedy there.
 */
const PROVIDER_SIGNALS: ReadonlySet<string> = new Set(["empty_completion", "refusal", "upstream_error"]);

/** A client hang-up: the request signal fired, or the transport reported the abort. */
function isClientAbort(err: unknown, signal: AbortSignal): boolean {
	return signal.aborted || (err instanceof UpstreamError && err.kind === "aborted");
}

export interface TurnDeps {
	config: RouterConfig;
	router: Router;
	upstream: UpstreamClient;
	ledger: Ledger;
	conversations: ConversationStore;
	catalog: CatalogSource;
	/** agentdox bridge. The disabled bridge makes every call here a no-op. */
	context: ContextBridge;
}

/** A dead client connection surfaces as the sink throwing mid-stream. */
class SinkError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause));
		this.name = "SinkError";
	}
}

/** Latest user text, used to bias agentdox relevance ranking and as the recorded turn. */
function lastUserText(req: NormRequest): string {
	for (let i = req.messages.length - 1; i >= 0; i--) {
		const m = req.messages[i];
		if (m !== undefined && m.role === "user") return m.text;
	}
	return "";
}

/** Session title: the conversation's opening ask, truncated. */
function sessionTitle(req: NormRequest): string {
	for (const m of req.messages) {
		if (m.role === "user" && m.text.trim() !== "") {
			const t = m.text.trim().replace(/\s+/g, " ");
			return t.length > 80 ? `${t.slice(0, 79)}…` : t;
		}
	}
	return `omp ${req.conversationKey.slice(0, 8)}`;
}

export async function runTurn(
	req: NormRequest,
	sink: ResponseSink,
	deps: TurnDeps,
	signal: AbortSignal,
): Promise<void> {
	const { config, router, upstream, ledger, conversations, context: bridge } = deps;
	const log = createLogger(config.logLevel);
	const state = conversations.load(req.conversationKey);
	const turnNumber = state.turn + 1;
	// Request header wins; the configured default covers harnesses that send none.
	const doxScope = req.agentdoxScope !== "" ? req.agentdoxScope : config.context.defaultScope;
	const doxActive = bridge.enabled && doxScope !== "";

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

		// Resolve the shared context block. The bridge refreshes only when this
		// turn's prefix is already cold — a model switch or a retry — so the
		// injected bytes stay identical while the cache is worth keeping.
		let contextBlock: string | undefined;
		if (doxActive) {
			const pin = await bridge.resolve({
				scope: doxScope,
				conversationKey: req.conversationKey,
				pinnedVersion: state.contextVersion,
				pinnedFetchedAtMs: state.contextFetchedAtMs,
				modelSwitching: state.currentSlug !== null && state.currentSlug !== decision.slug,
				retrying: attempt > 0,
				query: lastUserText(req),
			});
			if (pin !== null) {
				contextBlock = pin.block;
				// Pin immediately, even if this attempt later fails: the block was
				// dispatched, so the next turn must re-send the same bytes to hit
				// whatever cache this attempt warmed.
				state.contextVersion = pin.version;
				state.contextFetchedAtMs = pin.fetchedAtMs;
			}
		}

		log.debug("agentdox context", {
			active: doxActive,
			scope: doxScope === "" ? "(none)" : doxScope,
			injected: contextBlock !== undefined,
			chars: contextBlock?.length ?? 0,
		});

		const body = req.renderUpstreamBody({
			slug: decision.slug,
			fallbacks: decision.fallbacks,
			sessionId: decision.sessionId,
			cacheBreakpointMessageIndices: decision.cacheBreakpointMessageIndices,
			reasoning: decision.reasoning,
			maxTokens: decision.maxTokens,
			stripAssistantReasoning: decision.stripAssistantReasoning,
			...(contextBlock === undefined ? {} : { contextBlock }),
			...(decision.compactionPlan.length > 0 ? { compactionPlan: decision.compactionPlan } : {}),
		});

		// Calibrate the token estimate against the bytes that actually go out —
		// after compaction shrank the prompt and the context block was appended
		// — not the raw request the estimate was taken from.
		adjustPendingEstimate(
			req.conversationKey,
			req.promptBytes - decision.compactionSavedBytes + (contextBlock === undefined ? 0 : Buffer.byteLength(contextBlock)),
		);

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
		// Accumulated only when the bridge is live; the transcript write-back is
		// the sole consumer, and a dead bridge must cost nothing on the hot path.
		let assistantText = "";
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
				promptTokensSaved: decision.promptTokensSaved,
			});
			// Book the money HERE, beside the ledger row, so the two can never
			// disagree. Every dispatch that reaches this point was billed —
			// committed, wasted by an escalation, or aborted mid-stream — but only
			// the committed path used to reach the state update below, so aborted
			// dispatches (30% of real spend on live data) stayed invisible to the
			// per-conversation budget guard.
			conversations.accrue(req.conversationKey, { spentUsd: reportedUsd ?? decision.forecast.expectedUsd });
		};

		// Same-tier failover: re-route with every failed slug excluded and accept
		// the result only if it stays in this tier on a different model. A
		// 404/429/5xx, an empty stream, or a refusal indicts the slug, not the
		// tier, so a sibling is tried before the tier is abandoned. Returns null
		// when the bound is hit or the router widened tiers on its own; the
		// caller then falls through to tier escalation.
		const trySameTierFailover = async (why: string): Promise<Decision | null> => {
			if (sameTierFailovers >= MAX_SAME_TIER_FAILOVERS) return null;
			let failover: Decision | null = null;
			try {
				failover = await router.route(req, { attempt: attempt + 1, excludeSlugs: failedSlugs });
			} catch {
				// A routing failure here must not kill the turn; tier escalation
				// may still find a model.
				return null;
			}
			if (failover === null || failover.tier !== decision.tier || failedSlugs.includes(failover.slug)) return null;
			sameTierFailovers++;
			failover.reasons = [...failover.reasons, `failover: ${decision.slug} ${why}; retrying ${failover.slug} in ${failover.tier}`];
			return failover;
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
				// Before jumping a tier, try a DIFFERENT model in the same tier:
				// a 404/429/5xx indicts the slug, not the tier. Null means no other
				// candidate at this tier — the router widened on its own or only
				// the failed slug qualifies — so fall through to tier escalation.
				const failover = await trySameTierFailover(`returned ${uerr.kind}`);
				if (failover !== null) {
					pendingDecision = failover;
					await writeEntry({ wasted: true, escalationSignal: null, error: `${uerr.kind}: ${uerr.message}` });
					return "retry";
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
		// The upstream generation ran to its end — either the stream closed
		// normally, or the client hung up after the finish event had already
		// arrived. Both are settled generations; only the second used to be
		// recorded as an error.
		let streamEnded = false;

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
								if (ttftMs === null) ttftMs = Date.now() - startedAt;
								if (doxActive) assistantText += ev.delta;
								break;
							// A tool call is output too. Only text/reasoning used to stamp
							// TTFT, so a dispatch that emitted nothing BUT tool calls —
							// the dominant shape in an agentic loop, 83% of dispatches —
							// recorded ttft_ms NULL and was then discarded by
							// LATENCY_SELECT, which requires it. Latency/throughput
							// scoring was therefore measuring the minority of turns that
							// happened to narrate, and steering all the rest with it.
							case "reasoning":
							case "tool_call":
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
				if (escalateVerdict === null) streamEnded = true;
			} catch (err) {
				if (escalateVerdict !== null || attemptAbort.signal.aborted) {
					// Teardown noise from our own abort; the escalate path owns the outcome.
				} else if (err instanceof SinkError) {
					sinkDied = true;
				} else if (finishReason !== null && isClientAbort(err, signal)) {
					// The client closed the connection AFTER the finish event: the
					// generation is complete and billed, the client already has its
					// answer, only the trailing `[DONE]` went unread. Measured live:
					// 1,842 of 2,068 "request aborted" rows carried a finish reason
					// and full usage, and every one skipped the state save below —
					// stale hysteresis, cache-warmth, and compaction state on 12% of
					// turns. A settled generation is settled however the socket
					// closed.
					streamEnded = true;
				} else {
					streamError = err;
				}
			} finally {
				// Never leak the upstream connection, whatever happened above.
				attemptAbort.abort();
			}
			if (streamEnded && !committed && escalateVerdict === null) {
				const verdict = probe.verdictOnEnd();
				if (verdict.action === "commit") {
					committed = true;
					try {
						for (const heldChunk of probe.held()) await emit(heldChunk);
					} catch (err) {
						if (err instanceof SinkError) sinkDied = true;
						else streamError = err;
					}
				} else {
					escalateVerdict = verdict;
				}
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
			// The model that produced the rejected output must not serve the
			// retry, at this tier or the next: without this, 49 of 71 measured
			// escalations re-dispatched the same slug one tier up.
			failedSlugs.push(decision.slug);
			if (PROVIDER_SIGNALS.has(escalateVerdict.signal) && attempt + 1 < maxAttempts) {
				const failover = await trySameTierFailover(`${escalateVerdict.signal} (${escalateVerdict.reason})`);
				if (failover !== null) {
					pendingDecision = failover;
					await writeEntry({ wasted: true, escalationSignal: escalateVerdict.signal, error: null });
					log.info("same-tier failover", {
						signal: escalateVerdict.signal,
						reason: escalateVerdict.reason,
						from: decision.slug,
						to: failover.slug,
						tier: decision.tier,
						attempt,
					});
					continue;
				}
			}
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
		// Escalations accumulate in SQL for the same reason spend does: `save`
		// below no longer writes this column, so a snapshot cannot clobber it.
		conversations.accrue(req.conversationKey, { escalations });
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
		// Spend is already booked in `writeEntry`, beside the ledger row, so it is
		// deliberately NOT accumulated here — doing both would double-count.
		// Keep the in-memory copy coherent for anything reading `state` later.
		state.spentUsd += reportedUsd ?? decision.forecast.expectedUsd;
		state.escalations += escalations;
		state.lastPromptTokens = usage.promptTokens;
		// Persist the plan that was actually dispatched. The next turn re-applies
		// it verbatim (after byte-length validation), keeping shrunk tool results
		// shrunk so the prompt cache survives and the savings compound.
		state.compactionPlan = decision.compactionPlan.length > 0 ? decision.compactionPlan : null;
		state.compactionPlanTokens = decision.compactionPlanTokens;
		if (usage.cachedTokens > 0 || usage.cacheWriteTokens > 0) {
			// Non-zero cache traffic is direct evidence the upstream cache exists.
			state.cacheWarmSlug = servedSlug ?? decision.slug;
			state.cacheWarmAtMs = Date.now();
		}
		state.updatedAtMs = Date.now();
		conversations.save(state);

		// Record the settled turn into agentdox, attributed to the model that
		// actually served it. Queued and never awaited: the transcript is an
		// artifact of the turn, not a precondition for finishing it. A
		// `tool_calls` finish means the assistant is still working, so the bridge
		// buffers the fragment rather than writing a near-empty turn.
		//
		// Only the agent's WORKING conversation is transcribed. A harness also
		// drives utility calls through this same provider with `model: auto` —
		// omp asks for a conversation title and a complexity rating — and those
		// answer ABOUT a conversation instead of participating in one, which is
		// where the junk records (`high`, `<title>…</title>`) came from. They are
		// single-shot and carry NO tool schemas, while an agent always ships its
		// tools, so the tool array is the discriminator. A deliberately
		// tool-less session is therefore not transcribed: silence beats garbage,
		// because every junk record is re-injected into every later turn.
		if (doxActive && req.tools.length > 0) {
			const userText = lastUserText(req);
			const turnEnded = finishReason !== "tool_calls";
			log.debug("agentdox record turn", {
				conversationKey: req.conversationKey.slice(0, 8),
				userChars: userText.length,
				assistantChars: assistantText.length,
				finishReason,
				turnEnded,
			});
			bridge.recordTurn({
				scope: doxScope,
				conversationKey: req.conversationKey,
				title: sessionTitle(req),
				userText,
				assistantText,
				slug: servedSlug ?? decision.slug,
				tier: decision.tier,
				turnEnded,
			});
		}

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
