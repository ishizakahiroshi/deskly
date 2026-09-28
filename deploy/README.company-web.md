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

   Set `DESKLY_TRUSTED_PROXIES` to the subnet of the `deskly_ingress` network
   (for example the output of
   `docker network inspect deskly_ingress --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}'`).
   Login failures are counted per client address and login name. Behind the
   proxy every request arrives from the proxy address, so without this setting
   anyone who knows a login name can keep that account locked out. With it, the
   Web reads `X-Real-IP` (or the right-most untrusted `X-Forwarded-For` hop)
   only from requests whose direct peer is in the listed networks. The proxy
   must overwrite `X-Real-IP` with `$remote_addr`. Every container attached to
   `deskly_ingress` is trusted for this purpose, so attach only the proxy and
   the Web. A catch-all network such as `0.0.0.0/0` is refused.

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
   project without a grant. Before adding real project data, make a paired
   backup to a new directory on an independent protected destination. Stop the
   Web service and every other process that can write either database first.

   ```sh
   cd /opt/deskly/app
   docker compose -p deskly -f compose.yaml -f compose.company-web.yaml stop web
   docker run --rm -v deskly_web_data:/data -v /srv/protected-backups:/backups \
     deskly-app:latest python -m deskly.shared_admin backup \
     --home /data --destination /backups/shared-2026-09-28 --service-stopped
   ```

   The destination must not already exist. The command keeps the shared admin
   lock for the full snapshot, checks that every account still joins to its
   workspace identity, exports the workspace, then checks the pair again from
   that exported workspace. The manifest records the workspace ID, identity
   issuer, counts and checksums; it contains no credential hashes. The flag is
   an operator assertion: the command cannot detect writers outside its own
   admin lock. Keep the backup directory private. On Windows, directory mode
   bits are not an ACL guarantee; use a destination protected by the host's
   actual access controls.

   Restore only into a new, empty shared-home path while the Web and all writers
   are stopped. Preserve the original volume. First copy the verified backup
   pair to a new volume or host path, then run:

   ```sh
   docker run --rm -v deskly_web_restore:/restore \
     -v /srv/protected-backups/shared-2026-09-28:/backup:ro deskly-app:latest \
     python -m deskly.shared_admin restore --source /backup --home /restore \
     --origin https://deskly.example.invalid
   ```

   The specified origin must exactly match the identity issuer inside the
   verified backup; this prevents restoring accounts under a different host
   identity and unexpectedly locking every member out. Review the returned
   workspace ID, account count, identity count and issuer against the manifest,
   then point the Web at this restored home only after the operator has
   confirmed the intended volume. Restore refuses an existing target and does
   not overwrite the original volume. A paired backup is not an atomic
   cross-database snapshot; stopping every writer is required.

To add a user, first create a project as the owner. Then run
`python -m deskly.shared_admin add-member` in an interactive container with
`--home`, `--origin`, `--login`, `--name`, `--project-id`, and
`--role viewer` or `--role editor`. This also prompts for a new passphrase.
The owner can subsequently change or remove project grants in the shared Web.
If member deactivation succeeds but the credential store write fails, the member
is already denied by the workspace authorization check. The owner access page
shows a pending credential revocation and offers a retry; do not reactivate the
member or remove the recovery indicator manually.

If bootstrap reports `partial_state_requires_recovery`, retain the lock,
workspace database, and credential database for inspection. Restore the pair
from a consistent backup or recover the interrupted step explicitly. Do not
erase the volume or rerun bootstrap over partial data.

For an interrupted `add-member`, stop the Web and every other workspace writer,
then inspect `shared-admin.lock`. The lock contains the exact non-secret
enrollment intent. Resume only that intent with
`python -m deskly.shared_admin recover-member` and the same `--origin`,
`--login`, `--name`, `--project-id`, and `--role`, plus `--service-stopped`.
The command prompts for the account passphrase and completes only a missing
credential/member/grant step; mismatched or ambiguous state is refused. It
removes the lock only after the matching member and grant are verified.
