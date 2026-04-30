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
clear view of the sky. **No phone, no cell signal, no Wi-Fi required.**

> ⚠️ **Requires a Garmin inReach Professional plan.** TrailScribe is built on
> Garmin's IPC Outbound + Inbound APIs, which are only exposed on the
> [Professional subscription tier](https://www.garmin.com/en-US/p/837481/pn/010-D2242-SU/)
> — not consumer inReach plans. Plans start around $20/month.

> 🛰️ **Live progress + open issues:** [project board](https://github.com/users/brockamer/projects/3)
> · roadmap arc in [`docs/PRD.md`](docs/PRD.md) §9

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

## What you might use it for

The personas above are the ones we designed against, but the architecture is
deliberately general — anything you can do in 160 characters, from a place
with sky, can become a command. A few directions worth imagining:

- **Long-distance hiker.** Your trail journal updates from the trail itself.
  Your family knows you're alive *and* what you saw today, not just a dot on
  a map. A `!todo "resupply box, Echo Lake"` from mile 1,400 lands in your
  task manager before you forget.
- **Sailing or expedition crew on a passage.** Daily noon-position email to
  the shore team is one `!blast`. Weather query before a tack is one
  `!weather`. The whole trip log builds itself in a journal you don't open
  until landfall.
- **Disaster-response volunteer when local cell is out.** File structured
  incident reports — location, observation, severity, time — to a coordinator
  who's still online. Not a replacement for radio nets; a complement to them.
- **Rural rancher or property caretaker.** From the far corner of a 5,000-acre
  spread: log a fence break, a water-tank reading, a coyote sighting. The
  ranch task list updates without the drive back to the house.
- **Wildlife biologist or conservation surveyor.** Geotag sightings into a
  shared dataset as you walk a transect. Collaborators see the data appear in
  real time. Specimen photos go up via `!postimg`.
- **Field journalist in a remote area.** File dispatches by satellite — pull
  quotes by email to an editor, full piece to a public journal site, all
  without ever touching a laptop until you're back on a power grid.

The general shape: anywhere a short piece of structured text from the field
needs to fan out into the connected world, TrailScribe is a 160-character
adapter. The command set is open-ended — if a verb you want isn't there, it's
a parser change and a tool adapter, not a redesign. Open an issue with the
use case and we'll talk about it.

## What it costs

Design target: **under $0.05 per transaction, ~$0.03 typical**. Cheaper than
a single premium satellite message in most plans. The dominant cost is the
AI call on `!post`/`!postimg`/`!ai`/`!camp`/`!brief`; non-AI commands are
effectively free.

A daily token budget caps spend at a configurable ceiling (default
≈150 narratives/day) and short-circuits AI calls when exceeded so a runaway
prompt can't drain the wallet. Per-transaction cost detail is in
[`docs/PRD.md`](docs/PRD.md) §6.

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
- **Single-operator by design — for now.** Today the architecture is sized
  for one IMEI in the allowlist. Multi-tenant is a question for later phases
  (see the engineering details below); the patterns are already in place to
  grow into it.

---

## Help build it

TrailScribe is a personal project built mostly by one operator — a 20-year
sysadmin learning modern serverless patterns — in close collaboration with
Claude Code. It works end-to-end on production today, but it's at the stage
where having other humans in the codebase would change the shape of the
project for the better: different angles on the architecture, code-review
habits that don't form when you're alone, design conversations that go
places a single contributor and an AI can't reach.

**If any of these sound like you, say hi:**

- You've built on Cloudflare Workers / Durable Objects / D1 in production and
  want to see how a small project applies them.
- You've worked with LLMs under tight character budgets and want to push the
  prompt engineering further.
- You own an inReach (or any Iridium-tier satellite communicator) and want a
  real-world test environment.
- You like teaching — code review on a small repo where the maintainer is
  *explicitly* trying to learn from collaborators.
- You have a use case the personas don't cover and you want it to work.

Where to start:

1. Skim the [project board](https://github.com/users/brockamer/projects/3)
   — issues marked **Up Next** or **help wanted** are the best entry points.
2. For larger pieces of work, open an issue first so we can shape it
   together. The bigger the change, the earlier the conversation.
3. Conventions, branch model, and the PR-per-change discipline are in
   [`CONTRIBUTING.md`](CONTRIBUTING.md). Every change in this repo lands as
   its own squash-merged PR; the commit log doubles as project history.
4. Code of conduct lives in [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md);
   security policy in [`SECURITY.md`](SECURITY.md).

---

<details>
<summary><b>Engineering details</b> — architecture, status, stack, quick start, roadmap</summary>

### Status

- **Phase 0** (Workers scaffold) — shipped 2026-04-24
- **Phase 1** (α-MVP, six commands) — shipped 2026-04-27
- **Production-readiness** (auto-deploy, device-side conventions) — shipped 2026-04-28
- **Phase 2** (extended command set + `!postimg`) — shipped 2026-04-29
- **Phase 2.5** (UX polish: intercept policy, `!mail` short keys, bare `!post`) — in flight, milestone #6
- **Phase 3** (storage migration: KV → Durable Objects + D1) — next infra phase, epic [#99](https://github.com/brockamer/trailscribe/issues/99)
- **Phase 4** (`!snap`, `!call`) — telemetry-only journal posts and a PSTN voice-bridge command, milestone #7

Live state and open issues: [project board](https://github.com/users/brockamer/projects/3).
Long-form roadmap rationale in [`docs/PRD.md`](docs/PRD.md) §9.

### Under the hood

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
key-value store; **Durable Objects** (single-instance stateful Workers that
serialize writes per object — like a tiny single-threaded server with
attached storage, one per IMEI) and **D1** (Cloudflare's serverless SQLite)
are filed for the Phase 3 migration when KV's eventual consistency or
list-scan ledger queries actually start to bite. Full architecture in
[`docs/architecture.md`](docs/architecture.md) and
[`docs/PRD.md`](docs/PRD.md) §3.

### Stack

| Component | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| Language | TypeScript (strict, ESM) |
| HTTP | Hono |
| Validation | zod |
| State | Cloudflare KV — four namespaces (DO + D1 in Phase 3) |
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
a [Garmin **inReach Professional** plan](https://www.garmin.com/en-US/p/837481/pn/010-D2242-SU/)
— the IPC Outbound + Inbound APIs this depends on are not exposed on
consumer plans. See [`docs/PRD.md`](docs/PRD.md) §8 for the tier-requirement
rationale.

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

</details>

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
