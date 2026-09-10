# Data governance: redaction and ledger retention

Design notes for the two controls an operator with a compliance obligation
needs from the router — keeping strings out of every request, and saying how
long the record of a turn is kept. The README section
([Data governance](../README.md#data-governance)) is the operator's view; this
is where the decisions and their reasons live.

Both ship **off**. A router that has not been told otherwise does not touch a
prompt and does not delete a row.

---

## 1. Redaction

### Where it sits, and why there

```
wire in                       core                          wire out
─────────────────────────────────────────────────────────────────────────────
POST /v1/chat/completions ─┐
POST /v1/responses ────────┼─► parseChatRequest ─► route ─► renderUpstreamBody
POST /v1/messages ─────────┘        (NormRequest)                    │
                                                                     ▼
                                                      ┌──── REDACTION ────┐
                                                      │ redactUpstreamBody│
                                                      └─────────┬─────────┘
                                                                ▼
                                                        upstream.dispatch
                                                 ┌──────────────┼──────────────┐
                                            OpenRouter       Ollama      named upstream
                                                                        (openai/anthropic/vllm)
```

`src/server/turn.ts` calls `redactUpstreamBody` between
`req.renderUpstreamBody(...)` and `upstream.dispatch({ body, ... })`. That is
the only choke point that covers everything, and it covers it by construction:

- **Every wire in** ends up in the same shape. The Responses wire
  (`responsesToChatBody`) and the Anthropic Messages wire (`messagesToChatBody`)
  both translate into the chat-completions body before `parseChatRequest` sees
  it, and `renderUpstreamBody` has exactly one implementation
  (`src/wire/openai/request.ts`).
- **Every provider out** renders its own protocol *from* that body —
  `src/upstream/openrouter.ts`, `ollama.ts`, `anthropic.ts`, `compat.ts`. A
  provider added later inherits the guard without being told about it.

Redacting the `NormRequest` instead would not work: `NormMessage.text` is a
lossy concatenation used only for classification, and nothing is ever
dispatched from it. Redacting inside each upstream client would work and would
be wrong — it is four places today and five tomorrow.

Ordering inside the turn also matters. Redaction runs *after* compaction edits,
the agentdox context block and the cache breakpoints have been applied, so the
injected project context is scanned too and a rewritten text part keeps its
`cache_control` marker.

### What is scanned

| Field | Scanned |
| --- | --- |
| `messages[].content` (string, and `type: "text"` parts) for every non-tool role | always |
| `messages[].content` for `role: "tool"` (tool results) | `scanTools` |
| `messages[].tool_calls[].function.arguments` | `scanTools` |
| tool names, tool-call ids, `tools[]` schemas, `model` | never |

Tool results and arguments are gated because they are most of a turn's prompt
bytes, so scanning them is most of the CPU — and, for an operator who cares
about a secret in a file the agent just read, most of the point. Names and ids
are never touched because rewriting one breaks the call/result pairing the
model needs; a model slug is the router's own vocabulary, not conversation
content.

An `image_url` part is skipped: it carries a data URI that no redaction rule
can meaningfully read and that every rule would be slow over.

### The pattern guard

`src/config/redaction.ts`. A rule is configuration meeting text from a user,
which is the exact shape that backtracks — a pattern an operator wrote once,
run against megabytes of tool output on every turn of every conversation. A
redaction rule that hangs a request is worse than no rule at all, so the
pattern is compiled once at load and these are refused:

1. **A nested unbounded quantifier.** `(a+)+`, `(\d{2,})*`, `([a-z]*)+`. The
   number of ways to split one input across two unbounded quantifiers grows
   exponentially with its length, so a single non-matching tool result can pin
   a core for minutes. Detected by walking the source once, tracking group
   spans (honouring escapes and character classes) and checking the body of any
   group that carries `*`, `+` or `{n,}`. A **bounded** outer quantifier is
   fine, which is why `(?:\d{1,3}\.){3}\d{1,3}` — the shape real rules use —
   still loads.
2. **An alternation under an unbounded quantifier.** `(?:a|a)*`. The other
   textbook exponential shape. An alternation that is not under one is fine.
3. **A backreference** (`\1`, `\k<name>`). It takes the pattern outside the
   regular languages, so no bound on matching time exists for it at all.
4. **A pattern that matches the empty string.** It would replace at every
   position and turn the prompt into replacement text.
5. **A pattern over 512 characters, or a set over 64 rules.** A rule describes
   the shape of a secret; every real one is short and literal.
6. **A pattern that does not compile**, reported with the engine's message.

Compilation prefers the `u` flag: it rejects sloppy escapes and malformed
quantifiers at load rather than letting them silently mean something else, and
it makes matching operate on code points, so a rule cannot be defeated by an
astral character splitting a surrogate pair. A pattern that only `u` rejects
(an unescaped `{`, an octal escape) falls back to no flag — an operator's
working rule must not break on an upgrade — so `u` is a preference, not a
requirement.

Refusal happens in two places, deliberately. The config schema
(`configInputSchema`) rejects a file rule with the path and reason, so
`config.yml` fails at load; `startServer` compiles the rule set again before
the listener exists, which is where an embedder's programmatic overrides — they
never pass through the schema — are caught. Either way a bad rule is an error,
never a warning: a rule the operator believes is removing something must never
be a rule the router quietly skipped.

Compiled rules are memoised on the rules' own text (`redactionRulesFor`), not
on the config object's identity, because hot reload and `reconfigure` mutate
the live config **in place** — a reference check would miss an edit. So an
edited rule set compiles once more and an unedited one is a map lookup on the
turn path.

### The evidence

`LedgerEntry.redactions` → `ledger.redactions INTEGER`, schema **v19**, added
the way `scope` was at v18: a guarded `ALTER TABLE ... ADD COLUMN` on open plus
a `USER_VERSION` bump, so an old ledger opens and gains the column with its
rows NULL. Three states, all meaningful:

| Value | Means |
| --- | --- |
| `NULL` | redaction was off for this turn (or the row predates v19) |
| `0` | the rules ran and matched nothing |
| `n` | `n` strings were removed from this turn's request |

`buildUsageReport` totals it as `redactions` with `redactedTurns`
(`COUNT(redactions > 0)`) beside it, and the rendered report prints one line
when there is something to say. Nothing anywhere records the matched text: the
turn logs a debug line with a count, and the startup line lists rule *names*
only. A redaction log that quotes the secret is just a second copy of the
secret.

---

## 2. Ledger retention

### The window

`ledger.retentionDays: number | null`. `null` is the default and `0` means the
same thing: keep everything. Keeping is the default because deleting is the
direction that cannot be undone, and because how long a record of what people
asked a model lives is a decision an operator makes for their deployment, not
one a library default should make for them. (Before v0.21.0 the default was
365 days.)

### What goes

`createLedger(...).prune(retentionDays, nowMs)` deletes, in this order:

1. `feedback` rows — the user verdicts from `/router good|bad` — matched by
   *both* their own age and the ledger rows about to go
   (`ledger_id IN (SELECT id FROM ledger WHERE created_at_ms < ?)`), so
   verdicts orphaned by a prune from an older version are swept up too. First,
   because the subquery needs the rows that are about to be deleted.
2. `ollama_meter_samples` past the cutoff. They only calibrate the ledger's own
   Ollama estimate, so they age out with the rows they calibrate.
3. `ledger` rows past the cutoff.

Then, when anything was deleted, `PRAGMA incremental_vacuum` hands freed pages
back to the filesystem and `PRAGMA wal_checkpoint(TRUNCATE)` folds the WAL so
the space is real on disk. Both are best-effort inside a `try`: a ledger that
could not shrink is a far smaller problem than a prune that throws.
`openDb` sets `PRAGMA auto_vacuum = INCREMENTAL` before the journal mode, which
SQLite honours only for a **new** database — an existing ledger keeps its mode
and reuses freed pages instead of releasing them, which is the pre-v0.21.0
behaviour and is fine.

`PruneResult` is `{ deleted, oldestKeptMs }`. `oldestKeptMs` is
`MIN(created_at_ms)` over what remains (null when the ledger is empty) — the
honest answer to "how far back does this ledger go now", which is what the
question was actually about, and it is reported even when nothing was deleted.

### The schedule, and the route

`createRetentionRunner` (`src/cost/retention.ts`) owns the once-an-hour floor.
Three callers share it and none of them can bypass it:

- the server's one-minute housekeeping timer, which calls `maybeRun()`;
- a `setTimeout` five seconds after boot, so a lowered window applies without
  waiting out an hour (the first call is always due);
- `POST /v1/router/prune`, which calls `runNow()` — always doing the work,
  because the caller wants the counts, and marking the schedule satisfied for
  the next hour, because a prune that just ran is a prune that just ran.

The window is read through a function rather than captured, so a hot reload or
an embedder's `reconfigure` changes it without restarting anything.

The route exists for one reason: a front door of the team edition holds a
**read-only** handle on the ledger file by design and must never delete from
it. It asks the router, and gets back:

```json
{ "deleted": 12043, "oldestKeptMs": 1782720000000, "retentionDays": 365 }
```

It is guarded by `server.apiKey` like every other route, and it is safe to call
in a loop: the second call inside the hour still returns the counts, having
found nothing left to delete.
