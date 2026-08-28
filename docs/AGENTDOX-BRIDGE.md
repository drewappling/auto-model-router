# agentdox bridge — handoff

**Status:** implemented, typechecks clean, 409 tests pass, injection verified end-to-end
through omp. **One open bug** in the write-back path (§5). Pick up there.

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

## 5. OPEN BUG — assistant text is under-captured on the omp path

**Verified working:** injection reaches the model through omp. The dispatched system message
was confirmed to contain the block (`containsBlock=true`), and on a direct
`/v1/chat/completions` dispatch the model answered *from* the injected memory, verbatim:

> "The router pins one agentdox context block per conversation, refreshing it only on model
> switches, retries, or TTL."

**Broken:** through omp, the recorded assistant turn is near-empty — `assistantChars=4`
(literally `" high"`) while omp displayed several paragraphs. The session and the model
attribution (`refs: ["model:…", "tier:…"]`) are written correctly; only the assistant
*content* is wrong.

`assistantText` is accumulated in `src/server/turn.ts` from `ev.type === "text"` deltas
inside the chunk loop. Leads, roughly in order of suspicion:

1. **omp issues more than one upstream request per visible turn** (e.g. a title/summary call
   on the `smol` role, which also resolves to `auto` → the router). The 4-char record may be
   an auxiliary request, with the real answer on a different conversation key. Check by
   logging `conversationKey` alongside the record line and counting turns per omp invocation.
2. **Content arrives as `reasoning` deltas, not `text`**, for reasoning-capable models — the
   accumulator deliberately ignores `reasoning`. If so, decide whether the transcript should
   capture reasoning (probably not) or whether `text` is arriving under a chunk shape the
   interpreter is not mapping to a `text` event.
3. **Escalation resets the buffer.** `assistantText` is declared per attempt; if a turn
   commits on a later attempt the earlier text is correctly dropped, but verify the committed
   attempt is the one being recorded.

Start by adding `conversationKey` and `attempt` to the `agentdox record turn` debug line and
running one omp invocation — that distinguishes lead 1 from the others immediately.

## 6. Also worth doing

- **Context pollution.** `context_assemble` includes recent session messages, so recorded
  test turns feed back into the next block (already observed: the block contained
  `assistant:: high` from a prior run). Real usage is fine, but noisy test turns compound.
  Consider a `sessionLimit` override for the bridge, or excluding router-authored sessions.
- **`context.timeoutMs` is 3000ms** and failures degrade silently at `debug` level by design.
  If agentdox is cold this can no-op invisibly. Consider logging the first failure at `warn`.
- **Four copies of this project exist** on this machine: this repo, the research checkout,
  `~/.omp/plugins/cache/marketplaces/auto-model-router` (v0.2.1, marketplace cache — not
  installed, `installed_plugins.json` is empty), and a global npm `auto-model-router@0.2.4`.
  Confirm which one a given run is exercising before trusting an e2e result.
