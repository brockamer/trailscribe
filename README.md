# Trailscribe

Trailscribe is an open‑source project that turns a Garmin inReach or GPSMAP satellite communicator into a command interface for a custom AI agent.  The agent receives Garmin IPC webhooks, parses your SMS‑sized commands, calls into tools such as OpenAI, Gmail and Todoist, and responds with concise messages that include both Google Maps and Garmin MapShare links.

This repository contains a TypeScript implementation of the agent orchestrator, a small HTTP router for Garmin IPC outbound webhooks, helper modules for supported tools, and setup examples for running the agent on Pipedream (primary), n8n on Proxmox, and Cloudflare Workers.  All code lives in the `src` directory, with a clear separation between HTTP handling, the agent core, individual tool wrappers and runtime utilities such as idempotency and cost tracking.

## Features

- **Simple commands** – A concise grammar with commands like `!ping`, `!where`, `!ai`, `!todo`, `!mail`, `!drop`, `!camp`, `!post`, `!blast`, `!share`, `!brief`, `!cost` and `!help`.
- **Concise replies** – The agent responds with ≤2 SMS‑length messages, automatically including Google Maps and Garmin MapShare links when location is present.
- **Idempotency** – Webhooks are deduped by message ID to avoid duplicate replies.
- **Cost tracking** – Each OpenAI request records prompt and completion tokens to a monthly ledger, supporting `!cost` to show cumulative usage and (optionally) appending a cost suffix on every reply.
- **Self‑hosted options** – Although Pipedream is the primary infrastructure, the repo includes ready‑to‑use examples for n8n running in a Proxmox → Docker VM and for Cloudflare Workers using KV storage.
- **Detailed docs** – Step‑by‑step setup guides for Garmin IPC, Pipedream, self‑hosted n8n and Workers, plus a runbook for off‑grid debugging.
- **MIT licensed** – You are free to build on this project, modify it, and contribute improvements.

## Getting started (development)

On your local Manjaro Linux workstation, install the prerequisites and clone the repo:

```bash
sudo pacman -Syu
sudo pacman -S --needed git github-cli nodejs npm pnpm docker docker-compose
gh auth login

# Clone the repository after you have created it on GitHub
git clone https://github.com/&lt;your‑username&gt;/trailscribe.git
cd trailscribe
pnpm install
pnpm test
pnpm dev
```

Development uses `pnpm` for package management, ESLint and Prettier for linting/formatting, and a basic Jest test suite.  Running `pnpm dev` starts a local Express server for testing the HTTP router and agent.

## Directory structure

```
trailscribe/
├─ README.md                # This file
├─ LICENSE                  # MIT license text
├─ CONTRIBUTING.md          # Contribution guidelines
├─ CODE_OF_CONDUCT.md       # Code of conduct for contributors
├─ SECURITY.md              # Security policy and reporting
├─ .gitignore               # Git ignore rules
├─ package.json             # Package metadata and scripts
├─ tsconfig.json            # TypeScript configuration
├─ src/
│  ├─ http/
│  │  ├─ router.ts        # Garmin IPC outbound handler (webhook)
│  │  └─ reply.ts         # Helpers for sending replies via IPC or email
│  ├─ agent/
│  │  ├─ orchestrator.ts  # OpenAI Responses + tool calls + cost tracking
│  │  └─ grammar.ts       # Command parsing & validation
│  ├─ tools/
│  │  ├─ emailGmail.ts    # Gmail send implementation
│  │  ├─ todoist.ts       # Todoist task creation
│  │  ├─ posthaven.ts     # Email‑to‑blog helper
│  │  ├─ webSearch.ts     # Optional web search helper
│  │  └─ links.ts         # Builders for MapShare and Google Maps links
│  ├─ runtime/
│  │  ├─ context.ts       # Nearest place and weather summarizer
│  │  ├─ idempotency.ts   # Replay/mutex helpers
│  │  └─ ledger.ts        # Token/$ ledger (Pipedream Data Store or KV)
│  └─ config/env.ts       # zod schema for environment variables
├─ examples/
│  ├─ env.example          # Template for environment variables
│  ├─ pipedream-steps.md   # Paste‑ready Pipedream workflow steps
│  ├─ n8n-docker-compose.yml  # n8n docker-compose for Proxmox VM
│  └─ workers-minimal.md   # Cloudflare Workers + KV instructions
├─ docs/
│  ├─ architecture.md      # System architecture overview
│  ├─ field-commands.md    # List of commands with examples
│  ├─ runbook-offgrid.md   # Troubleshooting guide when off grid
│  ├─ garmin-setup.md      # Garmin IPC setup instructions
│  ├─ pipedream-setup.md   # Pipedream setup and low‑cost tips
│  ├─ selfhost-n8n-proxmox.md  # n8n on Proxmox guide
│  └─ wiring-diagram.svg   # Visual wiring diagram of the system
├─ .github/workflows/ci.yml  # GitHub Actions workflow
└─ tests/
   ├─ grammar.test.ts      # Tests for command parsing
   └─ idempotency.test.ts  # Tests for idempotency logic
```

## Status and roadmap

Trailscribe is a work in progress.  The initial release implements basic command parsing, tool integrations and Pipedream deployment.  Future improvements may include more sophisticated natural language parsing, additional tools, offline caching and a richer field log.

Contributions are welcome!  See `CONTRIBUTING.md` for details on how to file issues and submit pull requests.
