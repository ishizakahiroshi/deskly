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

The current source tree contains stages 1–3: the contact ledger and import, CLI and MCP, read-only case and worklog projections, and an authenticated dashboard. As checked on 2026-09-27, the [GitHub Releases page](https://github.com/ishizakahiroshi/deskly/releases) listed no published releases, and the [PyPI project JSON endpoint](https://pypi.org/pypi/deskly/json) returned HTTP 404. These are dated observations and may change.

The dashboard binds only to `127.0.0.1`. A dashboard password has not been configured for a real installation. Live issuepost and many-ai-time connections, browser and phone acceptance, tailnet access, and company acceptance have not been verified.

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

Open `http://127.0.0.1:8766` on the same computer and sign in with that password. The dashboard is read-only; its notification preview displays counts only and does not send notifications. This is a local-use instruction, not a released installation package or a tailnet setup guide.

## License

[GNU AGPL v3 or later](./LICENSE) — copyleft with a network-use provision. For modified versions that support remote interaction through a computer network, section 13 requires prominently offering all remote users the opportunity to receive the corresponding source at no charge, under the license terms.

## Author

Hiroshi Ishizaka (ishizakahiroshi) — <ishizakahiroshi.dev@gmail.com>
