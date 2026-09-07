"""Hermes standalone plugin: auto-model-router native features.

Companion to the ``model-providers/auto-model-router`` provider plugin (which
spawns the router and registers it as a provider). Hermes routes provider
plugins through its own discovery and never calls ``register(ctx)`` on them,
so the features that need the plugin API live here:

* **Session identity** — ``llm_request`` middleware adds the ``X-Omp-Session``,
  ``X-Omp-Harness`` and ``X-Omp-Subagent`` headers to every router request,
  so per-session reports, ``/router why``, feedback and the router's subagent
  profile work the way they do in omp. A session is a subagent when
  ``pre_llm_call`` reported a parent session for it.
* **Tool-result digest** — ``tool_execution`` middleware sends a large
  ``read_file`` / ``search_files`` / ``terminal`` result to the router's
  ``/v1/router/digest`` and hands the model the digest instead. The router
  decides (policy, session tier, cost guard); this plugin only ships text that
  passes the cheap client-side checks. Off unless ``digest.enabled`` is set in
  the router config.
* **``/router``** — report, summary, status, why, good, bad, pin, tier, as
  text, over the same HTTP endpoints omp's ``/router`` uses.

Install:

    mkdir -p "$HERMES_HOME/plugins"
    cp -r hermes-plugin/native "$HERMES_HOME/plugins/auto-model-router"
    hermes plugins enable auto-model-router

The router URL is ``http://127.0.0.1:$AUTO_MODEL_ROUTER_PORT`` (default 8788),
the port the provider plugin spawns on.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Dict, Optional

logger = logging.getLogger(__name__)

PORT = int(os.environ.get("AUTO_MODEL_ROUTER_PORT", "8788"))
BASE_URL = f"http://127.0.0.1:{PORT}"
# The harness id the router records on every row. Override to run several
# Hermes profiles against one router with separate budgets and reports.
HARNESS_ID = os.environ.get("OMP_HARNESS_ID", "hermes")
PROVIDER_NAME = "auto-model-router"
POLICY_TTL_S = 60.0
DIGEST_TIMEOUT_S = 30.0
# Hermes wraps every tool result in a JSON object; the digest replaces the
# largest string field (``content`` for read_file, ``output`` for terminal,
# the match text for search_files).
MIN_FIELD_SHARE = 0.8


# ---------------------------------------------------------------------------
# HTTP helpers (stdlib only; plugins should not add dependencies)
# ---------------------------------------------------------------------------


def _get(path: str, timeout: float = 5.0, text: bool = False) -> Any:
    req = urllib.request.Request(BASE_URL + path, headers={"Accept": "text/plain" if text else "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        return body if text else json.loads(body)


def _post(path: str, payload: Dict[str, Any], timeout: float = 5.0) -> Any:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE_URL + path, data=data, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            err = json.loads(exc.read().decode("utf-8"))
            message = (err.get("error") or {}).get("message") or str(exc)
        except Exception:
            message = str(exc)
        raise RuntimeError(message) from exc


# ---------------------------------------------------------------------------
# Session identity
# ---------------------------------------------------------------------------


class _Sessions:
    """Which sessions are subagents (they reported a parent session)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._parent: Dict[str, str] = {}

    def note(self, session_id: str, parent_session_id: str) -> None:
        if not session_id:
            return
        with self._lock:
            if parent_session_id:
                self._parent[session_id] = parent_session_id
            else:
                self._parent.pop(session_id, None)

    def is_subagent(self, session_id: str) -> bool:
        with self._lock:
            return bool(session_id) and session_id in self._parent


SESSIONS = _Sessions()
# The session the user is driving; ``/router`` acts on it.
_CURRENT = {"session_id": ""}


def on_pre_llm_call(session_id: str = "", parent_session_id: str = "", **_: Any) -> None:
    SESSIONS.note(session_id, parent_session_id)
    if not parent_session_id and session_id:
        _CURRENT["session_id"] = session_id
    return None


def identity_headers(session_id: str) -> Dict[str, str]:
    headers = {"X-Omp-Harness": HARNESS_ID}
    if session_id:
        headers["X-Omp-Session"] = session_id
    if SESSIONS.is_subagent(session_id):
        headers["X-Omp-Subagent"] = "1"
    return headers


def on_llm_request(request: Dict[str, Any] = None, provider: str = "", session_id: str = "", **_: Any) -> Optional[Dict[str, Any]]:
    """Attach the router's identity headers to requests bound for the router."""
    if request is None or provider != PROVIDER_NAME:
        return None
    updated = dict(request)
    extra = dict(updated.get("extra_headers") or {})
    extra.update(identity_headers(session_id))
    updated["extra_headers"] = extra
    return {"request": updated, "source": "auto-model-router", "reason": "session identity headers"}


# ---------------------------------------------------------------------------
# Tool-result digest
# ---------------------------------------------------------------------------


class _Policy:
    def __init__(self) -> None:
        self._at = 0.0
        self.value: Dict[str, Any] = {"enabled": False}

    def get(self) -> Dict[str, Any]:
        now = time.monotonic()
        if now - self._at >= POLICY_TTL_S:
            self._at = now
            try:
                p = _get("/v1/router/digest/policy", timeout=2.0)
                self.value = p if isinstance(p, dict) else {"enabled": False}
            except Exception:
                self.value = {"enabled": False}
        return self.value


POLICY = _Policy()


def canonical_tool(policy: Dict[str, Any], tool_name: str) -> str:
    lower = (tool_name or "").lower()
    aliases = policy.get("toolAliases") or {}
    return str(aliases.get(lower, lower)).lower()


def largest_string_field(result: Any) -> Optional[str]:
    """The key holding most of a JSON tool result's bytes, or None."""
    if not isinstance(result, dict):
        return None
    best, best_len, total = None, 0, 0
    for k, v in result.items():
        if isinstance(v, str):
            n = len(v.encode("utf-8"))
            total += n
            if n > best_len:
                best, best_len = k, n
    if best is None or total == 0 or best_len < total * MIN_FIELD_SHARE:
        return None
    return best


def should_send(policy: Dict[str, Any], tool_name: str, text: str) -> bool:
    if not policy.get("enabled"):
        return False
    tools = [str(t).lower() for t in (policy.get("tools") or [])]
    if canonical_tool(policy, tool_name) not in tools:
        return False
    n = len(text.encode("utf-8"))
    return int(policy.get("minBytes", 12000)) <= n <= int(policy.get("maxBytes", 400000))


def on_tool_execution(next_call: Callable[[Any], Any] = None, args: Any = None, tool_name: str = "", session_id: str = "", **_: Any) -> Any:
    """Run the tool, then replace a large result with the router's digest."""
    if next_call is None:
        return None
    result = next_call(args)
    try:
        return maybe_digest(result, tool_name, args if isinstance(args, dict) else {}, session_id)
    except Exception as exc:  # never lose a tool result to the digest path
        logger.debug("auto-model-router digest skipped: %s", exc)
        return result


def maybe_digest(result: Any, tool_name: str, args: Dict[str, Any], session_id: str, post: Callable[..., Any] = None) -> Any:
    post = post or _post
    policy = POLICY.get()
    if not policy.get("enabled") or not isinstance(result, str):
        return result
    try:
        parsed = json.loads(result)
    except Exception:
        return result
    if isinstance(parsed, dict) and parsed.get("error"):
        return result
    field = largest_string_field(parsed)
    text = parsed.get(field) if field else (parsed if isinstance(parsed, str) else None)
    if not isinstance(text, str) or not should_send(policy, tool_name, text):
        return result
    r = post(
        "/v1/router/digest",
        {"ompSessionId": session_id, "harnessId": HARNESS_ID, "toolName": tool_name, "input": args, "content": text, "query": ""},
        timeout=DIGEST_TIMEOUT_S,
    )
    if not isinstance(r, dict) or not r.get("digested") or not isinstance(r.get("text"), str):
        return result
    if field is None:
        return r["text"]
    parsed[field] = r["text"]
    return json.dumps(parsed, ensure_ascii=False)


# ---------------------------------------------------------------------------
# /router command
# ---------------------------------------------------------------------------

USAGE = "usage: /router report [days] [--all] | summary [--all] | status | why | good [note] | bad [note] | pin <model|off> | tier <tier|off> [turns]"


def _status_text(h: Dict[str, Any]) -> str:
    lines = [f"auto-model-router at {BASE_URL}: {h.get('status', 'unknown')}"]
    lines.append(f"openrouter: key {'configured (' + str(h.get('apiKeySource', '?')) + ')' if h.get('apiKeyConfigured') else 'MISSING'}")
    c = h.get("catalog")
    lines.append(f"catalog: {c.get('models', 0)} models" if isinstance(c, dict) else "catalog: not fetched yet")
    o = h.get("ollama")
    if isinstance(o, dict):
        meter = o.get("meter") or {}
        usage = f" · {meter.get('plan', 'plan')} ${meter.get('usedUsd', 0):.2f} of ${meter.get('creditsUsd', '?')}" if meter else ""
        lines.append(f"ollama cloud: {o.get('models', 0)} models · {'available' if o.get('available') else 'COOLING DOWN'}{usage}")
    else:
        lines.append("ollama cloud: disabled")
    sf = h.get("softFailures") or {}
    spikes = sf.get("spikes") or []
    if spikes:
        lines.append(f"soft failures SPIKING ({len(spikes)}):")
        for s in spikes:
            lines.append(f"  {s.get('slug')}: {round(100 * s.get('recentRate', 0))}% of {s.get('recentDispatches', 0)} failed in the last hour (7d baseline {round(100 * s.get('baselineRate', 0))}%)")
    else:
        lines.append("soft failures: no model spiking in the last hour")
    return "\n".join(lines)


def _why_text(e: Dict[str, Any]) -> str:
    usage = e.get("usage") or {}
    pt, ct = usage.get("promptTokens", 0) or 0, usage.get("cachedTokens", 0) or 0
    cache = f"{round(100 * ct / pt)}%" if pt else "n/a"
    cost = e.get("reportedUsd")
    if cost is None:
        cost = e.get("predictedUsd") or 0
    lines = [
        f"last turn: {e.get('servedSlug') or e.get('slug')} [{e.get('tier')}] · {e.get('classificationSource')} (confidence {e.get('confidence')})",
        f"cost ${float(cost):.5f} · cache hit {cache} · latency {e.get('latencyMs')}ms",
    ]
    for r in e.get("reasons") or []:
        lines.append(f"  - {r}")
    return "\n".join(lines)


def _parse_window(args: list) -> tuple:
    days, scope = 7, HARNESS_ID
    for a in args:
        low = a.lower()
        if low in ("--all", "all"):
            scope = ""
        elif low.rstrip("d").isdigit():
            days = int(low.rstrip("d"))
    return days, scope


def router_command(raw_args: str = "", get: Callable[..., Any] = None, post: Callable[..., Any] = None) -> str:
    get, post = get or _get, post or _post
    parts = (raw_args or "").split()
    verb = parts[0].lower() if parts else ""
    rest = parts[1:]
    session = _CURRENT["session_id"]
    try:
        if verb == "report":
            days, scope = _parse_window(rest)
            q = f"?days={days}&format=text" + (f"&harness={scope}" if scope else "")
            return get(f"/v1/router/report{q}", text=True)
        if verb in ("summary", "daily"):
            _, scope = _parse_window(rest)
            q = "?format=text" + (f"&harness={scope}" if scope else "")
            return get(f"/v1/router/summary{q}", text=True)
        if verb in ("status", "health"):
            return _status_text(get("/health"))
        if verb in ("why", "explain"):
            body = get(f"/v1/router/decisions?limit=1&session={session}")
            entries = body.get("entries") or []
            return _why_text(entries[0]) if entries else "no routed turn in this session yet"
        if verb in ("good", "bad"):
            r = post("/v1/router/feedback", {"ompSessionId": session, "verdict": verb, "note": " ".join(rest)})
            return f"recorded {verb} for {r.get('slug')} [{r.get('tier')}]"
        if verb == "pin":
            if not rest:
                return USAGE
            r = post("/v1/router/override", {"ompSessionId": session, "slug": None if rest[0].lower() == "off" else rest[0]})
            o = r.get("override") or {}
            return f"pin: {o.get('slug') or 'cleared'}"
        if verb == "tier":
            if not rest:
                return USAGE
            turns = int(rest[1]) if len(rest) > 1 and rest[1].isdigit() else 10
            r = post("/v1/router/override", {"ompSessionId": session, "tier": None if rest[0].lower() == "off" else rest[0], "turns": turns})
            o = r.get("override") or {}
            left = o.get("turnsLeft")
            return f"tier: {o.get('tier') or 'cleared'}" + (f" for {left} turns" if o.get("tier") and left else "")
        return USAGE
    except Exception as exc:
        return f"router unreachable at {BASE_URL}: {exc}"


# ---------------------------------------------------------------------------
# registration
# ---------------------------------------------------------------------------


def register(ctx: Any) -> None:
    ctx.register_hook("pre_llm_call", on_pre_llm_call)
    ctx.register_middleware("llm_request", on_llm_request)
    ctx.register_middleware("tool_execution", on_tool_execution)
    ctx.register_command("router", router_command, description="auto-model-router: report, summary, status, why, feedback, pin, tier", args_hint="report|summary|status|why|good|bad|pin|tier")
