---
name: agentdox
description: "Use agentdox — the shared memory, docs, and context server — the same way every session. Trigger on connect in any repo — the scope comes from .env.agentdox, CLAUDE.md, or the repo folder name, and you create it if it has never been set — and whenever the user mentions agentdox, project memory, remembering/recalling facts, project docs, the project brief, decisions, or session history. Also trigger BEFORE asking the user something they may have already told you, and BEFORE finishing any task that changed architecture, conventions, or decisions."
---

# agentdox — the standard interaction protocol

agentdox is a shared memory + docs + conversation store at `http://localhost:3003`. It is what
stops you rediscovering the same project facts every session.

**Follow this protocol identically every time.** Consistency is the point: the value of the
store collapses if each session writes it differently.

## 0. Resolve the scope before anything else

Everything is namespaced by a **scope** = the project slug, and **the scope is derived from the
project folder you are working in — never from your credential.** Resolve it in this order and
stop at the first hit:

1. `AGENTDOX_SCOPE` in the repo's `.env.agentdox`
2. The slug named in the repo's `CLAUDE.md`
3. `project_list` — an existing project whose slug matches the repo folder name
4. **Nothing yet → derive it from the folder name and create it** (below). Don't ask first;
   a folder with no scope is just a project that hasn't been onboarded, and the global token
   already covers it.

Known scopes: `ashlands` (E:/projects/ashlands/ashlands), `omp-router` (E:/projects/omp-router).

### Creating the scope for a folder that has never had one

Deterministic, so the same folder always resolves to the same slug:

1. Take the **repo root** folder name — `git rev-parse --show-toplevel`, not the cwd. A
   subdirectory must never become its own project.
2. Slugify it: lowercase, every run of non-alphanumerics → a single `-`, trim leading/trailing
   `-`. `E:/projects/My_App` → `my-app`.
3. `project_list` **before creating.**
   - **Exact match** — usually this repo, already onboarded elsewhere; adopt it. But an exact
     match reached from a folder that has never been onboarded can also be a *collision*: two
     unrelated repos with the same folder name (`E:/projects/foo/api` and `E:/work/api`) both
     slugify to `api`, and adopting blindly merges two projects into one namespace. Check the
     existing project's brief/description first; if it clearly describes a different codebase,
     stop and ask for a distinguishing slug.
   - **Near match** (`my-app` vs `my-app-v2`) — a stop sign: ask, rather than fork a second
     namespace for one project.
4. `project_ensure {slug}` — `name` is optional and only used if the project is new; it
   defaults to the slug, so pass one only when the readable form differs.
5. **Make `.env.agentdox` un-committable *before* writing it.** Run `git check-ignore -v
   .env.agentdox`. If it is not ignored, **add `.env.agentdox` to `.gitignore`** (create that
   file if there is none) — do not merely check and move on. Patterns like `.env` and
   `.env.*.local` do **not** match `.env.agentdox`; that exact gap existed in the agentdox repo
   itself. This file carries the global token, which is instance admin: committing it is the
   worst outcome available here.
6. **Persist the scope, or the next session redoes all of this.** Write `.env.agentdox` at the
   repo root:

   ```ini
   AGENTDOX_URL=http://localhost:3003
   AGENTDOX_SCOPE=<slug>
   AGENTDOX_TOKEN=<the global PAT>
   ```

   Take the token value from the `AGENTDOX_TOKEN` environment variable (`$env:AGENTDOX_TOKEN` on
   Windows), or copy it from another agentdox repo's `.env.agentdox`. If neither exists, this
   machine has no global PAT yet — stop and ask the user to mint one. Never invent a token.
7. Add the `.mcp.json` from §1 if the repo has none. **It does not take effect this session** —
   MCP config is read once, at harness startup. Finish *this* session over REST, and tell the
   user to restart the harness to get the MCP tools.
8. Copy the skill into the repo: `~/.claude/skills/agentdox/SKILL.md` →
   `.claude/skills/agentdox/SKILL.md`. Claude Code finds the user-level copy anyway, but omp and
   other harnesses only discover **project-relative** skills — without this, the protocol
   silently stops applying there.
9. Add an agentdox section to the repo's `CLAUDE.md` (create the file if absent). This is
   resolution step 2 above, and it is what makes the *next* agent, in any harness, follow the
   protocol:

   > ## agentdox — shared context/memory (**MANDATORY to keep updated**)
   >
   > agentdox is this repo's memory + docs + live-conversation system. The project slug is
   > **`<slug>`** — ALWAYS scope agentdox writes to it. `.mcp.json` uses **`AGENTDOX_TOKEN`**,
   > one global bearer token shared by every agentdox-wired repo; the scope comes from *this
   > folder* (`AGENTDOX_SCOPE` in `.env.agentdox`, gitignored), not from the token. That token
   > grants every scope, so a wrong slug is **not** rejected — it silently writes into another
   > project.
   >
   > Keeping agentdox current is part of completing a task, not optional. Full protocol:
   > `.claude/skills/agentdox/SKILL.md`.
10. Give the brief an overview. `context_brief_seed {scope}` builds one **from existing memory
    and docs**, so on a scope you just created it returns 200 and an *empty* brief — there is
    nothing to seed from yet. Write it directly instead:
    `PUT /context/brief {scope, overview, repoLayout?, buildTest?, gotchas?}`. Seed later, once
    the scope has material.
11. **Verify before you claim it works:** write one memory in the new scope and read it back
    (`memory_add` → `memory_search`, or `POST /memory` → `GET /memory?category=<slug>`). A 401
    here means `AGENTDOX_TOKEN` is missing from the environment, not that onboarding failed.

Then tell the user, briefly: the scope you created, the files you added, and that the MCP tools
need a harness restart. Don't make them discover that a new project appeared.

**Never write outside your scope.** The bearer token is global (see §1) and grants *every*
scope, so a wrong slug will **not** be rejected — it will silently succeed and file this
project's data under another project's namespace. Nothing catches that but you. If you cannot
determine the scope, ask — do not guess, and do not fall back to a default.

## 1. Pick your transport — MCP or REST

Both hit the same live store with the same RBAC. **Check which you have, then use it:**

- **MCP tools present** — use them. Claude Code and Cursor mount them as `memory_add`,
  `context_assemble`, …; **omp mounts them prefixed**, e.g. `agentdox_memory_add`,
  `agentdox_context_assemble`. omp reads `.mcp.json` (repo root), `.omp/mcp.json`,
  `.claude/mcp.json`, and `~/.omp/agent/mcp.json`, and it **does** expand `${VAR}` in headers.
- **No such tools** — **use the REST API directly.** Never skip recording just because MCP
  tools are absent; that is the most likely way this protocol silently stops happening.

If you expected MCP tools and don't have them, the usual cause is `AGENTDOX_TOKEN` missing
from the **launching shell's** environment. A Windows *User*-scope variable only reaches
processes started after it was set, so an already-running terminal won't have it. Either
restart the shell/harness or fall back to REST for this session — don't just skip the writes.

REST auth: `Authorization: Bearer <token>`, where the token is `AGENTDOX_TOKEN` — **one
global PAT shared by every repo** (non-expiring, wildcard grants), held in the Windows User
environment and mirrored into each repo's `.env.agentdox`. It is deliberately *not*
project-scoped: a new project folder needs no new token, only its own `AGENTDOX_SCOPE`.

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
| Ensure the project | `project_ensure {slug}` | `POST /projects {slug}` (idempotent) |
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
| Find the *part* of a doc that answers something | `docs_passages` | `GET /docs/passages?q=…&scope=<scope>` |
| A decision you made | `context_brief_record {scope, title, decision, rationale}` | `POST /context/brief/decision {scope, title, decision, rationale}` |
| Edit brief sections | — | `PUT /context/brief {scope, overview?, repoLayout?, codeStyle?, buildTest?, assetConventions?, gotchas?}` |

**Search before you add.** Update the existing entry rather than leaving two contradictory
facts. Record the *why* of a decision, not just the *what*.

## Searching well

Retrieval is hybrid — keyword *and* meaning — so you do not have to guess the stored wording.
Ask in your own words; exact identifiers (`SettlementLayout.Build`, `AGENTDOX_TOKEN`) work too.

**Prefer `docs_passages` over `docs_search`** when you want the part of a doc that answers a
question. `docs_search` hands back whole documents, which then get truncated — and the
truncation is rarely the relevant part. A passage arrives with its slug and heading, so
`docs_read` the full doc when the passage is not enough.

If results look thin or stale, check `index_stats {scope}` before concluding the store is
empty: it reports how much of the scope is indexed and whether the embedding provider is
reachable. `embedded` far below `total`, or an unreachable provider, means you are getting
keyword-only results. `index_rebuild` fixes an index that has drifted; ordinary writes index
themselves, so you should rarely need it.

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

- **401** → `AGENTDOX_TOKEN` is missing from the launching shell's environment. Re-set it from
  the repo's `.env.agentdox` and restart the harness (`${VAR}` substitution happens once, at
  MCP-server startup).
- **403** → should not happen with the global token. If it does, that token was revoked or
  replaced by a scoped one — check `.env.agentdox` against agentdox's `/auth/tokens` list.
- **Connection refused** → the `agentdox-server` Docker container is not running.

Report the failure rather than proceeding as if the store were up to date.

---

*Canonical copy: `~/.claude/skills/agentdox/SKILL.md`. omp only discovers skills from
**project-relative** dirs (`.claude/skills/`, `.omp/skills`, `.agent/skills`, …), so this file
is copied into each participating repo. Edit the canonical copy, then re-copy.*

*A short pointer also lives in `~/.omp/agent/AGENTS.md` — omp's global instruction file, loaded
in every session in every directory (empirically the only user-level path omp reads: `~/.agent`,
`~/.agents`, `~/.codex`, `~/.config/opencode`, `~/.omp`, and `~/AGENTS.md` were all ignored).
Keep it a **pointer**: the protocol lives here, and that file is charged to the context window of
every omp session, including ones with nothing to do with agentdox.*
