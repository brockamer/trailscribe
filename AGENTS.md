# TrailScribe — Project Context

Living context file for Claude Code. Keep concise; update as decisions are made.

**Canonical PRD:** `docs/PRD.md` (source of truth for product scope, architecture, and phased plan — read it first).
**Input materials:** `materials/` (PDFs + spec + deep research report + Garmin IPC docs). **Only the PDFs are tracked** — `.gitignore:25` ignores `materials/*.txt`, so the extracted text does not survive a fresh clone. Regenerate on demand with `pdftotext -layout "materials/<name>.pdf" out.txt` (a harmless `xref num ... not found` warning on stderr does not affect the output).

## Commands

- `pnpm dev` — `wrangler dev` local Worker
- `pnpm test` / `pnpm test:watch` — Vitest
- `pnpm typecheck` — `tsc --noEmit`
- `pnpm lint` — ESLint
- `pnpm format` — Prettier on **staged files only** (no-op if nothing staged); pass explicit paths to override (`pnpm format docs/PRD.md`). Use `pnpm format:all` for a deliberate whole-repo sweep. Default is scoped per #191 to keep PR diffs tight.
- `pnpm format:check` — `prettier --check .`; reports drift without writing. **CI runs exactly this and fails on drift** (#225, option 2 — chosen 2026-09-12 after 58 files had accumulated unnoticed because nothing gated them). So `pnpm format` before committing is no longer just courtesy. If CI fails here, `pnpm format:all` normally fixes it.
  **If it does not** — the file still fails `format:check` right after a write pass — you have hit a prettier non-convergence, not a stale checkout. The known cause is a Markdown line holding both emphasis (`*x*`) and a bare identifier containing an underscore (`some_file.pdf`): prettier normalizes `*x*` to `_x_`, then on the next pass pairs that underscore with the one in the identifier and rewrites both, corrupting the text. Fix the source, not the formatter — put the identifier in a code span (`` `some_file.pdf` ``). Found and fixed once already, in the Mode B design spec.
- `pnpm deploy:staging` / `pnpm deploy:prod`

## Product

**TrailScribe** is an AI-native serverless agent that turns a Garmin inReach into a command interface for enriched off-grid workflows. User sends short `!command` messages; a Cloudflare Worker parses them, enriches with context (place names, weather, map links), runs an LLM where appropriate, invokes tools (Resend, Todoist, GitHub Pages), and replies via Garmin IPC Inbound in ≤2 SMS.

- **Personas (canonical, from product decks):** Natalie (field botanist, Eastern Sierra), Marcus (expedition guide, PNW/Alaska/Patagonia), Yuki (solo bikepacker/storyteller, Iceland/Mongolia/Patagonia). See PRD §1.
- **Hard constraints:** Garmin IPC Inbound messages are 160 chars max. Reply budget 320 chars (two SMS). Idempotency matters — Garmin retries 2/4/8/16/32/64/128s then pauses 12h × 5d.
- **Cost target:** text path <$0.05/tx, $0.03 typical (dominated by the LLM narrative call; non-AI commands are effectively free). Image path (`!postimg`, planned `!snapimg`) <$0.23/tx target, $0.28/tx hard ceiling — image-gen capped at $0.20/image plus the same narrative call. Raised from a flat $0.05 on 2026-09-14; see PRD §6. **None of these are enforced at runtime** — the only spend gate is `DAILY_TOKEN_BUDGET`, which counts tokens, and images consume none.
- **Not a safety system.** SOS must go through Garmin native.

## Command grammar

**α-MVP (6 commands):** `!post <note>`, `!mail to:_ subj:_ body:_`, `!todo <task>`, `!ping`, `!help`, `!cost`.

**Deferred (13-cmd original set is post-MVP):** `!where`, `!weather` (P2), `!drop`, `!brief` (P2), `!ai`, `!camp` (P3), `!blast`, `!share` (P4). Reasons in PRD §2.

Parser is in `src/core/grammar.ts` (salvaged per Verdict B).

## Tech stack

- **Runtime:** Cloudflare Workers (TS, strict, ESM)
- **HTTP:** Hono (not Express)
- **Validation:** zod
- **Storage:** Cloudflare KV (bindings: `TS_IDEMPOTENCY`, `TS_LEDGER`, `TS_CONTEXT`, `TS_CACHE`, `TS_TRACKS`). Durable Objects + D1 in later phases.
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
    ledger.ts                   # KV-backed ledger; real LLM token usage (post + track cost buckets, #173)
    links.ts                    # Google Maps + MapShare link builders (salvaged)
    tracking.ts                 # Mode B tracking sessions: mc=12 Stop Track → KML pull → post (#168)
    track-metrics.ts            # distance/duration/elevation rollups from MapShare KML points
    units.ts                    # imperial rendering helpers (#195)
    budget.ts                   # daily token budget gate
    reply.ts                    # 320-char reply formatter + cost suffix
    fieldlog.ts                 # bounded per-IMEI journal entries (!drop / !brief)
    addressbook.ts              # ADDRESS_BOOK_JSON alias resolution (!share / !blast)
    imageprompt.ts              # image-gen prompt builder (!postimg / !snapimg)
    commands/                   # per-command handlers (one module per !command)
  app.ts                        # Hono app: routes GET / , GET /health, POST /garmin/ipc;
                                #   bearer auth; IMEI allowlist gate (:163); idempotency; dispatch
  adapters/
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
plans/                          # per-milestone sprint plans (none active; all archived under archived/2026-MM/)
```

## Status

- **Phase 0 — Workers scaffold:** complete 2026-04-24. All 20 P0 stories shipped.
- **Phase 1 — α-MVP:** complete 2026-04-27. Epic #30 closed 2026-04-26; close gate #111 (production traffic turn-on with the Mini 3 Plus against the production Worker) verified 2026-04-27. All 6 commands (`!post`, `!mail`, `!todo`, `!ping`, `!help`, `!cost`) return real responses on production; replay verification + cost measurement complete; OpenRouter LLM layer live (`anthropic/claude-sonnet-4-6`). Plan archived at `plans/archived/2026-04/phase-1-alpha-mvp.md`.
- **Production-readiness:** complete 2026-04-28. All 8 milestone issues closed: shipped #32, #33 (auto-deploy on push to main re-enabled in #126), #121 (device-side recipient + Include-Location convention pinned in #127); closed-as-not-planned #14, #15, #26 (operator scope decision: personal-project housekeeping, no custom domain).
- **Phase 2 — extended commands + `!postimg`:** complete 2026-04-29. All 9 commands shipped end-to-end on production (`!where`, `!weather`, `!drop`, `!brief`, `!ai`, `!camp`, `!share`, `!blast`, `!postimg`); P2-15 staging burn-in PASSED (84 ledger entries, idempotency confirmed). Epic #98 closed; sub-issues #112–#119 + #125 closed via PR-merge auto-close. Plan archived at `plans/archived/2026-04/phase-2-extended-commands.md`. Real-device verification (P2-16) pending operator + Mini.
- **Mode B — Tracking Sessions:** implementation (#168) shipped 2026-05-04 via PR #164; hardening epic #187 (milestone #8) effectively complete as of 2026-05-18. New surface: IPC Outbound `messageCode: 12` (Stop Track) → MapShare KML pull → `track-metrics` rollup → LLM narrative → journal post. State in `TS_TRACKS` KV (no Durable Object needed — the Phase 3 dependency was dropped 2026-05-03 once pull-on-close was confirmed canonical). Children #173, #174, #175, #170, #186 all closed; follow-ups #195/#197/#199/#201 shipped through 2026-05-18. Spec + plan under `docs/superpowers/`.
- **Phase 3 — DO + D1 migration:** filed as epic #99 (Low-priority Backlog), children #153/#154/#155. Not started. Decoupled from Mode B by design.
- **⚠ Dormant since 2026-05-18.** No commits between 2026-05-18 and 2026-09-11. Re-entry notes in `docs/resume-2026-09.md`.

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
- `MAPSHARE_KEY` — per-tenant MapShare slug (path component appended to `MAPSHARE_BASE`); `trailscribe` for prod
- `MAPSHARE_PASSWORD` — MapShare access code (Basic Auth password; empty user). Set in Garmin Explore → MapShare → Access Code. Empty string = unprotected feed (no auth header).

**Vars (non-secret):**

- `TRAILSCRIBE_ENV` — dev/staging/production
- `GOOGLE_MAPS_BASE` — link prefix for Google Maps URLs
- `MAPSHARE_BASE` — Garmin MapShare host root (e.g. `https://share.garmin.com`); per-tenant slug lives in `MAPSHARE_KEY` and is appended at use sites (`${MAPSHARE_BASE}/${MAPSHARE_KEY}` for page URLs, `${MAPSHARE_BASE}/Feed/Share/${MAPSHARE_KEY}` for the KML feed). Empty `MAPSHARE_BASE` disables MapShare links in `!where` / `!share` / `!blast`.
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
- `IMAGE_MODEL` — `black-forest-labs/flux-2-max` (swapped from `flux-schnell` in #235 after a real side-by-side bake-off; schnell rendered cartoons and literal lettered sticky notes, flux-2-max produced photorealistic output with blank notes). Billed per output-megapixel: `$0.04` fixed + `$0.03`/MP, so `$0.10` at the `resolution: "2 MP"` the adapter requests. **`IMAGE_COST_PER_CALL_USD` is only correct while that resolution is unchanged** — at 4 MP the same model costs ~$0.16.
- `IMAGE_COST_PER_CALL_USD` — ledger pricing for image-gen; default `0.01`
- `JOURNAL_IMAGE_PATH_TEMPLATE` — e.g. `assets/images/{yyyy}-{mm}-{dd}-{slug}.{ext}` (commits the binary alongside the markdown post; non-underscore so Jekyll serves it)

## Garmin IPC quick-ref (authoritative sources in `materials/`)

- **IPC Outbound v2.0.8** (device → us): HTTPS POST. Schema V2/V3/V4 (α uses V2). Fields we need: `imei` (15-digit), `messageCode` (3=Free Text), `freeText`, `timeStamp` (ms epoch), `point{latitude,longitude,altitude}`, `addresses[]`, `status{lowBattery,...}`. Auth via OAuth bearer OR static token (α uses static bearer). **Must respond 200** or Garmin retries at 2/4/8/16/32/64/128s then 12h pauses × 5 days → suspension.
- **IPC Inbound v3.1.1** (us → device): POST `{base}/api/Messaging/Message`. Auth: `X-API-Key` header. Body: `{ Messages: [{ Recipients: [imei], Sender, Timestamp: "/Date(ms)/", Message }] }`. **Message body 160 chars MAX** (Iridium hard limit — 422 on overage). Returns `{ count: N }`.
- **Tier requirement:** IPC Outbound + Inbound are **Professional/Enterprise only**. Consumer inReach does not expose these APIs — gates the whole architecture (see PRD §8 D2).
- **Message Codes Table** (IPC Outbound rev 2.0.8, p.9 — the authoritative list). Codes TrailScribe routes: `0` Position Report, `3` Free Text, `4` Declare SOS, `10` Start Track, `11` Track Interval, `12` Stop Track. Codes the device also emits that we silent-drop by design: `2` Locate Response, `13` Unknown Index, `14`–`16` Puck Message 1–3, `17` Map Share, **`20` Mail Check**, **`21` Am I Alive**, `24`–`63` Pre-defined Message, `64`–`69` encrypted/binary classes, `3099` Canned Message.
- **mc=20 ("Mail Check") is the device polling for queued inbound messages** (confirmed 2026-09-16 from the spec table, closing #207). It is routine housekeeping, not an error — silent-drop is correct. **Diagnostic value:** because Iridium cannot push, a reply only reaches the device when the device asks for it, so mc=20 arrival timestamps mark exactly when the mailbox was checked. That is the missing timeline in the open "Worker hands off in <6s but the Mini 3 Plus takes up to 75s" question.
- **Device autonomously flaps tracking interval based on motion** (Mini 3 Plus confirmed 2026-05-17 during #197 investigation): `status.intervalChange` toggles between the configured interval (e.g. 120s) and a long stationary-saver value (observed 14400s = 4hr) when the device detects no motion, then reverts when motion resumes. Emitted as mc=11 ("Track Interval") with the new value in `status.intervalChange` (seconds; 0 = unchanged). Short or mostly-stationary sessions can therefore hit MapShare with very few breadcrumbs even when the UI shows a fast interval. **MapShare KML and IPC Outbound mc=0 stream are independent** — MapShare may carry more pings than IPC Outbound delivers for the same window. See #201 for decoding/persisting the current interval to use in refusal SMS hints.

## Workflow

- **jared** manages the board: https://github.com/users/brockamer/projects/3 (see `docs/project-board.md`).
- No active plan. Last shipped work was Mode B hardening (epic #187) through 2026-05-18. Phase 3 (DO + D1, epic #99) is the next promotion candidate and is no longer blocked (the #161 edge was re-pointed at #154 on 2026-09-16). Ledger-cost (#162) is the most-developed loose issue; `!snap`/`!snapimg` (#150) was closed as not-planned.
- Git: `origin` = `git@github.com:brockamer/trailscribe.git` (SSH on this laptop; the HTTPS form documented before 2026-09-13 was the dev.lan checkout), default branch `main`.
- Commit sign-off: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` (update the model name as sessions change; keep the line).

## Ground rules

- **PRD is canonical.** No scope creep without PRD update + sign-off.
- **No new env vars, services, or dependencies** without PRD justification.
- **Reply budget is sacred:** ≤320 chars out (incl. cost suffix if enabled). Longer content goes to email/blog.
- **Serverless ephemerality:** all state in KV (or later DO/D1). No in-memory idempotency/ledger.
- **Auth before processing:** verify `GARMIN_INBOUND_TOKEN` bearer on every Outbound webhook; IMEI must be in allowlist.
- **A rejected IMEI is silent by design:** `src/app.ts:163` logs `imei_not_allowed` and returns; the route still answers HTTP 200, so Garmin never retries and the device gets nothing. Identical symptom to a dead network — check this first when replies stop.
- **`parseEnv()` is NOT called on the request path** (`src/app.ts` uses `c.env` directly), so the zod `IMEI_ALLOWLIST` regex in `src/env.ts:116` is documentation, not a runtime gate. A malformed secret fails silently.
- **Never commit secrets.** Wrangler Secrets only. `.dev.vars` gitignored; `.dev.vars.example` tracked.
- **Salvage aggressively per Verdict B:** keep grammar, `ParsedCommand`, env schema shape, docs, link builders. Rebuild tool adapters, idempotency/ledger stores, Garmin adapters, webhook auth.
- **Test seams with fixtures** (`tests/fixtures/` with recorded Garmin event payloads), not mocks of Garmin's API shape.

## Useful files to read first

1. `docs/PRD.md` — canonical product/engineering spec (sign-off pending)
2. `materials/TrailScribe_ Your AI Companion for Off-Grid Adventures.pptx.txt` — personas + product vision
3. `materials/TrailScribe Deep Research Report.txt` — architecture rationale (Workers, phased KV→DO→D1)
4. `materials/Garmin IPC Outbound.txt` — Outbound webhook contract (auth, schema, retry)
5. `materials/Garmin IPC Inbound.txt` — Inbound API contract (X-API-Key, 160-char limit, error codes)
6. `src/core/grammar.ts` — command parser (note: `src/agent/` does not exist)
7. `docs/field-commands.md` — command UX reference (operator-facing)
8. `docs/superpowers/specs/archived/2026-09/2026-05-01-tracking-session-artifacts-design.md` — Mode B tracking design (archived 2026-09-13; plan alongside it under `plans/archived/2026-09/`)
9. `docs/resume-2026-09.md` — state of play after the 2026-05 → 2026-09 dormancy
