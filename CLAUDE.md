# auto-model-router — project memory & conventions

`auto-model-router` is a local, cost/complexity-aware model router for [Oh My Pi](https://github.com/oh-my-pi).
It presents one keyless OpenAI-compatible provider and picks a concrete OpenRouter model
**per turn**. This file is loaded by coding agents (Claude Code, Cursor) as project memory.

> **Repo identity:** this directory (`E:/projects/omp-router`) is the **main** repo.
> `E:/projects/auto-model-router-research` is a *separate divergent checkout* kept for other
> feature work — do not edit it expecting changes here. omp's `~/.omp/agent/config.yml`
> `extensions:` list points at **this** repo.

## agentdox — shared context/memory (**MANDATORY to keep updated**)

agentdox is this repo's memory + docs + live-conversation system. The project slug is
**`omp-router`** — ALWAYS scope agentdox writes to it. The HTTP MCP server in `.mcp.json`
uses **`AGENTDOX_TOKEN`**, one **global** bearer token shared by every agentdox-wired repo.
The scope comes from *this folder* (`AGENTDOX_SCOPE` in `.env.agentdox`), not from the token:
the token grants every scope, so a wrong slug is **not** rejected — it silently writes into
another project. Getting `omp-router` right is on you, not on RBAC.

**Where the credentials live:**

| What | Where |
| --- | --- |
| Token + URL + scope | `.env.agentdox` in this repo root (**gitignored** via `.env.*` — never commit) |
| What `.mcp.json` reads | the `AGENTDOX_TOKEN` **environment variable**, not the file |
| Persisted env value | Windows **User** environment (`[Environment]::GetEnvironmentVariable('AGENTDOX_TOKEN','User')`) |
| Server | `http://localhost:3003` — Docker container `agentdox-server` |
| Admin token (to re-mint the global PAT) | `E:/projects/agentdox/deploy/.env` |

`.env.agentdox` is the durable record; the environment variable is what Claude Code actually
substitutes into `.mcp.json` at MCP-server startup. If agentdox MCP returns **401**, the
variable is missing from the environment — re-set it from `.env.agentdox` and restart Claude
Code (substitution happens once, at startup). Re-mint instructions are in `.env.agentdox`.

**Requirement: keeping agentdox current is part of completing any task, not optional.**
Do NOT close out a task while memory, docs, or conversation history for the area you touched
is stale or incomplete.

Concrete duties (all scoped to `omp-router`):

- **On connect:** run `project_ensure` with `slug: "omp-router"` before any memory/docs work.
- **On startup:** read `context_brief` to onboard on decisions, conventions, and gotchas
  before rediscovering them.
- **Memory** (`memory_add` / `memory_update` / `memory_search`): record user-stated
  preferences and corrections. When a fact changes, UPDATE the existing entry — never leave
  contradictory facts. Keep entries compact and high-signal.
- **Docs** (`docs_write` / `docs_update`): keep architecture and decisions current as reality
  changes; writing once is not enough.
- **Sessions** (`session_start` / `session_append`): append messages in real time, not as an
  end-of-task summary.
- **Context** (`context_assemble`): consult it (with a query) before re-asking the user about
  anything already captured.
- **Decisions** (`context_brief_record`): record decisions and conventions as they are made.

### How to actually call it (MCP tools vs REST)

The duties above name the **MCP tools** (`memory_add`, `docs_write`, `context_brief_record`, …),
served from this repo's `.mcp.json`.

**omp gets these tools too** — verified 2026-08-28. omp reads `.mcp.json` (repo root),
`.omp/mcp.json`, `.claude/mcp.json`, and `~/.omp/agent/mcp.json`, and it expands `${VAR}` in
headers. It mounts them **prefixed**: `agentdox_memory_add`, `agentdox_context_assemble`, …
(fully qualified `mcp__agentdox_*`). All 17 tools load.

The one prerequisite is `AGENTDOX_TOKEN` being present in the **launching shell's**
environment. It is persisted at Windows *User* scope, so only shells started afterwards
inherit it — an already-open terminal will show no agentdox tools until restarted.

**A harness genuinely without those tools (e.g. Hermes, or omp before the env var is
inherited) MUST use the REST API directly** — same live store, same RBAC. Don't skip recording
just because the MCP tools are absent.

REST basics: base `http://localhost:3003`, header `Authorization: Bearer <token>` where the token
is `AGENTDOX_TOKEN` from `.env.agentdox` (global; grants every scope). **memory uses
`category`, everything else uses `scope`; both are always `"omp-router"`.** MCP-tool → REST map:

| Duty / MCP tool | REST |
| --- | --- |
| `project_ensure` | `POST /projects` `{slug,name}` (idempotent; re-ensure returns the project) |
| `memory_search` | `GET /memory?category=omp-router&limit=N` · `GET /memory/search?q=…&category=omp-router` |
| `memory_add` | `POST /memory` `{content, category:"omp-router", importance:0..1}` |
| `memory_update` | `PATCH /memory/:id` `{content?, importance?, …}` (edit in place — never pile on dupes) |
| `docs_write` | `POST /docs` `{slug, title, content, scope:"omp-router", tags?}` |
| `docs_update` | `PATCH /docs/:id` `{title?, content?, tags?}` · list `GET /docs?scope=omp-router` |
| read `context_brief` | `GET /context/brief?scope=omp-router` (404 `no_brief` until seeded) |
| seed the brief | `PUT /context/brief` `{scope, overview?, repoLayout?, codeStyle?, buildTest?, assetConventions?, gotchas?}` |
| `context_brief_record` | `POST /context/brief/decision` `{scope, title, decision, rationale}` |
| `context_assemble` | `POST /context/assemble` `{scope, query}` · baseline `GET /context/snapshot?scope=` · `POST /context/refresh` `{scope}` |
| `session_start` / `session_append` | `POST /sessions` `{scope, title}` → `POST /sessions/:id/messages` `{role, content, refs?}` → `POST /sessions/:id/end` |

Cleanest call path (avoids Windows PowerShell mangling `$` in inline JSON): a throwaway
`bun` script that reads the token and `fetch`es —

```ts
const tok = /AGENTDOX_TOKEN=(.+)/.exec(await Bun.file(".env.agentdox").text())?.[1]?.trim() ?? "";
const H = { Authorization: `Bearer ${tok}`, "content-type": "application/json" };
await fetch("http://localhost:3003/memory", { method: "POST", headers: H,
  body: JSON.stringify({ content: "…", category: "omp-router", importance: 0.9 }) });
```

Endpoints are defined in `E:/projects/agentdox/packages/server/src/index.ts`; the router's own
read/write client is `src/context/agentdox.ts` (assemble / createSession / append only).

## This repo also *implements* an agentdox client

Beyond consuming agentdox as an agent, `src/context/` is the **router↔agentdox bridge**: it
injects shared project context into every routed turn and records turns back, attributed to
the model that served them. See `docs/AGENTDOX-BRIDGE.md` for the current state, how to run
it, and the open issue. Design rationale lives in
`E:/projects/agentdox/docs/architecture/router-context-bridge.md`.

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
- Verify with `bunx tsc --noEmit` and `bun test` (406+ tests) before declaring done.
