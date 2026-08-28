---
name: agentdox
description: "Use agentdox — the shared memory, docs, and context server — the same way every session. Trigger on connect in any repo whose CLAUDE.md or .env.agentdox names an agentdox scope, and whenever the user mentions agentdox, project memory, remembering/recalling facts, project docs, the project brief, decisions, or session history. Also trigger BEFORE asking the user something they may have already told you, and BEFORE finishing any task that changed architecture, conventions, or decisions."
---

# agentdox — the standard interaction protocol

agentdox is a shared memory + docs + conversation store at `http://localhost:3003`. It is what
stops you rediscovering the same project facts every session.

**Follow this protocol identically every time.** Consistency is the point: the value of the
store collapses if each session writes it differently.

## 0. Resolve the scope before anything else

Everything is namespaced by a **scope** = the project slug. Get it, in this order:

1. `AGENTDOX_SCOPE` in the repo's `.env.agentdox`
2. The slug named in the repo's `CLAUDE.md`
3. List projects and match the repo name

Known scopes: `ashlands` (E:/projects/ashlands/ashlands), `omp-router` (E:/projects/omp-router).

**Never write outside your scope.** If you cannot determine it, ask — do not guess, and do not
fall back to a default.

## 1. Pick your transport — MCP or REST

Both hit the same live store with the same RBAC. **Check which you have, then use it:**

- **MCP tools present** — use them. Claude Code and Cursor mount them as `memory_add`,
  `context_assemble`, …; **omp mounts them prefixed**, e.g. `agentdox_memory_add`,
  `agentdox_context_assemble`. omp reads `.mcp.json` (repo root), `.omp/mcp.json`,
  `.claude/mcp.json`, and `~/.omp/agent/mcp.json`, and it **does** expand `${VAR}` in headers.
- **No such tools** — **use the REST API directly.** Never skip recording just because MCP
  tools are absent; that is the most likely way this protocol silently stops happening.

If you expected MCP tools and don't have them, the usual cause is the bearer env var missing
from the **launching shell's** environment. A Windows *User*-scope variable only reaches
processes started after it was set, so an already-running terminal won't have it. Either
restart the shell/harness or fall back to REST for this session — don't just skip the writes.

REST auth: `Authorization: Bearer <token>`, where the token is `AGENTDOX_TOKEN` from the
repo's `.env.agentdox`.

Cleanest REST call path — a throwaway `bun` script, which avoids PowerShell mangling `$` in
inline JSON and avoids quoting pain in `curl`:

```ts
const tok = /AGENTDOX_TOKEN=(.+)/.exec(await Bun.file(".env.agentdox").text())?.[1]?.trim() ?? "";
const H = { Authorization: `Bearer ${tok}`, "content-type": "application/json" };
await fetch("http://localhost:3003/memory", { method: "POST", headers: H,
  body: JSON.stringify({ content: "…", category: "<scope>", importance: 0.9 }) });
```

## 2. On connect (every session, before other work)

| Step | MCP | REST |
| --- | --- | --- |
| Ensure the project | `project_ensure {slug, name}` | `POST /projects {slug,name}` (idempotent) |
| Read the brief | `context_brief {scope}` | `GET /context/brief?scope=<scope>` |

The brief is the cumulative on-ramp: overview, repo layout, code style, build/test,
conventions, gotchas, decision log. **Read it before exploring the repo** — it exists so you
don't rediscover what a previous session already established.

`404 no_brief` means none exists yet: seed it once with `context_brief_seed {scope}` /
`POST /context/brief/seed {scope}`.

## 3. Before asking the user anything

| MCP | REST |
| --- | --- |
| `context_assemble {scope, query}` | `POST /context/assemble {scope, query}` |

Returns relevant memory + docs + recent conversation as one block. **Consult it before
re-asking the user about anything that might already be recorded.** Re-asking a question the
store already answers is the specific failure this system exists to prevent.

## 4. During work — append the session in real time

| MCP | REST |
| --- | --- |
| `session_start {scope, title}` | `POST /sessions {scope, title}` → returns `id` |
| `session_append {session_id, role, content}` | `POST /sessions/:id/messages {role, content, refs?}` |
| — | `POST /sessions/:id/end` when the topic closes |

Append **as the conversation happens**, not as one summary at the end. Live history is what
context assembly draws on for the next session.

## 5. Before finishing any task (mandatory)

Updating agentdox is part of completing a task, not an optional extra. Do not close out a task
while memory, docs, or the brief for the area you touched is stale.

| What changed | MCP | REST |
| --- | --- | --- |
| A fact you already stored | `memory_update {id, …}` | `PATCH /memory/:id {content?, importance?}` |
| A new durable fact | `memory_add {content, category, importance}` | `POST /memory {content, category, importance}` |
| Find what exists first | `memory_search {query, category}` | `GET /memory/search?q=…&category=<scope>` · `GET /memory?category=<scope>` |
| Architecture / conventions | `docs_update {id, content}` | `PATCH /docs/:id {title?, content?, tags?}` |
| A genuinely new doc | `docs_write {slug, title, content, scope}` | `POST /docs {slug, title, content, scope}` |
| List / read docs | `docs_read` · `docs_search` | `GET /docs?scope=<scope>` · `GET /docs/search?q=…` · `GET /docs/slug/:slug` |
| A decision you made | `context_brief_record {scope, title, decision, rationale}` | `POST /context/brief/decision {scope, title, decision, rationale}` |
| Edit brief sections | — | `PUT /context/brief {scope, overview?, repoLayout?, codeStyle?, buildTest?, assetConventions?, gotchas?}` |

**Search before you add.** Update the existing entry rather than leaving two contradictory
facts. Record the *why* of a decision, not just the *what*.

## Two inconsistencies that cause silent mistakes

1. **Memory uses `category`; everything else uses `scope`.** `memory_add` / `memory_search` /
   `memory_update` (and `POST /memory`, `GET /memory`) take `category`. Passing `scope` to a
   memory call leaves the entry unscoped, where nothing will ever find it again. `category`
   **is** the scope — set it every time.
2. **`session_append` uses `session_id`** (snake_case), and `context_assemble` uses
   `memory_limit` / `docs_limit` / `session_limit`. Everything else uses plain names.

## Writing good entries

- **Memory is high-signal and compact.** One fact per entry. Prefer editing an existing entry
  over piling on near-duplicates. Set `importance` deliberately: 0.9+ for things that change
  how work is done, 0.5 for ordinary context.
- **Do not store what the repo already records.** Code structure, file listings, and git
  history are discoverable. Store what is *not* in the code: why a decision was made, a user
  preference, a constraint, a gotcha that cost time.
- **Docs are versioned** (`GET /docs/:id/history`), so update freely rather than hedging.

## When agentdox fails

- **401** → the bearer token env var referenced by `.mcp.json` is missing from the
  environment. Re-set it from the repo's `.env.agentdox` and restart the harness (`${VAR}`
  substitution happens once, at MCP-server startup).
- **403** → you are writing outside your granted scope. Re-check the slug.
- **Connection refused** → the `agentdox-server` Docker container is not running.

Report the failure rather than proceeding as if the store were up to date.

---

*Canonical copy: `~/.claude/skills/agentdox/SKILL.md`. omp only discovers skills from
**project-relative** dirs (`.claude/skills/`, `.omp/skills`, `.agent/skills`, …), so this file
is copied into each participating repo. Edit the canonical copy, then re-copy.*
