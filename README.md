# deskly

**Self-hosted service desk suite** for internal business systems. Ports-and-adapters architecture: a language-agnostic core with pluggable channel adapters for Nextcloud, TranChat, MCP, and future systems.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

## What it does

deskly connects three groups around a shared support workflow:

- **業務システムのエンドユーザー** files QA / bugs / requests directly from the system they are already using (via an embeddable widget). No new login, no new URL.
- **開発者・対応者** manages tickets in a unified dashboard, with automatic prefill of version, environment, and user context. AI agents (Claude, ChatGPT) can query and update via MCP.
- **経営層・管理職** sees only what they are authorized for — one system if they own one, all systems if they run the company. Cross-customer aggregation is opt-in.

Data stays on your infrastructure. No third-party cloud dependency.

## Architecture (ports & adapters)

```
                    ┌────────────────────────────────────┐
                    │            deskly core             │
                    │  REST API │ PostgreSQL │ MCP tools │
                    │  attachment storage │ auth (OIDC)  │
                    └────────────────────────────────────┘
                        ▲              ▲              ▲
              ┌─────────┘              │              └─────────┐
              │                        │                        │
      ┌───────────────┐      ┌────────────────┐      ┌────────────────┐
      │ nextcloud     │      │ tranchat       │      │ mcp / other    │
      │ adapter       │      │ adapter        │      │ adapters       │
      │ (PHP + Vue)   │      │ (Node / Py)    │      │ (Python)       │
      └───────────────┘      └────────────────┘      └────────────────┘
              ▲                        ▲                        ▲
     Nextcloud users         TranChat messages          AI agents /
     (SSO, files, notify)    (bot, DM, mention)         other systems

  ┌──────────────────────────────────────────────────────────────┐
  │ libs/embed  — dropped into each business system              │
  │ (PHP composer / npm)                                         │
  │ - QA button + modal                                          │
  │ - version / env / user prefill                               │
  │ - push to core via batch worker                              │
  └──────────────────────────────────────────────────────────────┘
```

- **core** knows nothing about Nextcloud, TranChat, or specific channels
- **adapters** translate between core and each channel
- **libs/embed** is what ships inside your business systems (mer / WF / TranChat / your app)

## Status

Early-stage. See [`docs/design_deskly-architecture_2026-07-22.html`](docs/design_deskly-architecture_2026-07-22.html) for the architecture proposal and [`docs/mockup_deskly-integrated-view_2026-07-22.html`](docs/mockup_deskly-integrated-view_2026-07-22.html) for the integrated dashboard UI mock.

Phase 1 target: core (Go) + `adapters/nextcloud` (PHP + Vue) + `libs/embed` (PHP) — MVP for internal business system rollout.

## License

[GNU AGPL v3](./LICENSE) — copyleft that extends to network use. If you modify deskly and run it as a network service, you must publish the modifications.

## Author

Hiroshi Ishizaka (ishizakahiroshi) — <ishizakahiroshi.dev@gmail.com>
