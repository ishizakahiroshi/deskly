"""Keep local-owner entrypoints out of the shared Web runtime."""

from __future__ import annotations

import os

from deskly.config import deskly_home

_SHARED_RUNTIME_KEYS = (
    "DESKLY_WORKSPACE_ID",
    "DESKLY_CREDENTIAL_STORE",
    "DESKLY_PUBLIC_ORIGIN",
)
_SHARED_HOME_FILES = ("shared-credentials.sqlite3", "shared-admin.lock")


class SharedModeUnavailable(ValueError):
    """A local-owner entrypoint was requested in the shared runtime."""


def require_local_mode() -> None:
    """Fail closed for a shared runtime or a shared home without its env file."""
    home = deskly_home()
    if any(key in os.environ for key in _SHARED_RUNTIME_KEYS) or any(
        os.path.lexists(home / name) for name in _SHARED_HOME_FILES
    ):
        raise SharedModeUnavailable(
            "共有環境ではローカル所有者用 CLI/MCP を使えません。"
            "共有 workspace の CLI/MCP 認証経路は未実装です"
        )
