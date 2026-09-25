# deskly

**See whose turn it is — across every contact and every case.** deskly keeps a ledger of your outgoing and incoming contacts (state, case, due date, promises, drafts, and a full change history) and answers "whose turn is it today, and what is next?" from a CLI, an MCP server for AI assistants, and (later) a dashboard.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

## What it does

- **One ledger for contacts.** Each contact has a state from a fixed vocabulary (`下書き` draft / `送信済み` sent / `回答待ち` waiting for reply / `対応中` in progress / `完了` done / `送らない` not sent), a case reference, a due date, and a draft body. Every change is recorded.
- **Whose turn, per case.** Contacts are grouped into one row per case, so you see at a glance which cases are waiting on you and which are waiting on the other side — overdue ones first.
- **Reads, does not copy.** Work notes, case trackers, chat, mail and calendars stay in the tools that own them. deskly reads them through MCP or CLI output instead of keeping its own copy.
- **Tool-agnostic.** Each kind of tool (chat, mail, calendar, case tracker) is reached through a small connector, so you can swap the tool without changing deskly.
- **Local first, server when you need it.** A ledger lives in a local SQLite file, or on another machine running deskly. Several ledgers can be shown as one list.

## Status

Early stage. Stage 1 (the contact ledger, import, CLI and MCP) is being built. Nothing is published yet.

## Development

```
python -m venv .venv
.venv/bin/python -m pip install -e ".[dev,mcp]"
.venv/bin/python -m pytest -q
```

## License

[GNU AGPL v3](./LICENSE) — copyleft that extends to network use. If you modify deskly and run it as a network service, you must publish the modifications.

## Author

Hiroshi Ishizaka (ishizakahiroshi) — <ishizakahiroshi.dev@gmail.com>
