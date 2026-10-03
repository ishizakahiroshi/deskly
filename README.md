# deskly

**See whose turn it is — across every contact and every case.** deskly keeps a ledger of your outgoing and incoming contacts (state, case, due date, promises, drafts, and a full change history) and answers "whose turn is it today, and what is next?" from a CLI, an MCP server for AI assistants, and a read-only localhost dashboard.

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/License-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

## What it does

- **One ledger for contacts.** Each contact has a state from a fixed vocabulary (`下書き` draft / `送信済み` sent / `回答待ち` waiting for reply / `対応中` in progress / `完了` done / `送らない` not sent), a case reference, a due date, and a draft body. Every change is recorded.
- **Whose turn, per case.** Contacts are grouped into one row per case, so you see at a glance which cases are waiting on you and which are waiting on the other side — overdue ones first.
- **Reads, does not copy.** External records stay in their owning tools. Deskly keeps only its contact ledger and reads optional case and worklog summaries without copying those records.
- **Optional read-only integrations.** Deskly can read case summaries from issuepost and, when explicitly configured, aggregate worklog data from many-ai-time. It does not copy or change those tools' records.
- **Local first, server when you need it.** A ledger lives in a local SQLite file, or on another machine running deskly. Several ledgers can be shown as one list.

## Status

The `develop` integration candidate contains two implementations. The existing Python contact-ledger CLI, MCP and deployment under `deskly/` and `deploy/` are retained. The next-version workspace implementation is `core/` (TypeScript API, UI, SQLite/D1 adapters), `rust/` (CLI and stdio MCP), and the canonical `schema/`. `deploy/cloudflare-next/` is the separate owner-only Cloudflare deployment candidate.

The next-version API uses stable workspace/project/item IDs and retains versioned preview/save, history, archive and restore contracts. Cloudflare owner access validates Access JWTs at both the personal boundary and inner API, then checks actual memberships in the service. Machine read access has a separate capability for explicitly allowed projects; it does not grant owner/member rights. See the [read-access contract](docs/bot/local-agent-read-access/AUTH_CONTRACT.md) and [progress](docs/bot/local-agent-read-access/PROGRESS.md) for tested scope and remaining acceptance.

These are source-tree candidates, not a production release or a completed migration. Live Access claims, revocation, Windows AI/MCP, owner browser flows and personal deployment/recovery need separate operator acceptance. Company data and credentials are outside this work. The legacy Python localhost dashboard still binds to `127.0.0.1`; its setup instructions below are specific to that implementation.

## Next-version development

Requires Node >=22, pnpm, and Rust >=1.88 (the dependency lock may require a newer supported toolchain; this integration is verified with Rust 1.90). Start from the repository root:

```text
pnpm --dir core install --frozen-lockfile
pnpm --dir core run typecheck
pnpm --dir core run test
cargo fmt --manifest-path rust/Cargo.toml --all -- --check
cargo clippy --manifest-path rust/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --all
```

The frozen schema generates TypeScript and Rust types; do not change it for authentication scopes. Existing Bearer-authenticated adapters remain supported. The next-version CLI reads only explicitly chosen JSON config or dedicated environment variables, never the legacy home automatically. For the scoped machine client, see [local AI read-only setup](docs/reference_local-agent-read-access.md). See [Cloudflare deployment](deploy/cloudflare-next/README.md) and [migration boundary](docs/reference_personal-migration.md); running tests does not authorize or perform deployment.

## Contact ledger CLI and MCP

List contacts across every configured ledger, or search their project, recipient, channel, promise, agreement, basis, note, and body fields with a case-insensitive partial match:

```
deskly contacts list
deskly contacts search follow-up
```

The human-readable output is a summary. Add `--json` to either command to receive complete contact records, including their body and import metadata.

The MCP server provides the same read access. `list_contacts(limit=100, offset=0)` returns one page with the total count and `next_offset`. `search_contacts(query, limit=20, offset=0)` keeps its list response and accepts an offset for later matches. Page offsets are calculated from the ledger state at each call, so writes between calls can shift later pages.

These CLI and MCP commands use the local contact ledgers; they do not authenticate a member of the shared workspace. Deskly rejects the local-owner CLI commands and MCP server startup when the shared Web runtime is configured or `DESKLY_HOME` contains the shared credential database or setup lock. The separate next-version Rust CLI/MCP and scoped workspace API are described above; these Python commands do not become that client.

## Development

```
# Windows PowerShell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[dev,mcp]"
.\.venv\Scripts\python.exe -m pytest -q

# macOS / Linux
python -m venv .venv
.venv/bin/python -m pip install -e ".[dev,mcp]"
.venv/bin/python -m pytest -q
```

## Local dashboard

After installing from this source checkout, set `DESKLY_DASHBOARD_PASSWORD` in the server process environment to a value of at least 16 characters, then start the local dashboard:

```
# Windows PowerShell
.\.venv\Scripts\deskly.exe dashboard serve --host 127.0.0.1 --port 8766

# macOS / Linux
.venv/bin/deskly dashboard serve --host 127.0.0.1 --port 8766
```

Open `http://127.0.0.1:8766` on the same computer and sign in with that password. Without a workspace, the dashboard remains a read-only view. Its notification preview displays counts only and does not send notifications. This is a local-use instruction, not a released installation package or a tailnet setup guide.

### Experimental personal workspace (source checkout only)

Set `DESKLY_HOME` to a dedicated local directory. Initialize once with `deskly workspace init --name "My workspace" --owner "Local owner"`, then start the dashboard as above. The same loopback login opens project overview, project detail, and personal work. Project and work item changes show a preview before saving; an outdated version requires reviewing the latest value and confirming again. The workspace lives in a separate SQLite file under `DESKLY_HOME/workspaces/`. Do not place it in a synced folder.

After a work session, use `deskly workspace backup --dest <new-file.jsonl>` for a checked workspace export. For a recovery rehearsal, point `DESKLY_HOME` to a different empty directory and run `deskly workspace restore --source <file.jsonl>`. Restore rejects an existing workspace destination. The contact ledger needs its own backup. The editor can register a source ID for a configured contact ledger or issuepost connection, then link a contact or external case by its ID. The fetch action reads only explicit links and records the attempt status and time; it does not copy the external record into the workspace. Archived items can be restored with a versioned change. Reload asks before discarding unsaved input. C2 browser acceptance covered these controls in an isolated temporary workspace; a read-only fetch from the configured contact ledger returned only the permitted summary fields, and the ledger was unchanged. Issuepost remains unconfigured and unverified. Shared access is a separate source-tree entrypoint; see the [design and implementation boundary](docs/reference_team-dashboard.md).

## License

[GNU AGPL v3 or later](./LICENSE) — copyleft with a network-use provision. For modified versions that support remote interaction through a computer network, section 13 requires prominently offering all remote users the opportunity to receive the corresponding source at no charge, under the license terms.

## Author

Hiroshi Ishizaka (ishizakahiroshi) — <ishizakahiroshi.dev@gmail.com>
