# TrailScribe

A command-driven assistant for Garmin inReach. From a satellite messenger, you
send a short `!command`; a Cloudflare Worker enriches it with location and
weather, runs an LLM where it helps, performs the action (email, task, blog
post), and replies in two SMS or fewer. Design target: **~$0.03 per
transaction** — less than a single premium satellite message.

> **Status (2026-04-24).** α-MVP, Phase 0 complete. A staging Worker at
> `trailscribe-staging.trailscribe.workers.dev` receives Garmin IPC Outbound
> webhooks, verifies a bearer token, enforces an IMEI allowlist, and
> deduplicates replays via KV (verified end-to-end). Tool adapters (LLM,
> Resend, Todoist, GitHub Pages) and reply delivery are stubbed — they wire
> up in Phase 1. Progress tracked on the
> [project board](https://github.com/users/brockamer/projects/3).

---

## The gap

Satellite messengers keep you safe where cell coverage doesn't reach — the
Eastern Sierra, the Brooks Range, Patagonia. They also isolate you from the
rest of your workflow. Today's options are to type `OK AT CAMP` and call it
done, or burn rest days in a café re-entering everything. TrailScribe takes
the 160-character window the device already has and turns it into a command
interface. Enrichment happens server-side; the device sees a short
confirmation come back.

## What it does

α-MVP is six commands. The parser (`src/core/grammar.ts`) is salvaged from
earlier iterations and subsetted to this list; the full 13-verb grammar and
the deferred commands (`!where`, `!weather`, `!brief`, `!ai`, `!camp`,
`!blast`, `!share`, `!drop`) are spec'd in [`docs/PRD.md`](docs/PRD.md) §2.

| Command | What it does |
|---|---|
| `!post <note>` | Turns a note + GPS into a titled, geotagged entry committed to a GitHub Pages journal as markdown. Narrative via LLM. |
| `!mail to:_ subj:_ body:_` | Sends an email with coordinates, place name, elevation, and weather appended. No AI call. |
| `!todo <task>` | Creates a Todoist task with GPS + timestamp in the note. No AI call. |
| `!ping` | Health check → `pong`. |
| `!help` | One-SMS command summary. |
| `!cost` | Month-to-date requests, tokens, and USD. |

Every reply fits in ≤ 320 characters (two Iridium SMS, 160 each). Content
that doesn't fit — full narratives, detailed help, error stack traces — goes
to the blog or email. Never to the device.

## How it works

```
  inReach                           Cloudflare Worker (Hono)
  ───────                           ─────────────────────────
   !post … ──HTTPS──▶  POST /garmin/ipc
                       1. verify  Authorization: Bearer …
                       2. IMEI allowlist
                       3. dedupe (KV, 48 h TTL)
                       4. dispatch to orchestrator
                          └─▶ geocode · weather · LLM
                              └─▶ GitHub Pages · Todoist · Resend
                       5. return 200 OK  (always — see below)
                                   │
   ◄─ ≤ 2 SMS ─ Garmin IPC Inbound  ◄─ reply (≤ 160 chars × 2)
```

Steps 1–3 run today. Step 4 and the IPC Inbound reply land in Phase 1; the
orchestrator and every tool adapter are stubs in the current commit.

The always-200 rule is non-negotiable. Garmin retries at 2 / 4 / 8 / 16 / 32
/ 64 / 128 seconds on non-200, then pauses 12 h × 5 days before suspending
the integration. App-level errors surface through the IPC Inbound reply
instead (`"Error: Todoist auth failed"`) — never as an HTTP error back to
Garmin.

State lives in four KV namespaces — `TS_IDEMPOTENCY` (48 h TTL), `TS_LEDGER`
(monthly rollup), `TS_CONTEXT` (per-IMEI rolling window), `TS_CACHE`
(geocode + weather). Durable Objects and D1 come in later phases. Full
detail in [`docs/architecture.md`](docs/architecture.md) and
[`docs/PRD.md`](docs/PRD.md) §3.

## What it will cost

Estimated per-transaction cost, from [`docs/PRD.md`](docs/PRD.md) §6. These
are design targets, not measurements — one α launch criterion is verifying
≥ 20 real `!post` transactions against this table before calling Phase 1 done.

| Command | LLM | Workers infra | Third-party | Total |
|---|---|---|---|---|
| `!post` | $0.020–0.030 | ~$0.001 | $0 (GitHub / Nominatim / Open-Meteo) | **$0.021–0.031** |
| `!mail` | — | ~$0.0005 | $0 (Resend free tier) | **~$0.001** |
| `!todo` | — | ~$0.0002 | $0 (Todoist free) | **~$0.0002** |
| `!ping` / `!help` / `!cost` | — | ~$0.0002 | — | **~$0.0002** |

`!post` dominates cost; non-AI commands are effectively free. A daily token
budget (`DAILY_TOKEN_BUDGET=50000`, ≈ 150 narratives/day) short-circuits the
LLM call if exceeded.

## Who it's for

Three canonical personas driving scope (from the product decks):

| Persona | Off-grid work | Wins with |
|---|---|---|
| **Natalie** — field botanist, Eastern Sierra | 10–15 days/mo at 8–13k ft | `!post` auto-journals; `!mail lab@…` attaches coordinates, elevation, and weather to specimen-ID requests |
| **Marcus** — expedition guide, PNW / Alaska / Patagonia | 8–12 day trips, 6–10 clients | Evening `!post` publishes to a private expedition blog families follow |
| **Yuki** — solo bikepacker and storyteller, Iceland / Mongolia | 3–6 week trips | Blog never goes dark; real-time narrative without café data-entry days |

## Stack

| Component | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| Language | TypeScript (strict, ESM) |
| HTTP | Hono |
| Validation | zod |
| State (α) | Cloudflare KV — four namespaces |
| Testing | Vitest + Miniflare |
| Deploy | Wrangler via GitHub Actions |
| Package manager | pnpm 9 |

## Quick start

Prerequisites: Node ≥ 20, pnpm 9+ (via corepack), a Cloudflare account, and
a Garmin **inReach Professional** plan — IPC Outbound + Inbound APIs are not
available on consumer plans. See [`docs/PRD.md`](docs/PRD.md) §8 for the
tier-requirement rationale.

```bash
pnpm install
cp .dev.vars.example .dev.vars          # fill in secrets
pnpm test                                # 24 tests, 2 files
pnpm dev                                 # wrangler dev (local worker)
```

Provisioning (KV namespaces, Wrangler secrets, staging + production
environments) is documented in
[`docs/setup-cloudflare.md`](docs/setup-cloudflare.md). Garmin Portal Connect
configuration (bearer token, X-API-Key, IMEI) is in
[`docs/garmin-setup.md`](docs/garmin-setup.md).

On the device, save **`trailscribe@tx.trailscribe.net`** once as a contact
named `TrailScribe` and pick it as the recipient for every `!command`. Keep
the per-message *Include Location* toggle off — the Worker reads GPS from the
webhook payload, so the device-side share is redundant. Full rationale in
[`docs/garmin-setup.md`](docs/garmin-setup.md) §3a.

```bash
pnpm deploy:staging                      # wrangler deploy --env staging
pnpm deploy:prod                         # wrangler deploy --env production
```

Pushes to `staging/**` branches auto-deploy to staging, and pushes to `main`
auto-deploy to production, via
[`.github/workflows/deploy-cloudflare.yml`](.github/workflows/deploy-cloudflare.yml).
A manual `workflow_dispatch` is also available for either target.

## Documentation

| Doc | Contents |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | **Canonical product + engineering spec** (signed 2026-04-22). Start here. |
| [`docs/architecture.md`](docs/architecture.md) | Full system diagram, module map, data contracts |
| [`docs/setup-cloudflare.md`](docs/setup-cloudflare.md) | Provisioning walkthrough — KV, secrets, envs |
| [`docs/garmin-setup.md`](docs/garmin-setup.md) | Portal Connect config, Professional-tier prerequisites |
| [`docs/field-commands.md`](docs/field-commands.md) | Command UX reference (including deferred verbs) |
| [`plans/phase-0-scaffolding.md`](plans/phase-0-scaffolding.md) | Current-milestone sprint plan |

Earlier Pipedream and self-hosted n8n deployment paths are archived under
[`docs/archive/`](docs/archive/) — kept for reference, not maintained.

## License

MIT. See [`LICENSE`](LICENSE); [`SECURITY.md`](SECURITY.md),
[`CONTRIBUTING.md`](CONTRIBUTING.md), and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) live at the repo root.
