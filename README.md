# TrailScribe

**Your AI on the other end of the satellite link.**

A Garmin inReach is a tiny black radio that can send 160 characters at a time
to the Iridium satellite network. It will keep you alive in country where cell
towers don't reach. What it *won't* do is help you write a journal entry,
send your wife an email with your coordinates and tomorrow's weather, file a
task in your task manager, or look something up. It's a panic button with a
keyboard.

TrailScribe sits on the other end of the satellite link and turns that
keyboard into a command line for the rest of your workflow. You type a short
`!command` from a ridge in the Brooks Range; a tiny serverless program in the
cloud — a *Cloudflare Worker*, basically a function that wakes up to handle
each message and goes back to sleep — receives it, figures out where you are,
checks the weather if it matters, calls a large language model where that
helps, performs the actual action (sends the email, posts the journal entry,
files the task), and writes back to your device in two SMS or fewer.

You get the leverage of a full software stack — AI, email, journaling, task
management — through a 160-character window, anywhere on Earth that has a
clear view of the sky.

---

## What you can do from the device

Every command is a single short message starting with `!`. You send it to a
contact saved on the device as `TrailScribe`. The reply comes back as one or
two SMS, capped at 320 characters total. Anything longer (a full journal
post, a long AI answer, a multi-recipient email confirmation) goes to email
or the journal site, and the device gets a short pointer.

| Command | What it does |
|---|---|
| `!post <note>` | Turns a short note + your GPS into a titled, geotagged journal entry — the AI writes the narrative, the entry gets committed to a public-or-private GitHub Pages site, and the reply links to the live URL. |
| `!postimg <caption>` | Same as `!post`, plus an AI-generated header image rendered on the spot from your caption. |
| `!mail to:_ subj:_ body:_` | Sends an email with your coordinates, place name, elevation, and current weather appended automatically. |
| `!share to:<alias\|email> <note>` | One-off enriched email to one person, with location appended. Aliases (`home`, `lab`, etc.) are pre-configured. |
| `!blast <note>` | Same as `!share`, but to a pre-configured `all` group — broadcast to your trip-watch list in one shot. |
| `!todo <task>` | Creates a task in Todoist with the current GPS + timestamp in the note. |
| `!drop <note>` | Quietly appends a structured observation (note + GPS + time) to a personal field log. No email, no AI, just a tap to remember something. |
| `!brief [Nd]` | AI summary of the last 24h (or N days) of `!drop` entries, distilled to fit two SMS. |
| `!ai <question>` | Open-ended Q&A with the AI. Two-SMS answer for short questions; longer answers go to email. |
| `!camp <query>` | AI lookup specifically for outdoors knowledge — camping, water sources, terrain features. |
| `!where` | Reverse-geocodes your current GPS into a human place name plus a Google Maps link. |
| `!weather` | Current conditions for your GPS fix — temperature, wind, sky. |
| `!ping` / `!help` / `!cost` | Health check, command list, month-to-date spend. |

The full grammar reference, including edge cases and the no-GPS-fix path,
lives in [`docs/field-commands.md`](docs/field-commands.md).

## Who it's for

| Persona | Off-grid work | What unlocks for them |
|---|---|---|
| **Natalie** — field botanist, Eastern Sierra | 10–15 days/mo at 8–13k ft | `!post` auto-journals each plot; `!mail lab@…` attaches coordinates, elevation, and weather to specimen-ID requests without burning a rest day in town. |
| **Marcus** — expedition guide, PNW / Alaska / Patagonia | 8–12 day trips, 6–10 clients | Evening `!post` publishes to a private expedition blog families follow in real time; `!blast` keeps the trip-watch list synchronized. |
| **Yuki** — solo bikepacker and storyteller, Iceland / Mongolia | 3–6 week trips | The blog never goes dark; real-time narrative without café data-entry days. `!postimg` gives the journal a visual identity from the field. |

## What it costs

Design target: **under $0.05 per transaction, ~$0.03 typical**. Cheaper than
a single premium satellite message in most plans. The dominant cost is the
AI call on `!post`/`!postimg`/`!ai`/`!camp`/`!brief`; non-AI commands are
effectively free.

A daily token budget caps spend at a configurable ceiling (default
≈150 narratives/day) and short-circuits AI calls when exceeded so a runaway
prompt can't drain the wallet. Per-transaction cost detail is in
[`docs/PRD.md`](docs/PRD.md) §6.

## Status

α-MVP and the Phase 2 extended command set are shipped end-to-end on
production. Live progress is on the
[project board](https://github.com/users/brockamer/projects/3); current-state
specifics live in [`CLAUDE.md`](CLAUDE.md) and the PRD.

## Why this works

Satellite messengers were designed for one thing: getting a short message out
when nothing else can. TrailScribe respects that — it never enlarges the
device's job, it enlarges what *the message* can mean. The 160-character
window stays the window; behind it sits a real serverless backend that can
do anything a normal app can do. The device gets a one- or two-SMS
confirmation; the heavy work (writing the narrative, formatting the email,
generating the image, summarizing the field log) happens in the cloud and
ships out through whatever channel the recipient is actually on — email,
the public web, your task manager.

The tradeoffs:

- **Reply budget is sacred.** Every reply ≤320 characters. Longer content
  goes to email or the journal; the device sees a pointer. There is no path
  where the device gets paginated walls of text.
- **Not a safety system.** SOS goes through Garmin's native button to
  IERCC/GEOS, not TrailScribe.
- **Single-operator by design.** This is a personal project — one IMEI in
  the allowlist, one operator, no β-launch. The architecture is sized
  accordingly.

---

## Under the hood

```
  inReach                           Cloudflare Worker (Hono)
  ───────                           ─────────────────────────
   !post … ──HTTPS──▶  POST /garmin/ipc
                       1. verify  X-Outbound-Auth-Token
                       2. IMEI allowlist
                       3. dedupe (KV, 48 h TTL)
                       4. dispatch to orchestrator
                          └─▶ geocode · weather · LLM
                              └─▶ GitHub Pages · Todoist · Resend
                       5. return 200 OK  (always — see below)
                                   │
   ◄─ ≤ 2 SMS ─ Garmin IPC Inbound  ◄─ reply (≤ 160 chars × 2)
```

The always-200 rule is non-negotiable. Garmin retries non-200 responses at
2 / 4 / 8 / 16 / 32 / 64 / 128 seconds, then pauses 12h × 5 days before
suspending the integration. App-level errors surface through the IPC Inbound
reply (`"Error: Todoist auth failed"`) — never as an HTTP error back to
Garmin. Idempotency is enforced by hashing
`imei + timeStamp + messageCode + content_hash` and short-circuiting
replays at both the orchestrator and per-command storage layers.

State lives in four Cloudflare KV namespaces — `TS_IDEMPOTENCY` (48h TTL),
`TS_LEDGER` (monthly rollup), `TS_CONTEXT` (per-IMEI rolling window),
`TS_CACHE` (geocode + weather). KV is Cloudflare's globally-replicated
key-value store; Durable Objects (single-machine state with strong
consistency) and D1 (serverless SQLite) are filed for a future Phase 3
migration when KV's eventual consistency or list-scan ledger queries
actually start to bite. Full architecture in
[`docs/architecture.md`](docs/architecture.md) and
[`docs/PRD.md`](docs/PRD.md) §3.

### Stack

| Component | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| Language | TypeScript (strict, ESM) |
| HTTP | Hono |
| Validation | zod |
| State | Cloudflare KV — four namespaces |
| LLM | OpenRouter → `anthropic/claude-sonnet-4-6` |
| Image-gen | Replicate Flux schnell (`!postimg` only) |
| Email | Resend |
| Journal | GitHub Pages via Contents API |
| Tasks | Todoist REST API |
| Geocoding | Nominatim (cached) |
| Weather | Open-Meteo (cached) |
| Testing | Vitest + Miniflare |
| Deploy | Wrangler via GitHub Actions |
| Package manager | pnpm 9 |

### Quick start

Prerequisites: Node ≥ 20, pnpm 9+ (via corepack), a Cloudflare account, and
a Garmin **inReach Professional** plan — the IPC Outbound + Inbound APIs
this depends on are not exposed on consumer plans. See
[`docs/PRD.md`](docs/PRD.md) §8 for the tier-requirement rationale.

```bash
pnpm install
cp .dev.vars.example .dev.vars          # fill in secrets
pnpm test                                # Vitest + Miniflare
pnpm dev                                 # wrangler dev (local worker)
```

Provisioning (KV namespaces, Wrangler secrets, staging + production
environments) is in
[`docs/setup-cloudflare.md`](docs/setup-cloudflare.md). Garmin Portal Connect
configuration (bearer token, X-API-Key, IMEI) is in
[`docs/garmin-setup.md`](docs/garmin-setup.md).

On the device, save **`trailscribe@tx.trailscribe.net`** once as a contact
named `TrailScribe` and pick it as the recipient for every `!command`. Keep
the per-message *Include Location* toggle off — the Worker reads GPS from
the webhook payload, so the device-side share is redundant. Full rationale
in [`docs/garmin-setup.md`](docs/garmin-setup.md) §3a.

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
| [`docs/PRD.md`](docs/PRD.md) | **Canonical product + engineering spec.** Start here for any non-trivial change. |
| [`docs/architecture.md`](docs/architecture.md) | Full system diagram, module map, data contracts |
| [`docs/setup-cloudflare.md`](docs/setup-cloudflare.md) | Provisioning walkthrough — KV, secrets, envs |
| [`docs/garmin-setup.md`](docs/garmin-setup.md) | Portal Connect config, Professional-tier prerequisites |
| [`docs/field-commands.md`](docs/field-commands.md) | Command UX reference — every command, every edge case |
| [`docs/project-board.md`](docs/project-board.md) | How the project board works |
| [`plans/`](plans/) | Active and archived sprint plans |

Earlier Pipedream and self-hosted n8n deployment paths are archived under
[`docs/archive/`](docs/archive/) — kept for reference, not maintained.

## License

MIT. See [`LICENSE`](LICENSE); [`SECURITY.md`](SECURITY.md),
[`CONTRIBUTING.md`](CONTRIBUTING.md), and
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) live at the repo root.
