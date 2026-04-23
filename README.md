# TrailScribe

**AI-native satellite messaging for Garmin inReach.** Send compact `!commands`
from the backcountry; TrailScribe enriches them with location, weather, and
narrative, routes them to Gmail / Todoist / your blog, and replies in two SMS
or less — all for under $0.05 per transaction.

## Who it's for

| Persona | Off-grid work | Wins with |
|---|---|---|
| **Natalie** — field botanist, Eastern Sierra | 10–15 days/mo at 8–13k ft | `!post` auto-journals; `!mail lab@...` enriches specimen-ID requests |
| **Marcus** — expedition guide, PNW / Alaska / Patagonia | 8–12 day trips, 6–10 clients | Evening `!post` publishes to an expedition blog families follow |
| **Yuki** — solo bikepacker / storyteller, Iceland / Mongolia | 3–6 week trips | Blog never goes dark; real-time narrative without café data-entry days |

## α-MVP commands (6)

```
!ping                                      status check
!help                                      command summary
!cost                                      month-to-date usage
!post <note>                               journal entry (AI narrative + blog publish)
!mail to:<addr> subj:<subj> body:<body>    enriched email with location context
!todo <task>                               Todoist task with GPS + timestamp
```

All replies fit in ≤320 characters (two SMS). See `docs/PRD.md` §2 for the full
MVP spec and the deferred-commands table.

## Architecture

Cloudflare Workers + KV. Single Worker receives Garmin IPC Outbound webhooks,
verifies a static bearer token, dedupes via KV, and dispatches to per-command
handlers. Replies route through Garmin IPC Inbound. See
[`docs/architecture.md`](docs/architecture.md) for the full flow and
[`docs/PRD.md`](docs/PRD.md) §3 for design rationale.

## Status

**α-MVP in development.** PRD signed 2026-04-22; Phase 0 scaffolding in
progress. Follow [`plans/phase-0-scaffolding.md`](plans/phase-0-scaffolding.md)
for the current milestone.

## Development

Prerequisites: Node ≥20, pnpm 9+ (via corepack), a Cloudflare account, and
Wrangler CLI (`pnpm install` pulls it in).

```bash
pnpm install
cp .dev.vars.example .dev.vars      # fill in secrets
pnpm test                            # run the Vitest suite
pnpm dev                             # wrangler dev (local worker)
```

For first-time Cloudflare setup (KV namespaces, secrets, staging +
production envs), follow [`docs/setup-cloudflare.md`](docs/setup-cloudflare.md).

For Garmin IPC configuration (Portal Connect, bearer token, API key), follow
[`docs/garmin-setup.md`](docs/garmin-setup.md) — requires **inReach
Professional** tier.

## Deployment

```bash
pnpm deploy:staging                  # wrangler deploy --env staging
pnpm deploy:prod                     # wrangler deploy --env production
```

Pushes to `staging/**` and `main` auto-deploy via
[`.github/workflows/deploy-cloudflare.yml`](.github/workflows/deploy-cloudflare.yml).

## Governance

- **License:** MIT (`LICENSE`)
- **Security:** see [`SECURITY.md`](SECURITY.md)
- **Contributing:** see [`CONTRIBUTING.md`](CONTRIBUTING.md)
- **Code of conduct:** see [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)

## Historical notes

Earlier iterations targeted Pipedream and self-hosted n8n. Those deployment
paths are archived in [`docs/archive/`](docs/archive/) for reference only —
they are not maintained and should not be followed for new deploys.
