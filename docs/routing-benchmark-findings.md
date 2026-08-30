# Routing benchmark findings — 2026-08-29

Measured feedback from an external head-to-head benchmark of `auto-model-router`
against Claude Opus 5. Harness, tasks and raw runs live in
`E:/projects/auto-router-marketing/bench/`.

Everything below is measured, not inferred, except where explicitly flagged. Two
of my own earlier conclusions were wrong and are corrected in place.

---

## TL;DR

1. **The router is 20–32× cheaper at equal solve rate.** On 10 easy tasks both
   arms solved 20/20; on a 7-rung difficulty ladder both solved 5/7.
2. **Tier escalation works.** A turn classified `hard` reliably selects a
   costlier model — the hard-turn count matches the non-flash turn count ~1:1
   across two independent ladder runs (to `gemini-3.7-flash` in one, to
   `grok-4.6` in the other). *An earlier version of this document claimed the
   opposite; that was my error, corrected in §3.*
3. **What never happens is reaching `claude-opus-5`.** Two gates: the price
   ceiling excludes it below `hard`, and at `hard` it is outranked by cheaper
   high-quality models. Whether that is a defect depends on whether
   `grok-4.6`-class is "good enough" — this benchmark cannot say.
4. **Mid-stream escalation signals never fired** — `escalation_signal` was empty
   on every one of ~190 routed ladder turns. That is a different mechanism from
   tier selection and may simply mean nothing malformed occurred.
5. **The standalone `serve` process died 4 times inside one normally-completing
   run.** The crash is real and mid-run; the *trigger* is unidentified — my first
   explanation (client disconnect mid-stream) does not reproduce. Details in §7.

---

## 1. What was measured, and how

- **Harness**: omp in `-p --mode=json` print mode. Every turn's tokens,
  duration, TTFT and tool calls are read off omp's own event stream, so both
  arms are measured by the same instrument.
- **Provider guard**: each arm declares its expected omp provider and every
  completion turn is checked against it — `anthropic` + `claude-opus-5` for the
  baseline (first-party, never OpenRouter), `benchrouter` for the router arm.
  Zero violations across the re-runs. Added after an early pilot silently
  resolved `--model auto` to OpenRouter's own `auto` meta-router.
- **Router arm**: the standalone `auto-model-router serve` endpoint registered
  as a plain OpenAI-compatible provider — the documented non-omp path (README
  § "Standalone alternative"). Nothing pinned, nothing stubbed; the router
  routes freely. Costs come from its own ledger `reported_usd`.
- **Opus arm**: omp's Anthropic provider at list price.
- **Isolation**: both arms run under a copied `PI_CODING_AGENT_DIR` with MCP and
  the router's omp extensions stripped, so the tool surface is identical.
  `AUTO_MODEL_ROUTER_HOME` points at a bench home seeded from the live DB, so the
  router keeps its warm catalog, trust history and calibration.
- **Grading**: hidden test files copied in only *after* omp exits. Every task is
  verified to fail an untouched workspace and to pass a reference solution
  before any run (`bench/validate-ladder.ts`).

> **Print mode — resolved.** During the benchmark the embedded extension only
> registered the provider inside a session with a UI, so `omp -p` could not see
> `auto-model-router/auto` at all; that is why the harness drives the standalone
> `serve` endpoint instead. Fixed upstream in **0.2.20** (`fix(embed): resolve the
> router in print mode and subagents`) — verified: `omp -p --model
> auto-model-router/auto` now resolves natively with no standalone server. The
> harness keeps the `serve` path because it gives the benchmark its own isolated
> ledger, not because the embedded path is broken.

---

## 2. Cost result

| Suite | Run | Router | Opus 5 | Ratio |
|---|---|---|---|---|
| 10 easy tasks | trials 1+2 | 20/20 · $0.3577 | 20/20 · $11.4040 | 31.9× |
| 10 easy tasks | re-run | 10/10 · $0.2695 | 10/10 · $5.2092 | 19.3× |
| 7-rung ladder | first | 5/7 · $0.3026 | 5/7 · $6.2506 | 20.7× |
| 7-rung ladder | re-run | 5/7 · $0.4619 | **6/7** · $6.5967 | 14.3× |

Across four independent runs the ratio lands between **14× and 32×**. On the
ladder re-run Opus 5 edged the router on correctness for the first time (6/7 vs
5/7), which is the outcome the ladder was built to be able to detect.

Turn counts are comparable (184 vs 217 on the easy suite; 86 vs 91 on the
ladder), so the saving is not bought with extra turns. Median TTFT is the
router's one clear regression: **6564 ms vs 1473 ms**, a 4.5× penalty paid on
classification and dispatch before anything streams.

The multiple is not stable — it moved from 26.4× to 40.8× between two identical
trials, driven by which task Opus happened to thrash on. "Well over an order of
magnitude" is defensible; a precise figure is not.

---

## 3. Escalation — corrected

**I got this wrong first time.** I reported that the router "never escalates",
having looked at the served-model list, seen only `glm-5.3-flash` and
`gemini-3.7-flash`, and mentally filed both as "flash models, therefore no
escalation". I never checked whether the counts lined up with the tier. They do.

### Tier escalation works, and is close to deterministic

Hard-tier turns versus turns served by something other than the cheap default:

| Rung | ladder-1 hard / non-flash | v2-ladder hard / non-flash |
|---|---|---|
| L1 in-range | 0 / 0 | 0 / 0 |
| L2 round-half-even | 6 / 6 | 0 / 0 |
| L3 csv-document | 4 / 4 | 0 / 0 |
| L4 sliding-limiter | 3 / 6 | 5 / 5 |
| L5 savepoints | 3 / 3 | 7 / 7 |
| L6 semver-ranges | 2 / 3 | 0 / 0 |
| L7 minimal-diff | 3 / 4 | 1 / 1 |

The escalation *target* differs by run, which is itself worth knowing:
`ladder-1` stepped up to `gemini-3.7-flash` ($0.75/MTok, ~10× the default);
`v2-ladder` stepped up to `grok-4.6` ($2.00/MTok, ~28×). Same config, same
catalog — the choice moves with trust and latency history, which are live inputs
to the ranking. Escalation behaviour is therefore **not reproducible run to run**,
even though it is reliable *within* a run.

### What genuinely never happens

`anthropic/claude-opus-5` was never selected in any run. §4 explains why, and
that analysis stands: the price ceiling excludes it below `hard`, and at `hard`
it loses the quality-per-dollar ranking to cheaper models scoring nearly as well.

Whether that is a *problem* is not something this benchmark answers. If
`grok-4.6` is good enough for the hard turns, the router is behaving correctly
and cheaply. The one weak signal available: rung 5 failed in `ladder-1` when it
escalated only as far as `gemini-3.7-flash` (3 turns) and passed in `v2-ladder`
when it escalated to `grok-4.6` (7 turns). Rung 4 pushes the other way — it
passed in `ladder-1` without much escalation and failed in `v2-ladder` *with*
`grok-4.6` on 5 turns. With n=1 per cell these cancel out; nothing is
established.

### Mid-stream escalation is a separate mechanism, and it never fired

`escalation_signal` — the abort-and-redispatch-upward path for malformed tool
calls, empty completions and repeated calls — was empty on every routed ladder
turn, as was `attempt > 0`. That is consistent with "no turn ever came back
malformed" rather than evidence of a defect; the ladder gave it nothing to react
to.

## 4. Root cause: two gates, both hard

### Gate 1 — the price ceiling is absolute

`explain` on a deep-loop hard task, shipped config:

```
excluded:
  over_price_ceiling  1  e.g. anthropic/claude-opus-5
decision:
  model  z-ai/glm-5.3-flash
  tier   moderate
```

`moderate.maxInputPerMtok` is 4.0 and Opus 5 is $5.00/MTok, so it is excluded
before ranking ever runs. Sweeping `qualityExponent` at the shipped ceiling:

| qualityExponent | winner | Opus 5 |
|---|---|---|
| 3 | `deepseek-v4-flash-0731` | price-excluded |
| 100 | `gpt-5.6-sol` | price-excluded |
| 500 | `gpt-5.6-sol` | price-excluded |

**No exponent, however large, can select Opus 5 at `moderate`.** The ceiling is
a hard gate, not a weighting. Only `hard` has no ceiling — and reaching `hard`
requires the classifier to say so.

### Gate 2 — the ranking cannot express "pay for quality"

`score = (quality/100) ^ qualityExponent / effectiveUsd` (`candidates.ts:266`).

With the ceiling lifted to $12/MTok so every model is eligible, the measured
winner by exponent:

| qualityExponent | winner |
|---|---|
| 1 – 30 | `glm-5.3-flash` / `deepseek-v4-flash` |
| 45 – 60 | `gemini-3.7-flash` |
| 100 | `gpt-5.6-sol` |
| **140+** | **`claude-opus-5`** |

Shipped values are 1 (`moderate`) and 3 (`hard`). Opus 5 needs roughly **140** —
two orders of magnitude higher.

The reason is structural: **quality scores occupy a narrow band (69–78 on the
coding axis) while prices span ~250× ($0.02 to $5.00).** Dividing a bounded
numerator by an unbounded denominator means price wins unless the exponent is
enormous. Raising the exponent is a numerically fragile lever — at 140,
`0.715^140 ≈ 1e-20` — and it distorts every other tier at the same time.

**Suggestion.** The exponent is the wrong shape of knob for this. Options worth
considering, roughly in order of how much they change:

- **Normalise quality within the candidate set** (percentile or z-score) before
  exponentiating, so the spread is comparable to the price spread instead of
  being compressed into 69–78.
- **Make the top tier a capability floor rather than a cost ranking** — at
  `hard`, pick the highest-quality model within an absolute per-turn budget,
  rather than the best quality-per-dollar.
- **A per-tier price *floor***, the mirror of the existing ceiling, so the top
  tier cannot resolve to a bargain model.

### An earlier explanation of mine was wrong

I first attributed this to the coding axis with fixed floors and computed
"exponent ≈ 49". Two errors: the axis actually in play varies (a short prompt
resolved on `intelligence`, 45–63, not `coding`), and the denominator is the
trust- and latency-adjusted *forecast turn cost*, not price per MTok. The
corrected figure is ~140, and the ceiling gate matters more than the exponent.

---

## 5. Classification is structural, not semantic

The classifier scores difficulty from conversational features — prompt tokens,
turn depth, tool-loop depth — not from what the task actually demands.

A single-turn request to implement a nested-transaction store with savepoints
classified **`simple`** (score 0.304), because `promptTokens 80, turnDepth 1`.
A 62-message deep tool loop on the same task classified **`moderate`**, with the
reasons `+0.08 conversation depth 32`, `+0.03 1 tools offered`.

This is coherent — context size is a real cost driver, and cheap models genuinely
handle long mechanical loops. But it means **`hard` tracks conversational depth,
not difficulty**, so a genuinely hard problem stated briefly will never reach the
tier that has no price ceiling. That is the mechanism behind finding 3.

---

## 6. Escalation works once both gates are opened

Overlay: `moderate.maxInputPerMtok: 12.0`, `qualityExponent: 140` on
`moderate` and `hard`. Re-running rung 5:

```
L5-savepoints  router  PASS  19 turns  $0.3338  347.8s
   models: glm-5.3-flash×16  claude-opus-5×3
```

The router escalated to Opus 5 for 3 of 19 turns and solved the task, at $0.33 —
**2.5× cheaper than the pure-Opus run ($0.8203)** which also solved it.

That is the shape the product presumably wants: cheap for the mechanical turns,
frontier for the few that need it. It is reachable today only by config that is
well outside the shipped defaults.

*Honest caveat:* rung 5 also passed once under default config on a re-run, so
this single run does **not** prove escalation caused the pass. What it proves is
that escalation *fires* — `claude-opus-5` served 3 turns, from the ledger.

---

## 7. The `serve` process dies intermittently — trigger unknown

**Corrected.** An earlier version of this document asserted that a client
disconnecting mid-stream crashes the router. That claim was challenged, I tried
to reproduce it, and **I could not.** What follows separates what is evidenced
from what is not.

### What is established

`ladder-1` ran to completion (exit 0, `aborted: false`) and recorded
**4 router restarts** across 3 different cells (`L3-csv-document` ×1,
`L5-savepoints` ×2, `L6-semver-ranges` ×1). These were mid-run deaths detected by
the harness health check, which restarted the process each time — visible in
`_router-home/serve.log` as a crash trace immediately followed by a fresh
`auto-model-router listening on ...` line.

This is **not** the per-session embedded router shutting down with its omp
session. The benchmark never uses the embedded path: it spawns a standalone
`auto-model-router serve` process that outlives every individual omp cell, and no
external kill was issued during the run.

The process exits on an uncaught exception, with Bun's crash banner:

```
TypeError: Invalid state: Controller is already closed
 code: "ERR_INVALID_STATE"
      at send  (src/wire/openai/sink.ts:29:28)
      at error (src/wire/openai/sink.ts:58:4)
      at        (src/server/http.ts:261:33)
```

It is intermittent: `esc-2` ran clean with zero crashes.

### What is NOT established

I assumed the trigger was a client vanishing mid-stream. Direct attempt to
reproduce, against a standalone `serve` with a real streaming completion aborted
at three different points:

| abort point | bytes streamed before abort | server survived? |
|---|---|---|
| before first chunk | 0 | yes |
| mid-stream | 96,118 | yes |
| later mid-stream | 201,342 | yes |

**A plain mid-stream client disconnect does not crash it.** So the trigger is
something narrower that I have not isolated. Reading the trace, the crash needs
*two* things to coincide: the controller already closed, **and** `runTurn`
subsequently rejecting so that `sink.error()` runs. A simple disconnect
apparently does not produce that pairing — possibly the turn completes through
`finish()` instead, which sets `closed` and makes `send()` return early.

Plausible remaining candidates, none verified: an upstream error arriving after
the client has gone; a mid-stream escalation aborting the first dispatch; a
failover path. Reproducing it probably needs fault injection at the upstream
rather than at the client.

### The latent defect is real regardless of trigger

Independent of what fires it, `http.ts:260` cannot do the job its comment claims:

```ts
// "this catch is the last line of defence so a rejected turn can never wedge the response"
return Promise.resolve(sink.error(toWireError(err))).catch(() => {});
```

`sink.error()` is synchronous. It is evaluated *before* `Promise.resolve` wraps
anything, so a synchronous throw from it propagates out of the `.catch()`
handler and escapes the chain entirely. Whatever causes `send()` to throw, this
line will not contain it — and a throw inside a `.catch()` handler becomes an
unhandled rejection, which is what ends the process.

Two small changes make the failure survivable without needing to know the
trigger:

```ts
// src/wire/openai/sink.ts — a dead stream is not an exceptional condition
const send = (bytes: Uint8Array): void => {
	if (closed) return;
	try {
		controller?.enqueue(bytes);
	} catch {
		closed = true;   // the runtime closed it under us; nothing left to write
	}
};
```

```ts
// src/server/http.ts — make the documented defence actually defend
try { sink.error(toWireError(err)); } catch { /* stream already gone */ }
```

A regression test can assert the weaker, verifiable property: after any turn
whose sink has been closed, the server still answers `/v1/models`.

## 8. Smaller observations

- **`explain` is excellent** and did most of the diagnostic work here. Worth
  advertising more prominently in the README — it answered in seconds what
  reading `candidates.ts` did not.
- **Ledger attribution is clean.** `reported_usd`, `tier`, `served_slug`,
  `escalation_signal` and `attempt` made per-task cost attribution trivial. The
  rowid high-water-mark trick works well for slicing a run.
- **`wasted` never co-occurs with a cost.** Every `wasted = 1` row in the
  production ledger has `reported_usd IS NULL`, so "wasted spend" is always
  $0.00. Retry spend (`attempt > 0`) is the meaningful waste figure — worth
  renaming or documenting, since the obvious reading of the column is wrong.
- **Compaction is worth little against a single-model baseline.** Replaying a
  week of real ledger traffic, adding back the 12.4M prompt tokens compaction
  removed changed the modelled Opus 5 bill by only ~$7 on $921 — on one model
  that context is cache reads at $0.50/MTok. Its value is in staying under the
  window and in surviving model switches, not in dollars.

---

## 9. Reproducing

```bash
cd E:/projects/auto-router-marketing

bun run bench/validate-ladder.ts                    # prove graders are passable
bun run bench/run-h2h.ts --suite ladder --dry       # prove graders bite
bun run bench/run-h2h.ts --suite ladder --tasks all --arms router,opus5 \
  --budget 20 --max-time 10m --out bench/runs/ladder-N
bun run bench/analyze-h2h.ts bench/runs/full-3 bench/runs/full-3b

# escalation experiment
bun run bench/run-h2h.ts --suite ladder --tasks L5-savepoints --arms router \
  --overlay bench/overlay-escalate.yml --budget 5 --out bench/runs/esc-N
```

Raw per-turn omp streams, per-cell results and each run's router config and
`serve.log` are retained under `bench/runs/*/`.
