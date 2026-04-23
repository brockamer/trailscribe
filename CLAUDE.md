# TrailScribe — Project Context

Living context file for Claude Code. Keep concise; update as decisions are made.

**Canonical PRD:** `docs/PRD.md` (source of truth for product scope, architecture, and phased plan — read it first).
**Input materials:** `materials/` (PDFs + spec + deep research report + Garmin IPC docs — read via `materials/*.txt` for extracted text).

## Product

**TrailScribe** is an AI-native serverless agent that turns a Garmin inReach into a command interface for enriched off-grid workflows. User sends short `!command` messages; a Cloudflare Worker parses them, enriches with context (place names, weather, map links), runs an LLM where appropriate, invokes tools (Gmail, Todoist, Posthaven), and replies via Garmin IPC Inbound in ≤2 SMS.

- **Personas (canonical, from product decks):** Natalie (field botanist, Eastern Sierra), Marcus (expedition guide, PNW/Alaska/Patagonia), Yuki (solo bikepacker/storyteller, Iceland/Mongolia/Patagonia). See PRD §1.
- **Hard constraints:** Garmin IPC Inbound messages are 160 chars max. Reply budget 320 chars (two SMS). Idempotency matters — Garmin retries 2/4/8/16/32/64/128s then pauses 12h × 5d.
- **Cost target:** <$0.05 per transaction, $0.03 typical. Dominated by OpenAI on `!post`; non-AI commands are effectively free.
- **Not a safety system.** SOS must go through Garmin native.

## Command grammar

**α-MVP (6 commands):** `!post <note>`, `!mail to:_ subj:_ body:_`, `!todo <task>`, `!ping`, `!help`, `!cost`.

**Deferred (13-cmd original set is post-MVP):** `!where`, `!weather` (P2), `!drop`, `!brief` (P2), `!ai`, `!camp` (P3), `!blast`, `!share` (P4). Reasons in PRD §2.

Parser lives in `src/agent/grammar.ts` today; will move to `src/core/grammar.ts` in Phase 0 rebuild (salvaged per Verdict B).

## Tech stack (target — Phase 0 rebuild)

- **Runtime:** Cloudflare Workers (TS, strict, ESM)
- **HTTP:** Hono (not Express)
- **Validation:** zod
- **Storage:** Cloudflare KV (bindings: `TS_IDEMPOTENCY`, `TS_LEDGER`, `TS_CONTEXT`, `TS_CACHE`). Durable Objects + D1 in later phases.
- **Testing:** Vitest + Miniflare (not Jest)
- **Deploy:** Wrangler; `deploy-cloudflare.yml` GitHub Action
- **Package mgr:** pnpm
- **Formatting/lint:** ESLint + Prettier

**Existing repo (pre-rebuild):** Node 18 / ESM / Express / Jest. Being replaced; salvage grammar, `ParsedCommand` type, `links.ts`, zod env pattern, docs.

## Architecture (target module map — Phase 0+)

```
src/
  index.ts                      # Worker entry; exports fetch; binds env
  env.ts                        # zod schema; typed env (Workers bindings + secrets)
  core/
    grammar.ts                  # !command parser (salvaged, subset for MVP)
    types.ts                    # ParsedCommand, GarminEvent, TrailContext, LedgerEntry
    orchestrator.ts             # dispatch + checkpointed sub-ops + budget gate
    narrative.ts                # OpenAI JSON-mode → { title, haiku, body }
    context.ts                  # rolling window of recent positions/messages per IMEI
    ledger.ts                   # KV-backed ledger; real OpenAI token usage
    links.ts                    # Google Maps + MapShare link builders (salvaged)
  adapters/
    inbound/hono-worker.ts      # POST /garmin/ipc; bearer auth; IMEI allowlist; idempotency
    outbound/garmin-ipc-inbound.ts # POST /api/Messaging/Message; X-API-Key
    mail/resend.ts              # Resend transactional email API (was mail/gmail.ts in spec)
    tasks/todoist.ts            # real Todoist REST API
    publish/github-pages.ts     # commit markdown to journal repo via GitHub Contents API (was publish/posthaven.ts)
    location/geocode.ts         # Nominatim, cached
    location/weather.ts         # Open-Meteo, cached
    ai/openai.ts                # OpenAI wrapper; real usage
    storage/kv.ts               # typed KV helpers
    logging/worker-logs.ts      # structured JSON logfmt
tests/                          # Vitest + Miniflare; fixtures/ for Garmin events
docs/
  PRD.md                        # canonical product/engineering spec
  architecture.md               # updated for Workers
  garmin-setup.md               # updated for IPC Outbound bearer + IPC Inbound X-API-Key
  commands.md                   # MVP + deferred cmds
  archive/                      # old Pipedream/n8n/Workers-minimal docs (deprecated but kept for ref)
materials/                      # input PDFs + extracted txt; don't edit
plans/                          # per-milestone sprint plans (phase-0-scaffolding.md, etc.)
```

## Status (as of 2026-04-22)

**Phase:** PRD drafted (`docs/PRD.md`). Awaiting sign-off on 9 decisions (D1–D9 in PRD §8) before Phase 0.

**Existing repo state:** scaffold quality. Grammar + types + docs are salvageable; everything else is stub (`console.log`). Broken bits: `require.main` in ESM; CI `cd ./trailscribe`; `!mail subj` regex; unpublished-package imports in Pipedream example; in-memory idempotency/ledger fatal on serverless. See `git log` + earlier onboarding analysis for full list.

**Next action after sign-off:** draft `plans/phase-0-scaffolding.md` (fix scaffolding, Wrangler + KV + secrets, replace Jest with Vitest, replace Express with Hono, branch rename).

## Known bugs / drift

- `!mail` regex `subj:([^\s]+)` disallows spaces in subject — almost certainly wrong.
- `router.ts` uses `require.main === module` (CJS) under `"type": "module"` — won't execute.
- `package.json` is missing `ts-node-dev`/`jest`/etc. in dependencies *and* in deps graph no actual HTTP client or zod runtime check has been exercised.
- `.github/workflows/ci.yml` uses `working-directory: ./trailscribe` — that path doesn't exist in the repo root, CI will fail.
- `examples/pipedream-steps.md` imports from `trailscribe/dist/...` as if it's a published npm package — it isn't.
- Ledger uses `JSON.stringify(command).length` / `reply.length` as a proxy for tokens — inaccurate.
- `grammar.ts` accepts `!todoist` as alias for `!todo` but this isn't documented.
- Gmail "sender" may be used as the reply-to on unknown-command paths, creating a self-reply loop.
- Idempotency `Set` grows unbounded (memory leak on long-running instances; irrelevant on serverless because state is lost anyway).

## Conventions

- **Strict TS**, JSDoc on exported functions, short focused functions.
- **Reply budget:** total outgoing ≤320 chars including the cost suffix (when `APPEND_COST_SUFFIX=true`).
- **Idempotency key:** `sha256(imei + ":" + timeStamp + ":" + messageCode + ":" + content_hash)` — Garmin has no `msgId` field, so we derive a composite key (see PRD §5).
- **Env:** validated via zod schema in `src/env.ts`; access via typed `Env` binding in Worker handlers.
- **Tool adapters** live in `src/adapters/*` and accept `{ ...args, env: Env }`.

## Locked decisions (2026-04-22)

- **D1 Inbound auth:** static bearer token (`GARMIN_INBOUND_TOKEN`)
- **D2 Pro tier:** YES — full IPC path enabled
- **D3 Schema:** V2 (tolerate V3/V4)
- **D4 Token budget:** 50,000/day
- **D6 Reply:** IPC Inbound primary + email fallback (fallback gated by D9)
- **D7 Branch:** rename `master` → `main` at Phase 0
- **Model:** `gpt-5-mini` (user override from `gpt-4o-mini`)

## Also locked (2026-04-22)

- **D5 Blog platform:** GitHub Pages + markdown commits via GitHub Contents API. Dedicated journal repo. Theme chosen at Phase 0.
- **D8 Outbound email:** Resend (`trailscribe@resend.dev` for α).
- **D9 Email-fallback reply:** skipped for α.

## External services (target env bindings — Phase 0+, assuming D5/D8 recommendations accepted)

**Secrets (Wrangler Secrets):**
- `GARMIN_INBOUND_TOKEN` — static bearer; verify `Authorization: Bearer <token>` on Outbound webhooks
- `GARMIN_IPC_INBOUND_API_KEY` — `X-API-Key` for Garmin IPC Inbound
- `GARMIN_IPC_INBOUND_BASE_URL` — per-tenant (e.g. `https://ipcinbound.inreachapp.com/api`)
- `IMEI_ALLOWLIST` — comma-sep accepted IMEIs (defense-in-depth)
- `OPENAI_API_KEY`
- `TODOIST_API_TOKEN`
- `RESEND_API_KEY` — outbound email transactional
- `GITHUB_JOURNAL_TOKEN` — fine-grained PAT with `contents:write` on journal repo
- `GITHUB_JOURNAL_REPO` — e.g. `brockamer/trailscribe-journal`
- `GITHUB_JOURNAL_BRANCH` — `main`

**Vars (non-secret):**
- `TRAILSCRIBE_ENV` — dev/staging/production
- `GOOGLE_MAPS_BASE`, `MAPSHARE_BASE` — link prefixes
- `OPENAI_MODEL` — `gpt-5-mini`
- `OPENAI_INPUT_COST_PER_1K` / `OPENAI_OUTPUT_COST_PER_1K` — ledger pricing; set from OpenAI pricing page
- `APPEND_COST_SUFFIX` — bool (α default: false)
- `DAILY_TOKEN_BUDGET` — `50000`
- `IPC_SCHEMA_VERSION` — `"2"`
- `RESEND_FROM_EMAIL` — e.g. `trailscribe@resend.dev`
- `RESEND_FROM_NAME` — e.g. `TrailScribe`
- `JOURNAL_POST_PATH_TEMPLATE` — e.g. `content/posts/{yyyy}-{mm}-{dd}-{slug}.md`

## Garmin IPC quick-ref (authoritative sources in `materials/`)

- **IPC Outbound v2.0.8** (device → us): HTTPS POST. Schema V2/V3/V4 (α uses V2). Fields we need: `imei` (15-digit), `messageCode` (3=Free Text), `freeText`, `timeStamp` (ms epoch), `point{latitude,longitude,altitude}`, `addresses[]`, `status{lowBattery,...}`. Auth via OAuth bearer OR static token (α uses static bearer). **Must respond 200** or Garmin retries at 2/4/8/16/32/64/128s then 12h pauses × 5 days → suspension.
- **IPC Inbound v3.1.1** (us → device): POST `{base}/api/Messaging/Message`. Auth: `X-API-Key` header. Body: `{ Messages: [{ Recipients: [imei], Sender, Timestamp: "/Date(ms)/", Message }] }`. **Message body 160 chars MAX** (Iridium hard limit — 422 on overage). Returns `{ count: N }`.
- **Tier requirement:** IPC Outbound + Inbound are **Professional/Enterprise only**. Consumer inReach does not expose these APIs — gates the whole architecture (see PRD §8 D2).

## Workflow

- **jared** (GitHub Projects v2 PM) will manage the board after Phase 0 ships — do NOT run `/jared-init` yet. No issues, PRs, or project exist today.
- Git: `origin` = `https://github.com/brockamer/trailscribe.git`. Default branch currently `master`; PRD §8 D7 proposes rename to `main` at Phase 0.
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
