"""Hermes provider plugin for auto-model-router.

Spawns the router as a standalone subprocess on a fixed port and registers a
ProviderProfile pointing at it, so Hermes routes each turn through the router's
per-turn cost/complexity logic. The router is a Bun process; this Python plugin
manages it as a child process (Hermes plugins may spawn subprocesses).

Install by copying this directory to
``$HERMES_HOME/plugins/model-providers/auto-model-router/`` (or symlinking it),
then restart Hermes. The router binary must be on PATH as ``auto-model-router``
(or set ``AUTO_MODEL_ROUTER_BIN`` to its path).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
import urllib.request

from providers import register_provider
from providers.base import ProviderProfile

# Fixed port the standalone router binds. Hermes points at this URL.
PORT = int(os.environ.get("AUTO_MODEL_ROUTER_PORT", "8788"))
BASE_URL = f"http://127.0.0.1:{PORT}/v1"

# The router binary. Defaults to `auto-model-router` on PATH; override with
# AUTO_MODEL_ROUTER_BIN for a non-PATH install.
BIN = os.environ.get("AUTO_MODEL_ROUTER_BIN", "auto-model-router")


def _router_running() -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=1) as resp:
            return resp.status == 200
    except Exception:
        return False


def _spawn_router() -> None:
    """Start the standalone router if it is not already running."""
    if _router_running():
        return
    if shutil.which(BIN) is None:
        # Not on PATH and not running — log and register anyway; Hermes will
        # surface the connection failure rather than crash the plugin.
        return
    subprocess.Popen(
        [BIN, "serve", "--port", str(PORT)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    # Wait for it to come up (bounded).
    for _ in range(50):
        if _router_running():
            return
        time.sleep(0.2)


_spawn_router()

profile = ProviderProfile(
    name="auto-model-router",
    api_mode="chat_completions",
    base_url=BASE_URL,
    auth_type="api_key",
    env_vars=("AUTO_MODEL_ROUTER_API_KEY",),
    fallback_models=("auto", "auto-cheap", "auto-max"),
    display_name="auto-model-router",
    description="Per-turn cost/complexity-aware model routing",
)
register_provider(profile)
