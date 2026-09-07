# auto-model-router — project memory & conventions

`auto-model-router` is a local, cost/complexity-aware model router for [Oh My Pi](https://github.com/oh-my-pi).
It presents one keyless OpenAI-compatible provider and picks a concrete OpenRouter model
**per turn**. This file is loaded by coding agents (Claude Code, Cursor) as project memory.

> **Repo identity:** this directory (`E:/projects/omp-router`) is the **main** repo.
> `E:/projects/auto-model-router-research` is a *separate divergent checkout* kept for other
> feature work — do not edit it expecting changes here. omp's `~/.omp/agent/config.yml`
> `extensions:` list points at **this** repo.

## agentdox — shared context/memory (**MANDATORY to keep updated**)

agentdox is this repo's memory + docs + live-conversation store. The project slug is
**`omp-router`** — ALWAYS scope agentdox writes to it. The bearer token (`AGENTDOX_TOKEN`)
is one global PAT that grants every scope, so a wrong slug is **not** rejected: it silently
files this project's data under another project. Getting `omp-router` right is on you.

**Full protocol: `.claude/skills/agentdox/SKILL.md`** (on connect, before asking the user,
batching writes to the end of the session, the REST fallback with request shapes, search
tips). Read it before using agentdox; do not improvise from this summary.

| What | Where |
| --- | --- |
| Token, URL, scope | `.env.agentdox` in this repo root (gitignored — never commit) |
| What `.mcp.json` reads | the `AGENTDOX_TOKEN` **environment variable** (Windows *User* scope; shells opened before it was set lack it) |
| Server | `http://localhost:3003` — Docker container `agentdox-server`; endpoints in `E:/projects/agentdox/packages/server/src/index.ts` |
| Admin token (re-mint) | `E:/projects/agentdox/deploy/.env` |

Two rules that cause silent mistakes: **memory calls take `category`, everything else takes
`scope`** (both always `"omp-router"`); and a **401 means the env var is missing** from the
launching shell — re-set it from `.env.agentdox` and restart the harness. omp mounts the
tools prefixed (`agentdox_memory_add`, …); a harness without them MUST use REST (the skill
has the map) rather than skip recording. Cleanest REST call path is a throwaway `bun`
script reading the token from `.env.agentdox`.

## This repo also *implements* an agentdox client

Beyond consuming agentdox as an agent, `src/context/` is the **router↔agentdox bridge**: it
injects shared project context into every routed turn and records turns back, attributed to
the model that served them. See `docs/AGENTDOX-BRIDGE.md` for the current state, how to run
it, and the open issue. Design rationale is the **decision log in the agentdox project brief**
for scope `omp-router` (read it with `context_brief`) — the bridge decisions and the evidence
behind them are recorded there as they are made.

Turning the bridge on for the router itself (distinct from the MCP wiring above):

```bash
export AGENTDOX_URL=http://localhost:3003
export AGENTDOX_TOKEN=<the global PAT, same value .mcp.json uses>
export AGENTDOX_SCOPE=omp-router
```

A URL + token is enough to enable it; `GET /health` on the router confirms.

## Conventions

- **Bun + TypeScript**, `exactOptionalPropertyTypes: true`. Use `...(x === undefined ? {} : { x })`
  rather than assigning `undefined` to an optional property.
- **`src/util/sqlite.ts` is the ONLY migration path.** New tables go in the idempotent
  `MIGRATIONS` block; column additions get a `MIGRATE_Vn` const plus a `PRAGMA table_info`
  guard, and `USER_VERSION` is bumped. `test/trust-attribution.test.ts` asserts the version.
- **bun:sqlite named params must be written `$name`** in the bind object. Bare keys bind
  nothing and every column silently lands NULL.
- Verify with `bun run typecheck` (covers src, test, omp-extension, tools — the extension and tools dirs were UNCHECKED until tsconfig.all.json, which is how two port bugs shipped) and `bun test` (483 tests) before declaring done.
