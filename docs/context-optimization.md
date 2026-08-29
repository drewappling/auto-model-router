# Context optimization (compaction)

Status: **design, not implemented.** Decisions locked 2026-08-28. Phase 1 is the
build target; Phase 2 is documented so the schema and pipeline reserve room for it.

## Goal

Before dispatching a turn to the chosen model, the router transforms the outgoing
message history to remove **stale, low-value bulk** — chiefly old tool output —
so that:

1. long agentic conversations keep **fitting the candidate pool** (a smaller
   prompt stops `candidates.ts` from rejecting narrower-window models with
   `context_too_small`, which today silently shrinks the pool as a conversation
   grows), and
2. per-turn **spend drops** on the 100k-token loops we actually observe (glm-5.3-flash
   routinely serves turns at 67k–105k prompt tokens; the bulk is re-sent every turn).

A smaller haystack is also a mild mitigation for the weak-model loop failure
(fewer tokens for a cheap model to lose the thread in), but that is a side effect,
not the objective.

## Non-goals

- Not a replacement for tier escalation on runaway loops (tracked separately).
- Not summarizing or dropping the user's actual current intent or recent turns.
- Not a lossy digest of the whole conversation (see Phase 2 for bounded, pinned
  summarization; rolling whole-history digests are explicitly rejected — a coding
  agent lives on exact tool state).

## Motivation (observed)

From the live ledger (post-restart window):

- Prompts of 67k–105k tokens are normal on deep loops; the dominant mass is tool
  results (file reads, `bash`/grep dumps) that the model already consumed turns ago.
- Loops reach tool-loop depth 200+ on cheap tiers, re-sending the full transcript
  each turn.
- `context_too_small` rejections remove otherwise-good models from long
  conversations, forcing escalation or pool exhaustion on model switches.

## Constraints and invariants (from the codebase)

These are hard; the design is shaped by them.

- **Single hook.** `renderUpstreamBody` (`src/wire/openai/request.ts`) owns the exact
  bytes sent upstream via `structuredClone(original)`. `NormMessage`
  (`src/wire/types.ts`) is explicitly a *lossy* view "never dispatched." Compaction
  therefore **decides** using `NormMessage` per-index metadata (`role`, `textBytes`,
  `images`, `toolCalls`, `toolCallId`, `toolName`) and **applies** edits to the raw
  original messages by index.
- **Tool-call pairing is load-bearing.** Every `role:"tool"` message must keep its
  matching `assistant` `tool_call` id, or OpenRouter rejects the request (400).
  Compaction may shrink a tool **result's content**, but must never remove a tool
  result without its call, nor an assistant tool_call without its result, nor
  reorder the pair.
- **Never touch:** system/developer messages (they carry the system prompt and the
  agentdox-injected block), the **protected tail** (newest user-authored run, or the
  trailing tool-result run of the current loop — the same window `features.ts`
  treats as fresh), and image parts (they are capability-relevant; see Edge cases).
  Note that `cache-control.ts` deliberately does **not** treat that tail as fresh:
  a conversation is append-only, so the tail is exactly what the *next* turn will
  read back out of the cache, and it gets a breakpoint (see Prompt cache below).
- **Determinism.** `auto-model-router explain` replays a past decision offline.
  Phase 1 is a pure function of `(messages, target budget, model window)` →
  replayable. Phase 2 breaks this unless the summary is **pinned and persisted**
  (see Phase 2), exactly as the agentdox bridge already does.
- **Prompt cache.** Editing early messages busts the OpenRouter prompt-cache prefix.
  The governing law is already stated for the agentdox bridge
  (`src/context/bridge.ts`): *the same bytes are re-injected verbatim and the cache
  survives; a refresh rides on a cache miss that was happening anyway.* Compaction
  obeys it in two ways: rules are **stable** (identical input → identical elision
  each turn) *and* the truncation set is **monotone** (rule 3 below: oldest-first,
  so it only extends forward and never rewrites an already-cached prefix). Phase 2
  summaries are pinned per conversation and refreshed only when the cache is
  already cold.
- **Breakpoints must be reproducible.** A `cache_control` breakpoint only pays off
  when a later turn asks to read the exact same byte prefix, so
  `planCacheBreakpoints` places them where the next turn will place them again:
  the system prefix, byte **milestones** at fixed multiples of
  `cache.milestoneTokens` (default 20k) measured over *post-compaction* sizes, and
  the **tail**. A boundary at "roughly 75% of history" — the pre-v0.2.9 behaviour —
  drifts by one index per appended message, so every turn wrote a fresh cache entry
  and read none of them.

## Precedent to reuse

The agentdox bridge (`src/context/`) already manipulates context under exactly these
constraints: content-addressed blocks in `context_blocks`, a per-conversation
version in `conversations.context_version`, cache-cold-only refresh, and graceful
degradation to a no-op when unavailable. Phase 2 mirrors this machinery.

## Pipeline placement

Compaction follows the codebase's existing division of labour: **the core computes a
plan; the wire applies bytes.** `cacheBreakpointMessageIndices` and the agentdox
`contextBlock` are already computed during routing / in `turn.ts` and applied inside
`renderUpstreamBody`. Compaction is the same shape: a **`compactionPlan`** on the
`Decision` (which tool-result indices to shrink, and to what head/tail), computed
during routing, applied in `renderUpstreamBody`.

```
request → classify (on ORIGINAL turn)
       → compute compaction FLOOR (model-agnostic safe elision when over budget)
           recomputes compactedPromptTokens
       → candidate selection + forecast        ← use compactedPromptTokens
           context_too_small filter uses the FLOOR, so a narrow-window model is
           not rejected when safe compaction would make it fit
       → chosen model known → finalize compactionPlan (fit trigger may extend it)
       → renderUpstreamBody:
           clone → APPLY compactionPlan (shrink tool-result content)
                 → stripAssistantReasoning
                 → injectContextBlock (agentdox, appends to last system msg)
                 → apply cache_control at breakpoint indices
       → dispatch
```

- **Classification runs on the original turn.** Compacting old tool output must not
  change the tier: the human's intent and the loop/continuation structure are
  unchanged. `promptTokens` shrinks, but the tier scorer keys on the tail
  (`isToolResultContinuation`, `toolLoopDepth`, `newContentTokens`), so the effect
  is negligible and intentionally not fed back into scoring.
- **Selection and forecast use `compactedPromptTokens`** so spend predictions and the
  `context_too_small` filter reflect what is really sent — restoring narrower-window
  models that fit *after* safe compaction. A model rejected against the floor is
  genuinely too small (even max-safe compaction cannot fit it) and is correctly dropped.
- **Breakpoint indices are NOT recomputed for Phase 1.** They are computed in
  `select()` on the original array and adjusted by `injectContextBlock`. Because
  Phase 1 shrinks *content only* (never adds or removes a message), every index stays
  valid — the same reason `injectContextBlock` appends instead of inserts. Phase 2,
  which changes message count, MUST return adjusted indices (see Phase 2).

## Trigger (locked: fit + cost budget), and plan hysteresis

Two conditions arm compaction; they differ only in *whether* to bother:

- **Budget:** the **compacted** estimate — i.e. the prompt as it would be dispatched
  with the plan already carried from the previous turn — exceeds
  `compaction.budgetTokens`. The injected agentdox block counts toward the budget (it
  is resolved before render and bounded by `context.maxBlockChars`).
- **Fit:** the estimate exceeds `model.contextLength × filters.contextHeadroom` (minus
  expected completion) for a model under consideration — so the `context_too_small`
  filter tests each model against the compacted floor rather than the raw size.

Requests below `budgetTokens` and within every viable window are dispatched untouched —
the common small-prompt path allocates nothing.

### The plan is state, not a per-turn derivation

A prompt cache is a **byte-prefix** cache: change any byte and everything after it is
a miss. That makes the compaction plan cache-visible state, subject to two rules.

1. **A dispatched edit is permanent and verbatim.** `ConversationState.compactionPlan`
   persists the plan (schema v13, `conversations.compaction_plan`); `select()` re-emits
   it every turn and the planner is *seeded* with it (`planCompaction(..., carried)`),
   so an existing edit is never re-derived into a different shape and never dropped
   when the turn alone would not have triggered compaction. `validatePlan` first checks
   each edit still lands on a tool message of the recorded byte length, so a
   client-side history rewrite invalidates the edit instead of corrupting the prompt.
   Re-applying is safe because omp re-sends the original bytes every turn.
2. **Re-planning is rationed.** The trigger compares the **compacted** size against the
   budget, and when it fires the planner targets `budgetTokens × compaction.floorRatio`
   rather than stopping just under the budget. Comparing the *raw* size re-planned every
   single turn, so the plan gained one more edit per turn — a cache invalidation per turn
   for a marginal saving.

Measured (`tools/verify-plan-persist.ts`, 20-turn agentic conversation): `floorRatio`
1.0 changes the plan on **10 of 10** compacting turns, 0.75 on **3**, 0.6 on **2**. On
live ledger data (7 long conversations, 894 compacted dispatches) a changed-plan
dispatch ran **15.4% cold** vs **8.9%** when the plan held, and a cold prompt costs
**4.34x** a warm one per token ($0.1839 vs $0.0424 per Mtok). `floorRatio` ships at 1
(today's behaviour, elision is never implicit); 0.75 is the recommended setting.

## Interaction with the agentdox bridge

The router already has a shipped context subsystem (`src/context/`, see
`docs/AGENTDOX-BRIDGE.md`). Compaction must cooperate with it, not fight it.

- **Complementary regions.** agentdox *adds* a pinned project-context block to the
  system prefix (`injectContextBlock` appends to the last system message); compaction
  *shrinks* stale tool-result content in the history. Different regions — they compose.
- **Same cache law, one cold turn.** `bridge.ts shouldRefresh` fires on
  `pin === null || modelSwitching || retrying || staleness`. Phase 2's summary refresh
  MUST key off the same signals (already carried on `ContextResolveInput`) so the block
  refresh and the summary refresh land on the *same* cache miss — "the refresh rides a
  miss that was happening anyway," once, for both mutations.
- **Never touch the injected block.** It lives in a system message, which the safety
  boundary already excludes. Reaffirmed.
- **Budget includes the block.** See Trigger.
- **Apply order in `renderUpstreamBody`:** clone → apply `compactionPlan` → strip
  reasoning → `injectContextBlock` → cache_control. Phase 1 preserves message
  count/order, so `injectContextBlock`'s breakpoint bookkeeping is unaffected.
- **Write-back is orthogonal.** agentdox records user+assistant prose, not tool
  results, so compacting tool output does not degrade the recorded transcript. (The
  bridge's open write-back bug, AGENTDOX-BRIDGE §5, is unrelated.)
- **Phase 3 synergy (flag only, not committed):** agentdox durably stores project
  memory/history, so elided tool content could eventually be recoverable from project
  memory rather than solely by re-running the tool.

## Phase 1 — deterministic pruning (build target)

A pure function `compact(messages, target, protectFrom) → { messages, saved, notes }`.

### Safety boundary

- `protectRecentTurns` (default 4): the last N user/assistant turns and the entire
  volatile tail are never modified.
- System/developer messages are never modified.
- A message is never **removed**; only a tool **result's content** is shortened.
  Structure (roles, ordering, tool_call↔result ids) is invariant.

### Rules, applied cheapest-and-safest first, stopping once under `target`

1. **Collapse duplicates** (`collapseDuplicateResults`): byte-identical tool results
   for the same `toolName` → keep the first occurrence, replace later copies with a
   one-line breadcrumb.
2. **Elide superseded reads** (`elideSupersededReads`): when the same resource is
   fetched twice (same `toolName` + same primary argument, e.g. a `path`/`key`
   parsed from the tool_call args JSON — schema-agnostic heuristic), the **older**
   result's content is elided down to a breadcrumb pointing forward. The latest
   fetch is authoritative.
3. **Truncate large stale results** (`maxToolResultBytes`): remaining tool results
   outside the protected window whose content exceeds `maxToolResultBytes` are
   reduced to `keepHeadBytes` + breadcrumb + `keepTailBytes`. Applied **oldest
   first** until under `target` or exhausted.

   Oldest-first is a **prompt-cache requirement**, not an aesthetic. The selected
   set is then always an index-ordered prefix of the eligible results, so across
   turns it only ever extends forward: an existing edit keeps its index and keep
   bytes, and new edits land after every previous one — leaving the cached prefix
   byte-identical. Selecting largest-first instead inserts new edits at arbitrary
   early indices on later turns, rewriting history the upstream had already
   cached. Measured under largest-first: 61% cache read (bimodal 44%/90%, with
   `cachedTokens` pinned at the system prefix on half the requests) against
   76–82% on comparable pre-compaction sessions. `test/compaction.test.ts`
   ("the edit set only ever extends forward") pins the property.
4. **Age-drop assistant reasoning:** reasoning fields on assistant messages outside
   the protected window are dropped. (Largely redundant with the model-driven
   `stripAssistantReasoning`; matters only for reasoning-replay authors.)

### Recoverability contract (the single most important safety rule)

Elisions are **never silent**. Every elision leaves a self-describing, in-band
breadcrumb in the tool result content, e.g.:

```
[omp-router: elided 1180 of 1200 lines to save context. Re-run this tool to restore.]
<first keepHeadBytes…>
…
<last keepTailBytes…>
```

This converts a hard context loss into a **recoverable** one: if the model actually
needs the elided content, it re-issues the tool call and the fresh full result
returns (uncompacted, because it is now in the protected recent window). A rising
"re-fetch after elision" rate is the tuning signal that compaction is too
aggressive.

### Idempotence / stability

Because omp re-sends the full original history every turn, Phase 1 re-derives the
same elisions deterministically each turn → the dispatched prefix is byte-identical
turn-over-turn → the prompt cache survives without pinning.

## Observability

- `decision.reasons` gains a line, e.g.
  `compaction: 6 tool results elided, ~38k tokens saved (prompt 104k→66k)`, surfaced
  by `explain` and the toast extension.
- Ledger migration (mirrors the `v7`/`v8` additive pattern in `src/util/sqlite.ts`):
  add `prompt_tokens_saved INTEGER` (and optionally `messages_elided INTEGER`) so
  savings, re-fetch rate, and any upstream 400s can be measured and tuned.

## Configuration (proposed; off by default)

A new top-level `compaction` section (distinct from `cache` and the agentdox
`context`). Off by default — like every behavior-changing feature here, it is never
implicit.

```yaml
compaction:
  enabled: false
  # Trigger
  budgetTokens: 40000        # Stage 1: compact when estimated prompt exceeds this
  fitToWindow: true          # Stage 2: also compact to fit chosen model window×headroom
  # Safety boundary
  protectRecentTurns: 4      # never touch the last N user/assistant turns or the tail
  # Rules
  maxToolResultBytes: 4096   # stale tool results larger than this are truncated
  keepHeadBytes: 512
  keepTailBytes: 512
  elideSupersededReads: true
  collapseDuplicateResults: true
  # Phase 2 (documented, not built)
  summarize:
    enabled: false
    model: ""                # cheap summarizer slug; empty ⇒ Phase 1 only
    triggerTokens: 80000     # only after Phase-1 rules, still above this
    maxSummaryTokens: 2000
```

Schema lands in `src/config/schema.ts` (a `z.strictObject`, all fields optional),
types in `src/config/types.ts`, defaults in `src/config/defaults.ts`, and — per the
existing pattern — a small set of fields in the config wizard (`src/cli/config-wizard.ts`).

## Testing strategy

Unit (`test/compaction.test.ts`):
- tool_call↔result pairing preserved after every rule;
- breadcrumb present and content non-empty after truncation;
- deterministic + idempotent (compact(compact(x)) == compact(x) for stable input);
- `target` respected (result ≤ budget when achievable) and never over-shrinks the
  protected window;
- superseded-read detection matches same-resource, spares different resources;
- images/multimodal parts are never elided.

Integration (extend `test/select.test.ts` / a new fixture):
- a 100k-token fixture compacts under `budgetTokens`;
- a narrow-window model that was `context_too_small` becomes eligible after Stage 1;
- `explain` replays byte-identical dispatched messages for the same input.

## Rollout

1. Ship Phase 1 off by default.
2. Enable **budget-only** first (`fitToWindow: false`) on the live install; watch
   `prompt_tokens_saved`, re-fetch rate, upstream 400s (pairing regressions), and
   loop/abort rates.
3. Enable `fitToWindow` once pairing is proven clean.
4. Reassess Phase 2 only if prose-heavy history (not tool output) is still the
   dominant residual cost after Phase 1.

### Testing & deployment gotchas (from AGENTDOX-BRIDGE §3–4, §6)

Verifying compaction *through omp* hits the same traps that cost hours on the bridge:

- **Headless omp does not bind its own router.** `omp -p` reads
  `$AUTO_MODEL_ROUTER_HOME/embed.port` and routes to whatever router already holds
  that port — possibly stale code. To test *this* build, point `embed.port` at your
  standalone `serve` and restore it after.
- **Windows port-kill:** `pkill -f "src/index.ts serve"` does not work in Git Bash;
  free the port via `Get-NetTCPConnection -LocalPort <p> -State Listen` →
  `Stop-Process -Force`.
- **Multiple installed copies exist** (repo, marketplace cache, global npm). This is
  the same reason the deep-loop scorer fix "never landed" live. Before trusting any
  compaction e2e result, confirm which router process is actually serving.
- Use `AUTO_MODEL_ROUTER_DB=<scratch>.db` so tests never touch the live ledger.

## Phase 2 — pinned, persisted LLM summarization (documented, not built)

Phase 1 cannot safely compress genuinely-needed long **prose** (dense reasoning,
multi-turn design discussion). Phase 2 adds bounded summarization, gated behind
Phase 1 and behind the same cache/determinism discipline the agentdox bridge uses.

### Mechanism

- Runs only when, **after** Phase-1 rules, the estimate still exceeds
  `summarize.triggerTokens`.
- Summarizes the **oldest** compactable region (from just after the system/injected
  block up to the edge of the protected window) into a single bounded note
  (`maxSummaryTokens`), produced by `summarize.model` (a cheap slug).
- The note **replaces** that region's messages; tool_call↔result pairs inside the
  region are summarized as facts ("read src/foo.ts (480 lines); edited lines 12–20"),
  never left dangling.

### Determinism and cache — restored by pinning (the agentdox pattern)

- The summary is **content-addressed** (hash of the covered region) and **persisted**
  in a new `compaction_summaries` table, with the active version pinned on the
  conversation row (a `compaction_version` column, alongside `context_version`).
- Subsequent turns re-inject the **same** summary bytes verbatim → cache-stable and
  `explain`-replayable (replay reads the pinned summary from the store; it never
  re-summarizes).
- The summary is refreshed (recomputed to cover more history) **only when the cache
  is already cold**, reusing the *same* cold-turn signal as `bridge.ts shouldRefresh`
  (`pin === null || modelSwitching || retrying || staleness`) so the agentdox block
  refresh and the summary refresh share one cache miss rather than each causing their own.
- **Breakpoint indices are adjusted, not stale.** A summary that replaces a message
  range changes message count, so — exactly like `injectContextBlock` does when it
  prepends a system message — Phase 2 returns adjusted `cacheBreakpointMessageIndices`
  (shift the trailing indices by the count delta), or recomputes them on the collapsed
  array. This is the one place Phase-1's "indices stay valid" guarantee does not hold.

### Degradation

Summarization is enrichment, not a dependency: if the summarizer errors, times out,
or is unconfigured, the turn falls back to Phase-1 output and dispatches normally —
mirroring the agentdox bridge's "degrade to null, never throw" contract.

### Risks and mitigations

- **A bad pinned summary persists** and poisons later turns → versioned + hashed so it
  can be invalidated; never covers the protected recent window or tool structure;
  Phase-1 breadcrumbs remain, so the model can still re-fetch elided specifics.
- **Detail loss induces re-derivation loops** → summaries state actions and outcomes,
  never replace the *latest* authoritative tool results; recent window is untouched.
- **Added latency/cost** on the compute turn → amortized by pinning + cache-cold-only
  refresh.

## Open questions

- Primary-argument extraction for superseded-read detection across arbitrary tool
  schemas (heuristic: first string arg that looks like a path/id; configurable
  per-tool later if needed).
- Token-estimate accuracy at the budget boundary (uses `estimateTokens` +
  `token_calibration`; acceptable — the budget is a soft threshold, not a hard limit).
- Protocol coverage: OpenAI wire (`src/wire/openai/`) first; other protocols reuse the
  same `compact()` core behind their own `renderUpstreamBody`.
- Interaction with `forcedToolChoice` turns (rare; compaction of history is still
  safe, but verify the forced call is in the protected window).
```
