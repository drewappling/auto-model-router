"""Hermes provider plugin for auto-model-router.

Requires auto-model-router installed globally via npm so its `serve` binary is
on PATH:

    npm install -g auto-model-router

The plugin spawns `auto-model-router serve` as a subprocess on a fixed port and
registers a ProviderProfile pointing at it, so Hermes routes each turn through
the router's per-turn cost/complexity logic. The router is a Bun process; this
Python plugin manages it as a child process (Hermes plugins may spawn
subprocesses).

Install by copying this directory to
``$HERMES_HOME/plugins/model-providers/auto-model-router/`` (or symlinking it),
then restart Hermes. Override the port with ``AUTO_MODEL_ROUTER_PORT``.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import urllib.request

from providers import register_provider
from providers.base import ProviderProfile

# Fixed port the standalone router binds. Hermes points at this URL.
PORT = int(os.environ.get("AUTO_MODEL_ROUTER_PORT", "8788"))
BASE_URL = f"http://127.0.0.1:{PORT}/v1"

# The router binary, provided by `npm install -g auto-model-router`.
BIN = "auto-model-router"


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
        raise RuntimeError(
            "auto-model-router is not installed or not on PATH. "
            "Run `npm install -g auto-model-router` first."
        )
    if sys.platform.startswith("win"):
        # npm installs a `.cmd` shim that cannot be exec'd as a bare argv
        # list; shell=True resolves it through the command shell.
        subprocess.Popen(
            f'"{BIN}" serve --port {PORT}',
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=True,
            start_new_session=True,
        )
    else:
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
    raise RuntimeError(f"auto-model-router did not come up on port {PORT}")


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
