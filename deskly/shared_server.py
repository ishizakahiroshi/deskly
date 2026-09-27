"""Dedicated shared Web process; put its port on a private proxy network only."""

from __future__ import annotations

import os
from pathlib import Path

from deskly.dashboard_server import create_shared_dashboard_server


def main() -> None:
    home = Path(os.environ["DESKLY_HOME"])
    workspace_id = os.environ["DESKLY_WORKSPACE_ID"]
    credential_store = Path(os.environ["DESKLY_CREDENTIAL_STORE"])
    public_origin = os.environ["DESKLY_PUBLIC_ORIGIN"]
    port = int(os.environ.get("DESKLY_WEB_PORT", "8766"))
    # Empty by default: forwarding headers are ignored unless the proxy is named.
    trusted_proxies = os.environ.get("DESKLY_TRUSTED_PROXIES", "")
    server = create_shared_dashboard_server(
        home=home, workspace_id=workspace_id, credential_store=credential_store,
        public_origin=public_origin, host="0.0.0.0", port=port,
        trusted_proxies=trusted_proxies,
    )
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
