# Shared Web on an existing Deskly host

The shared Web uses a separate Docker volume and a separate credential database.
It does not connect the legacy contact API container to the public proxy network.
Run these steps only after the new Deskly image has been installed and the HTTPS
reverse proxy is ready. Replace the example origin and names with your own values.

1. Create the volume and make its root private. Docker can create a volume root
   with permissions that the shared administrator correctly rejects.

   ```sh
   docker volume create deskly_web_data
   docker run --rm -v deskly_web_data:/data deskly-app:latest chmod 700 /data
   ```

2. Bootstrap the first owner from an interactive terminal. The command prompts
   twice for a passphrase; it never accepts a password argument. Record the
   returned workspace ID in a private operator note.

   ```sh
   docker run --rm -it -v deskly_web_data:/data deskly-app:latest \
     python -m deskly.shared_admin bootstrap \
     --home /data --origin https://deskly.example.invalid \
     --workspace-name "Example team" --owner-name "Owner" \
     --owner-login owner
   ```

3. Copy `company-web.env.example` to `/opt/deskly/app/web.env.local`, replace
   the origin and workspace ID, and set file mode `600`. Its credential path
   must remain `/data/shared-credentials.sqlite3`. This file contains no
   password. Keep the volume private; it contains password hashes and project
   data. The Web process refuses an uninitialized or mismatched workspace.

4. Put `compose.company-web.yaml` next to `compose.yaml`. The release installer
   includes the Web service on subsequent updates when both this overlay and
   `web.env.local` are present. Its readiness check requires an active owner.
   Start the Web service after bootstrapping:

   ```sh
   cd /opt/deskly/app
   docker compose -p deskly -f compose.yaml -f compose.company-web.yaml \
     up -d --no-deps web
   ```

5. Issue the certificate before enabling the HTTPS proxy configuration. Check
   the public `/healthz`, sign in through HTTPS, and verify two separate user
   accounts and two projects. Check that a viewer cannot read or update a
   project without a grant. Back up the workspace and credential databases to
   an independent protected destination before adding real project data.

To add a user, first create a project as the owner. Then run
`python -m deskly.shared_admin add-member` in an interactive container with
`--home`, `--origin`, `--login`, `--name`, `--project-id`, and
`--role viewer` or `--role editor`. This also prompts for a new passphrase.
The owner can subsequently change or remove project grants in the shared Web.

If bootstrap reports `partial_state_requires_recovery`, retain the lock,
workspace database, and credential database for inspection. Restore the pair
from a consistent backup or recover the interrupted step explicitly. Do not
erase the volume or rerun bootstrap over partial data.
