# agentdox bridge — handoff

**Status:** implemented, typechecks clean, 438 tests pass, injection verified end-to-end
through omp. The write-back bug in §5 is **fixed**; `context.recordTurns` is safe to enable.

Design rationale (why it is built this way):
`E:/projects/agentdox/docs/architecture/router-context-bridge.md`.

---

## 1. What it does

The router is the only choke point that sees every model in every harness. The bridge
injects an agentdox project-context block into every routed turn, so switching models never
loses project memory/docs/brief — and records each settled turn back to agentdox, attributed
to the model that served it.

The load-bearing constraint is the prompt cache: a block that changes per turn sits at the
front of the prefix and would make every turn a full cache miss. So a block is **pinned per
conversation** and refreshed only when the prefix is already cold (first turn, model switch,
retry, or staleness TTL). Version is a **content hash**, not agentdox's `assembledAt`, so an
unchanged re-assembly keeps the same bytes and the cache survives.

## 2. Where the code is

| Path | Role |
| --- | --- |
| `src/context/types.ts` | Contracts (`ContextBridge`, `ContextPin`, `TurnRecord`) |
| `src/context/agentdox.ts` | REST client. Total: every method returns a value or null, never throws |
| `src/context/bridge.ts` | **The refresh policy.** `shouldRefresh` is the heart of it |
| `src/context/store.ts` | `context_blocks` (content-addressed) + `agentdox_sessions` |
| `src/context/index.ts` | `createBridgeFromConfig` — returns an inert bridge when unconfigured |
| `src/server/turn.ts` | Resolve → inject → pin → record. Two `log.debug("agentdox …")` lines |
| `src/wire/openai/request.ts` | `injectContextBlock` + `x-agentdox-scope` header parsing |
| `src/util/sqlite.ts` | `USER_VERSION` 11, `MIGRATE_V11` |
| `test/context-bridge.test.ts` | 14 tests: every refresh trigger, restart survival, degradation |
| `tools/agentdox-e2e.ts` | Live check against a running agentdox server |

Injection appends to the **last system message** rather than inserting one — inserting would
shift every `cacheBreakpointMessageIndices` entry the core computed, and appending lands the
block inside the prefix `planCacheBreakpoints` already marks.

## 3. Running it

```bash
export AGENTDOX_URL=http://localhost:3003
export AGENTDOX_TOKEN=<PAT with write on the scope>   # see .env.agentdox
export AGENTDOX_SCOPE=omp-router
bun src/index.ts serve --port 8799        # standalone
curl -s http://127.0.0.1:8799/health      # confirms the bridge block
bun tools/agentdox-e2e.ts                 # live end-to-end
```

`AUTO_MODEL_ROUTER_LOG=debug` surfaces two lines per turn:

```
DEBUG agentdox context active=true scope=omp-router injected=true chars=1683
DEBUG agentdox record turn userChars=109 assistantChars=4 messages=2 roles=system,user
```

Use `AUTO_MODEL_ROUTER_DB=<scratch>.db` to avoid touching the live `~/.auto-model-router/router.db`.

## 4. Testing through omp — the gotcha that cost an hour

`omp -p` (headless) **never binds its own router**. Per `omp-extension/router-embed.ts`, only
a session with `ctx.hasUI` binds; headless sessions read `$AUTO_MODEL_ROUTER_HOME/embed.port`
and register the provider against whatever port is in that file. So a headless run silently
routes to whatever router is already running — including a stale one with old code.

To test *your* build through omp:

```bash
cp ~/.auto-model-router/embed.port ~/.auto-model-router/embed.port.bak
printf '8799' > ~/.auto-model-router/embed.port     # point at your standalone router
AGENTDOX_URL=… AGENTDOX_TOKEN=… AGENTDOX_SCOPE=omp-router \
  omp -p --no-tools --no-session "…"
cp ~/.auto-model-router/embed.port.bak ~/.auto-model-router/embed.port   # restore
```

Two more traps hit during this work:

- `pkill -f "src/index.ts serve"` does **not** work in Git Bash on Windows. The old process
  keeps the port, the new one prints `Failed to start server. Is port 8799 in use?` to its
  log, and you spend a while testing stale code. Kill via
  `Get-NetTCPConnection -LocalPort 8799 -State Listen` → `Stop-Process -Force`.
- Long-running interactive omp sessions hold their own embedded routers from whenever they
  started. Check `Get-Process omp` before trusting a result.

## 5. FIXED — one record per dispatch, not per turn

**Symptom:** through omp the recorded assistant turn was near-empty —
`assistantChars=4` (literally `" high"`) while omp displayed several paragraphs. Session and
model attribution (`refs: ["model:…", "tier:…"]`) were always correct; only the assistant
*content* was wrong.

**Root cause — none of the three leads originally listed here.** The text was not
under-captured; the *wrong requests* were being recorded. A user-visible turn is not one
upstream request, it is a whole tool loop of them. Live ledger proof, one conversation key,
`wasted=0` and `attempt=0` on every row:

| dispatch | `finish_reason` | `toolLoopDepth` | completion tokens |
| --- | --- | --- | --- |
| 1 | `tool_calls` | 0 | 339 |
| 2–6 | `tool_calls` | 2, 4, 6, 8, 10 | 91, 68, 198, 78, 44 |
| 7 | **`stop`** | 12 | **596** |
| 8 | `tool_calls` | 0 *(next turn)* | 167 |

Each tool round-trip is its own dispatch, finishing with `tool_calls` and emitting almost no
`text` — the payload is tool calls. `" high"` was a stray word of preamble, a *complete*
record of a fragment rather than a truncated answer. Only the final `stop` dispatch carries
the synthesis. `recordTurn` fired on all ~13, and the last writer won.

The same root cause explains the §6 pollution: `lastUserText` walks back to the last `user`
message, which does **not** move while a tool loop runs, so the identical user text was
appended once per round-trip too.

**Fix.** `TurnRecord` gained `turnEnded` (`finishReason !== "tool_calls"`, set in
`src/server/turn.ts`). The bridge buffers assistant fragments per conversation in a
process-local map and flushes **once**, when the assistant yields back to the user, writing
the loop's narration plus the closing synthesis as one message. Bounded by
`MAX_PENDING_CHARS` / `MAX_PENDING_CONVERSATIONS`, since a turn that dies without a terminal
dispatch never flushes. The terminal dispatch is appended past the char cap, so the model's
actual answer is never what gets dropped.

Covered by `test/context-bridge.test.ts` (loop records one turn; a running loop writes
nothing; interleaved conversations buffer independently) and `test/turn.test.ts` (the
`tool_calls` → `turnEnded=false` wiring). All four were verified to FAIL against the old
behavior. `tools/agentdox-e2e.ts` step 6 proves it against a live server: four dispatches →
exactly one user and one assistant message.

## 6. Also worth doing

- **Context pollution.** `context_assemble` includes recent session messages, so recorded
  test turns feed back into the next block (observed: a block containing `assistant:: high`
  from a prior run). The §5 fix removes the ~13×-per-turn duplication that made this acute,
  but noisy *test* turns still compound — `tools/agentdox-e2e.ts` writes real sessions into
  the scope every run. Consider a `sessionLimit` override for the bridge, or excluding
  router-authored sessions.
- **`context.timeoutMs` is 3000ms** and failures degrade silently at `debug` level by design.
  If agentdox is cold this can no-op invisibly. Consider logging the first failure at `warn`.
- **Four copies of this project exist** on this machine: this repo, the research checkout,
  `~/.omp/plugins/cache/marketplaces/auto-model-router` (v0.2.1, marketplace cache — not
  installed, `installed_plugins.json` is empty), and a global npm `auto-model-router@0.2.4`.
  Confirm which one a given run is exercising before trusting an e2e result.
