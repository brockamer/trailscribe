# TrailScribe — Project Context

Living context file for Claude Code. Keep concise; update as decisions are made.

**Canonical PRD:** `docs/PRD.md` (source of truth for product scope, architecture, and phased plan — read it first).
**Input materials:** `materials/` (PDFs + spec + deep research report + Garmin IPC docs — read via `materials/*.txt` for extracted text).

## Commands

- `pnpm dev` — `wrangler dev` local Worker
- `pnpm test` / `pnpm test:watch` — Vitest
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` / `pnpm format`
- `pnpm deploy:staging` / `pnpm deploy:prod`

## Product

**TrailScribe** is an AI-native serverless agent that turns a Garmin inReach into a command interface for enriched off-grid workflows. User sends short `!command` messages; a Cloudflare Worker parses them, enriches with context (place names, weather, map links), runs an LLM where appropriate, invokes tools (Resend, Todoist, GitHub Pages), and replies via Garmin IPC Inbound in ≤2 SMS.

- **Personas (canonical, from product decks):** Natalie (field botanist, Eastern Sierra), Marcus (expedition guide, PNW/Alaska/Patagonia), Yuki (solo bikepacker/storyteller, Iceland/Mongolia/Patagonia). See PRD §1.
- **Hard constraints:** Garmin IPC Inbound messages are 160 chars max. Reply budget 320 chars (two SMS). Idempotency matters — Garmin retries 2/4/8/16/32/64/128s then pauses 12h × 5d.
- **Cost target:** <$0.05 per transaction, $0.03 typical. Dominated by the LLM on `!post`; non-AI commands are effectively free.
- **Not a safety system.** SOS must go through Garmin native.

## Command grammar

**α-MVP (6 commands):** `!post <note>`, `!mail to:_ subj:_ body:_`, `!todo <task>`, `!ping`, `!help`, `!cost`.

**Deferred (13-cmd original set is post-MVP):** `!where`, `!weather` (P2), `!drop`, `!brief` (P2), `!ai`, `!camp` (P3), `!blast`, `!share` (P4). Reasons in PRD §2.

Parser is in `src/core/grammar.ts` (salvaged per Verdict B).

## Tech stack

- **Runtime:** Cloudflare Workers (TS, strict, ESM)
- **HTTP:** Hono (not Express)
- **Validation:** zod
- **Storage:** Cloudflare KV (bindings: `TS_IDEMPOTENCY`, `TS_LEDGER`, `TS_CONTEXT`, `TS_CACHE`). Durable Objects + D1 in later phases.
- **Testing:** Vitest + Miniflare (not Jest)
- **Deploy:** Wrangler; `deploy-cloudflare.yml` GitHub Action
- **Package mgr:** pnpm
- **Formatting/lint:** ESLint + Prettier

## Architecture

```
src/
  index.ts                      # Worker entry; exports fetch; binds env
  env.ts                        # zod schema; typed env (Workers bindings + secrets)
  core/
    grammar.ts                  # !command parser (salvaged, subset for MVP)
    types.ts                    # ParsedCommand, GarminEvent, TrailContext, LedgerEntry
    orchestrator.ts             # dispatch + checkpointed sub-ops + budget gate
    narrative.ts                # LLM JSON-mode → { title, haiku, body }
    context.ts                  # rolling window of recent positions/messages per IMEI
    ledger.ts                   # KV-backed ledger; real LLM token usage
    links.ts                    # Google Maps + MapShare link builders (salvaged)
  adapters/
    inbound/hono-worker.ts      # POST /garmin/ipc; bearer auth; IMEI allowlist; idempotency
    outbound/garmin-ipc-inbound.ts # POST /api/Messaging/Message; X-API-Key
    mail/resend.ts              # Resend transactional email API (was mail/gmail.ts in spec)
    tasks/todoist.ts            # real Todoist REST API
    publish/github-pages.ts     # commit markdown to journal repo via GitHub Contents API (was publish/posthaven.ts)
    location/geocode.ts         # Nominatim, cached
    location/weather.ts         # Open-Meteo, cached
    ai/openrouter.ts            # OpenRouter wrapper; real usage
    storage/kv.ts               # typed KV helpers
    logging/worker-logs.ts      # structured JSON logfmt
tests/                          # Vitest + Miniflare; fixtures/ for Garmin events
docs/
  PRD.md                        # canonical product/engineering spec
  architecture.md               # updated for Workers
  garmin-setup.md               # updated for IPC Outbound bearer + IPC Inbound X-API-Key
  field-commands.md             # MVP + deferred cmds (operator-facing reference)
  archive/                      # old Pipedream/n8n/Workers-minimal docs (deprecated but kept for ref)
materials/                      # input PDFs + extracted txt; don't edit
plans/                          # per-milestone sprint plans (active: phase-2-extended-commands.md; archived under archived/2026-MM/)
```

## Status

- **Phase 0 — Workers scaffold:** complete 2026-04-24. All 20 P0 stories shipped.
- **Phase 1 — α-MVP:** complete 2026-04-27. Epic #30 closed 2026-04-26; close gate #111 (production traffic turn-on with the Mini 3 Plus against the production Worker) verified 2026-04-27. All 6 commands (`!post`, `!mail`, `!todo`, `!ping`, `!help`, `!cost`) return real responses on production; replay verification + cost measurement complete; OpenRouter LLM layer live (`anthropic/claude-sonnet-4-6`). Plan archived at `plans/archived/2026-04/phase-1-alpha-mvp.md`.
- **Production-readiness:** complete 2026-04-28. All 8 milestone issues closed: shipped #32, #33 (auto-deploy on push to main re-enabled in #126), #121 (device-side recipient + Include-Location convention pinned in #127); closed-as-not-planned #14, #15, #26 (operator scope decision: personal-project housekeeping, no custom domain).
- **Phase 2 — extended commands + `!postimg`:** complete 2026-04-29. All 9 commands shipped end-to-end on production (`!where`, `!weather`, `!drop`, `!brief`, `!ai`, `!camp`, `!share`, `!blast`, `!postimg`); P2-15 staging burn-in PASSED (84 ledger entries, idempotency confirmed). Epic #98 closed; sub-issues #112–#119 + #125 closed via PR-merge auto-close. Plan archived at `plans/archived/2026-04/phase-2-extended-commands.md`. Real-device verification (P2-16) pending operator + Mini.
- **Phase 3 — DO + D1 migration:** filed as epic #99 (Low-priority Backlog). Active phase candidate now that Phase 2 has closed.

## Conventions

- **Strict TS**, JSDoc on exported functions, short focused functions.
- **Reply budget:** total outgoing ≤320 chars including the cost suffix (when `APPEND_COST_SUFFIX=true`).
- **Idempotency key:** `sha256(imei + ":" + timeStamp + ":" + messageCode + ":" + content_hash)` — Garmin has no `msgId` field, so we derive a composite key (see PRD §5).
- **Intercept policy (PRD §8 D10):** non-`!`-prefixed device messages are silent-dropped at the webhook (200 OK, no IPC Inbound reply, structured `intercept_skipped` log). `!`-prefixed unknowns still get `"Try !help"`. Operator's casual messages to friends/family bypass TrailScribe entirely.
- **Env:** validated via zod schema in `src/env.ts`; access via typed `Env` binding in Worker handlers.
- **Tool adapters** live in `src/adapters/*` and accept `{ ...args, env: Env }`.

## Locked decisions (2026-04-22)

- **D1 Inbound auth:** static bearer token (`GARMIN_INBOUND_TOKEN`)
- **D2 Pro tier:** YES — full IPC path enabled
- **D3 Schema:** V2 (tolerate V3/V4)
- **D4 Token budget:** 50,000/day
- **D6 Reply:** IPC Inbound primary + email fallback (fallback gated by D9)
- **D7 Branch:** rename `master` → `main` at Phase 0
- **Model:** `anthropic/claude-sonnet-4-6` via OpenRouter (per #31; supersedes the original direct-OpenAI `claude-sonnet-4-6` decision)

## Also locked (2026-04-22)

- **D5 Blog platform:** GitHub Pages + markdown commits via GitHub Contents API. Dedicated journal repo. Theme chosen at Phase 0.
- **D8 Outbound email:** Resend (`trailscribe@resend.dev` for α).
- **D9 Email-fallback reply:** skipped for α.

## External services

**Secrets (Wrangler Secrets):**
- `GARMIN_INBOUND_TOKEN` — static token; verify `X-Outbound-Auth-Token: <token>` on Outbound webhooks (Garmin sends raw token in custom header, not standard `Authorization: Bearer`)
- `GARMIN_IPC_INBOUND_API_KEY` — `X-API-Key` for Garmin IPC Inbound
- `GARMIN_IPC_INBOUND_BASE_URL` — per-tenant; **host only, no path** (e.g. `https://ipcinbound.inreachapp.com`). Code appends `/api/Messaging/Message`. Found in Garmin Explore → IPC → Inbound Settings → "Inbound URL".
- `IMEI_ALLOWLIST` — comma-sep accepted IMEIs (defense-in-depth)
- `LLM_API_KEY` — OpenRouter API key (provider-neutral; supersedes `OPENAI_API_KEY` per #31)
- `TODOIST_API_TOKEN`
- `RESEND_API_KEY` — outbound email transactional
- `GITHUB_JOURNAL_TOKEN` — fine-grained PAT with `contents:write` on journal repo
- `GITHUB_JOURNAL_REPO` — e.g. `brockamer/trailscribe-journal`
- `GITHUB_JOURNAL_BRANCH` — `main`
- `IMAGE_API_KEY` — image-gen provider API key (Replicate token in α; `!postimg` only)
- `ADDRESS_BOOK_JSON` — alias map for `!share`/`!blast` (Phase 2; e.g. `{"aliases":{"home":"...","all":"a@x,b@y"}}`)

**Vars (non-secret):**
- `TRAILSCRIBE_ENV` — dev/staging/production
- `GOOGLE_MAPS_BASE`, `MAPSHARE_BASE` — link prefixes
- `LLM_BASE_URL` — `https://openrouter.ai/api/v1` (override for direct-provider routing)
- `LLM_MODEL` — `anthropic/claude-sonnet-4-6` (OpenRouter format `<provider>/<model>`)
- `LLM_INPUT_COST_PER_1K` / `LLM_OUTPUT_COST_PER_1K` — ledger pricing; set from the chosen model provider's pricing page
- `LLM_PROVIDER_HEADERS_JSON` — optional JSON blob for OpenRouter `HTTP-Referer` + `X-Title` analytics headers
- `APPEND_COST_SUFFIX` — bool (α default: false)
- `DAILY_TOKEN_BUDGET` — `50000`
- `IPC_SCHEMA_VERSION` — `"2"`
- `IPC_INBOUND_SENDER` — `Sender` field for outbound IPC Inbound messages (the on-device "From" string); defaults to `RESEND_FROM_EMAIL` but decoupled
- `RESEND_FROM_EMAIL` — e.g. `trailscribe@resend.dev`
- `RESEND_FROM_NAME` — e.g. `TrailScribe`
- `JOURNAL_POST_PATH_TEMPLATE` — e.g. `_posts/{yyyy}-{mm}-{dd}-{slug}.md`
- `JOURNAL_URL_TEMPLATE` — public URL pattern for committed posts; pinned by P1-20
- `IMAGE_PROVIDER` — `replicate` for α (P2-17; `!postimg`)
- `IMAGE_MODEL` — e.g. `black-forest-labs/flux-schnell`
- `IMAGE_COST_PER_CALL_USD` — ledger pricing for image-gen; default `0.01`
- `JOURNAL_IMAGE_PATH_TEMPLATE` — e.g. `assets/images/{yyyy}-{mm}-{dd}-{slug}.{ext}` (commits the binary alongside the markdown post; non-underscore so Jekyll serves it)

## Garmin IPC quick-ref (authoritative sources in `materials/`)

- **IPC Outbound v2.0.8** (device → us): HTTPS POST. Schema V2/V3/V4 (α uses V2). Fields we need: `imei` (15-digit), `messageCode` (3=Free Text), `freeText`, `timeStamp` (ms epoch), `point{latitude,longitude,altitude}`, `addresses[]`, `status{lowBattery,...}`. Auth via OAuth bearer OR static token (α uses static bearer). **Must respond 200** or Garmin retries at 2/4/8/16/32/64/128s then 12h pauses × 5 days → suspension.
- **IPC Inbound v3.1.1** (us → device): POST `{base}/api/Messaging/Message`. Auth: `X-API-Key` header. Body: `{ Messages: [{ Recipients: [imei], Sender, Timestamp: "/Date(ms)/", Message }] }`. **Message body 160 chars MAX** (Iridium hard limit — 422 on overage). Returns `{ count: N }`.
- **Tier requirement:** IPC Outbound + Inbound are **Professional/Enterprise only**. Consumer inReach does not expose these APIs — gates the whole architecture (see PRD §8 D2).

## Workflow

- **jared** manages the board: https://github.com/users/brockamer/projects/3 (see `docs/project-board.md`).
- No active plan (Phase 2 closed 2026-04-29; archived at `plans/archived/2026-04/phase-2-extended-commands.md`). Phase 3 (DO + D1, epic #99) is the next promotion candidate.
- Git: `origin` = `https://github.com/brockamer/trailscribe.git`, default branch `main`.
- Commit sign-off: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

## Ground rules

- **PRD is canonical.** No scope creep without PRD update + sign-off.
- **No new env vars, services, or dependencies** without PRD justification.
- **Reply budget is sacred:** ≤320 chars out (incl. cost suffix if enabled). Longer content goes to email/blog.
- **Serverless ephemerality:** all state in KV (or later DO/D1). No in-memory idempotency/ledger.
- **Auth before processing:** verify `GARMIN_INBOUND_TOKEN` bearer on every Outbound webhook; IMEI must be in allowlist.
- **Never commit secrets.** Wrangler Secrets only. `.dev.vars` gitignored; `.dev.vars.example` tracked.
- **Salvage aggressively per Verdict B:** keep grammar, `ParsedCommand`, env schema shape, docs, link builders. Rebuild tool adapters, idempotency/ledger stores, Garmin adapters, webhook auth.
- **Test seams with fixtures** (`tests/fixtures/` with recorded Garmin event payloads), not mocks of Garmin's API shape.

## Useful files to read first

1. `docs/PRD.md` — canonical product/engineering spec (sign-off pending)
2. `materials/TrailScribe_ Your AI Companion for Off-Grid Adventures.pptx.txt` — personas + product vision
3. `materials/TrailScribe Deep Research Report.txt` — architecture rationale (Workers, phased KV→DO→D1)
4. `materials/Garmin IPC Outbound.txt` — Outbound webhook contract (auth, schema, retry)
5. `materials/Garmin IPC Inbound.txt` — Inbound API contract (X-API-Key, 160-char limit, error codes)
6. `src/agent/grammar.ts` — salvage target for command parser
7. `docs/field-commands.md` — command UX reference (13 cmds; α uses 6)
