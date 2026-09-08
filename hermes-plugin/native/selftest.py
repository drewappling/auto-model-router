"""Self-test for the Hermes native plugin's pure functions.

Run by test/hermes-plugin.test.ts when a Python interpreter is on PATH (the
Bun suite cannot import Python), and directly:

    python hermes-plugin/native/selftest.py

Exercises identity headers, the digest gate and replacement, and the /router
command rendering against fake transports. Exits non-zero on the first
failure with the assertion that failed.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("amr_native", os.path.join(HERE, "__init__.py"))
m = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(m)


def test_identity_headers() -> None:
    m.on_pre_llm_call(session_id="s1", parent_session_id="")
    m.on_pre_llm_call(session_id="s2", parent_session_id="s1")
    r = m.on_llm_request(request={"model": "auto", "extra_headers": {"A": "b"}}, provider="auto-model-router", session_id="s2")
    assert r["request"]["extra_headers"] == {"A": "b", "X-Omp-Harness": m.HARNESS_ID, "X-Omp-Session": "s2", "X-Omp-Subagent": "1"}, r
    main = m.on_llm_request(request={"model": "auto"}, provider="auto-model-router", session_id="s1")
    assert "X-Omp-Subagent" not in main["request"]["extra_headers"], main
    assert m.on_llm_request(request={}, provider="anthropic", session_id="s1") is None
    assert m._CURRENT["session_id"] == "s1"


def test_digest() -> None:
    m.POLICY.value = {"enabled": True, "minBytes": 10, "maxBytes": 100000, "tools": ["read", "grep", "bash"], "toolAliases": {"read_file": "read", "terminal": "bash"}, "fromTier": "moderate"}
    m.POLICY._at = 10**12
    calls = []

    def fake_post(path, payload, timeout=0):
        calls.append((path, payload["toolName"], len(payload["content"])))
        return {"digested": True, "text": "[digest] short"}

    big = json.dumps({"content": "x" * 500, "path": "a.ts"})
    out = m.maybe_digest(big, "read_file", {"path": "a.ts"}, "s1", post=fake_post)
    assert json.loads(out)["content"] == "[digest] short", out
    assert json.loads(out)["path"] == "a.ts"
    assert calls == [("/v1/router/digest", "read_file", 500)], calls
    err = json.dumps({"error": "nope", "content": "x" * 500})
    assert m.maybe_digest(err, "read_file", {}, "s1", post=fake_post) == err
    assert m.maybe_digest(json.dumps({"content": "x" * 500}), "write_file", {}, "s1", post=fake_post).startswith('{"content": "xxx')
    plain = "plain text " * 100
    assert m.maybe_digest(plain, "read_file", {}, "s1", post=fake_post) == plain
    assert len(calls) == 1
    assert m.canonical_tool(m.POLICY.value, "TERMINAL") == "bash"
    assert m.largest_string_field({"a": "x" * 90, "b": "y" * 5}) == "a"
    assert m.largest_string_field({"a": "x" * 50, "b": "y" * 50}) is None


def test_router_command() -> None:
    def fake_get(path, timeout=5.0, text=False):
        if path.startswith("/v1/router/report"):
            return "REPORT " + path
        if path.startswith("/v1/router/summary"):
            return "SUMMARY " + path
        if path.startswith("/health"):
            return {"status": "ok", "apiKeyConfigured": True, "apiKeySource": "env", "catalog": {"models": 3}, "ollama": None, "softFailures": {"spikes": [{"slug": "a/b", "recentRate": 0.5, "recentDispatches": 8, "baselineRate": 0.05}]}}
        if path.startswith("/v1/router/decisions"):
            return {"entries": [{"slug": "a/b", "tier": "hard", "classificationSource": "heuristic", "confidence": 0.7, "reportedUsd": 0.0000097, "usage": {"promptTokens": 100, "cachedTokens": 50}, "latencyMs": 900, "reasons": ["r1"]}]}
        return {}

    def fake_post(path, payload, timeout=5.0):
        if path == "/v1/router/feedback":
            return {"slug": "a/b", "tier": "hard"}
        return {"override": {"slug": payload.get("slug"), "tier": payload.get("tier"), "turnsLeft": payload.get("turns")}}

    assert m.router_command("report 30 --all", get=fake_get, post=fake_post) == "REPORT /v1/router/report?days=30&format=text"
    assert m.router_command("report", get=fake_get, post=fake_post).endswith(f"days=7&format=text&harness={m.HARNESS_ID}")
    assert m.router_command("summary", get=fake_get, post=fake_post).startswith("SUMMARY /v1/router/summary?format=text&harness=")
    status = m.router_command("status", get=fake_get, post=fake_post)
    assert "soft failures SPIKING (1)" in status and "a/b: 50% of 8" in status, status
    why = m.router_command("why", get=fake_get, post=fake_post)
    assert "last turn: a/b [hard]" in why and "$0.00001" in why and "cache hit 50%" in why, why
    assert m.router_command("good nice", get=fake_get, post=fake_post) == "recorded good for a/b [hard]"
    assert m.router_command("pin a/b", get=fake_get, post=fake_post) == "pin: a/b"
    assert m.router_command("tier hard 5", get=fake_get, post=fake_post) == "tier: hard for 5 turns"
    assert m.router_command("tier off", get=fake_get, post=fake_post) == "tier: cleared"
    assert m.router_command("bogus", get=fake_get, post=fake_post) == m.USAGE

    def down(path, timeout=5.0, text=False):
        raise OSError("connection refused")

    assert m.router_command("status", get=down, post=fake_post).startswith("router unreachable at")


if __name__ == "__main__":
    for name, fn in [(n, f) for n, f in globals().items() if n.startswith("test_")]:
        fn()
        print(f"ok {name}")
    sys.exit(0)
