# Phase 1 — α-MVP

**Goal:** From a Garmin inReach Mini 3 Plus, send any of the six α-MVP commands (`!post`, `!mail`, `!todo`, `!ping`, `!help`, `!cost`) and receive a valid reply on the device — end-to-end through real third-party APIs, with the per-transaction cost ≤ \$0.05 and idempotent against Garmin's retry storms.

**Source of truth:** `docs/PRD.md` §2 / §3 / §5 / §6 (signed off 2026-04-22).
**Issue:** [#34](https://github.com/brockamer/trailscribe/issues/34).
**Epic:** [#30 — Phase 1 — α-MVP](https://github.com/brockamer/trailscribe/issues/30).
**Milestone:** [Phase 1 — α-MVP](https://github.com/brockamer/trailscribe/milestone/2) (due 2026-06-15).
**Supersedes:** issue [#31](https://github.com/brockamer/trailscribe/issues/31) — LLM calls go through OpenRouter, not OpenAI directly. The locked `gpt-5-mini` / `OPENAI_*` decisions in `CLAUDE.md` and PRD §6 are replaced; see P1-04.

## Plain-language refresher

Phase 1 is the first time the codebase touches third-party APIs in production. Quick sysadmin-flavored glossary so the stories below read cleanly:

- **Cloudflare Worker** — the code that runs on every inbound HTTP request, on Cloudflare's edge (≈300 cities). No VM, no OS, no SSH; you push code with `wrangler deploy` and it runs in a V8 isolate. Like a CGI script, but globally distributed and stateless.
- **KV (Key-Value store)** — Cloudflare's globally-replicated key/value DB. Workers have no local disk and no persistent process memory, so every piece of state — idempotency records, ledger, cache — lives in KV. **Eventually consistent**: a write is visible at the writing edge immediately but may take seconds to propagate worldwide. There are four KV bindings: `TS_IDEMPOTENCY`, `TS_LEDGER`, `TS_CONTEXT`, `TS_CACHE`.
- **Wrangler** — the Cloudflare CLI. `wrangler dev` runs the Worker locally with mock KV; `wrangler deploy --env staging` ships to the staging URL; `wrangler secret put KEY --env staging` is the equivalent of putting a value in `/etc/secrets/KEY` for that environment.
- **Hono** — a tiny HTTP routing library (10 KB) designed for Workers. Like Express, but Worker-native. Already wired in `src/app.ts`.
- **Garmin IPC Outbound** — Garmin's webhook to *us*: when the device sends a message, Garmin POSTs the event to `/garmin/ipc`. We must respond `200` or Garmin retries.
- **Garmin IPC Inbound** — *Our* call to Garmin to deliver a reply: `POST {base}/api/Messaging/Message` with `X-API-Key`. Body limit is **160 chars per message** (Iridium hard cap; 422 on overage). Two messages = 320-char reply budget.
- **Idempotency** — making sure the same Garmin webhook delivered twice only acts once. Garmin retries failed deliveries every 2/4/8/16/32/64/128 s, then 12 h pauses × 5 d. We dedupe by computing `sha256(imei + timestamp + messageCode + content_hash)` and storing it in `TS_IDEMPOTENCY` for 48 h.
- **OpenRouter** — a single HTTP API that proxies to many LLM providers (OpenAI, Anthropic, Google, etc.) behind one auth key. Lets us swap models without code changes. Calls look like OpenAI's chat-completions API; just a different base URL and key.
- **Resend** — transactional email API (think SendGrid/Postmark). API key auth, JSON body, no SMTP/OAuth dance.
- **Todoist** — task-list SaaS with a REST API. POST a JSON body with the task content; we get back a task ID.
- **GitHub Contents API** — the REST endpoint we use to commit a markdown file to a journal repo. `PUT /repos/{owner}/{repo}/contents/{path}` with a base64-encoded file body and a commit message. Backs `!post`'s blog publish.

Story bodies inline-define anything else specialized.

---

## Critical event-handling guards

Two non-obvious behaviors of the Garmin Outbound stream must be handled at the orchestrator boundary in P1-01, before any other story runs. Surfaced as their own callout because they affect every downstream module:

1. **Non-Free-Text events.** Garmin sends `messageCode=0` (Position Report breadcrumbs) **continuously while tracking is on** — these arrive even when the user isn't sending a command. They have no `freeText`. The Worker must idempotency-record them (replay protection still useful) but **must not** invoke the orchestrator and **must not** send a reply. Replying "Unknown command" to every breadcrumb would spam the device and burn satellite cost. Equally important: `messageCode=4` (Declare SOS) **must never** be processed — SOS goes through Garmin native per PRD §1 ("not a safety system"). Only `messageCode === 3` (Free Text) dispatches to the orchestrator in α.
2. **No-GPS-fix events.** Per Garmin Outbound v2.0.8 §Event Schema V2: "Values are filled with 0 when there is no location information." Common at boot, in canyons, indoors. The orchestrator must check `event.point.gpsFix !== 0 && !(event.point.latitude === 0 && event.point.longitude === 0)` before passing `lat`/`lon` to the context. When no fix, downstream modules see `lat=undefined, lon=undefined` and naturally degrade: geocode/weather skipped, map links omitted from reply, narrative prompt omits position context. P1-09, P1-10, and P1-15 must accept `undefined` lat/lon explicitly.

Both guards are wired in P1-01's acceptance criteria.

---

## Milestone exit criteria (all must be true)

- [ ] All 6 commands work end-to-end on staging with real APIs (no stubs, no canned strings).
- [ ] Production Worker deployed; first real Garmin inReach transaction succeeds round-trip (`!ping` → `pong` on the device).
- [ ] Idempotency: 10 manual webhook replays produce 0 duplicate side-effects (no duplicate blog posts, emails, tasks, OpenRouter calls, IPC Inbound replies).
- [ ] Cost: ≥ 20 real `!post` transactions logged in the ledger; per-transaction cost ≤ \$0.05 (target ≤ \$0.03).
- [ ] `!cost` reply matches the ledger month-to-date totals exactly.
- [ ] Reply budget: every reply ≤ 320 chars; two-SMS paging works for content longer than 160; if `APPEND_COST_SUFFIX=true`, the suffix counts against the budget.
- [ ] Daily token budget gate (`DAILY_TOKEN_BUDGET=50000`): when exceeded, `!post` returns the canned cap message and does not call OpenRouter.
- [ ] Position Report breadcrumbs (messageCode=0) and SOS (messageCode=4) do **not** trigger replies or orchestrator calls.
- [ ] No-GPS-fix events (gpsFix=0 or lat=lon=0) skip enrichment and omit map links cleanly — no "Atlantic Ocean" geocode results.
- [ ] All adapters log structured JSON (one event per outbound call) with success/error and latency.
- [ ] CI green on `main`: typecheck + lint + Vitest.
- [ ] No `throw new Error("not implemented in Phase 0")` anywhere in `src/adapters/` or `src/core/`.

---

## Story map

Stories are sized **S** (≤2 h), **M** (≤half-day), **L** (≤day). Dependencies are noted in brackets.

The work splits into seven themes. Themes can be parallelized; dependencies inside a theme are noted.

| Theme | Stories | Why grouped |
|---|---|---|
| A — Reply pipeline (foundation) | P1-01, P1-02 | Wire orchestrator → IPC Inbound. Must land before any command can talk back to the device. Includes the messageCode + GPS-fix guards. |
| B — AI provider (OpenRouter) | P1-03, P1-04, P1-05 | Replace `openai.ts` adapter, rename env vars, build narrative module. |
| C — External adapters | P1-06, P1-07, P1-08, P1-09, P1-10 | Real implementations of mail, tasks, blog publish, geocode, weather. |
| D — Core supporting modules | P1-11, P1-12, P1-13, P1-14 | Ledger, context window, op-level idempotency checkpoints, daily budget gate. |
| E — Reply formatter | P1-15 | Single module that takes `CommandResult` → ≤320-char paged reply with optional cost suffix. |
| F — Command handlers | P1-16, P1-17, P1-18, P1-19 | Per-command pipelines that compose the adapters. |
| G — End-to-end verification | P1-20, P1-21, P1-22, P1-23 | Journal repo bootstrap, staging burn-in, prod cutover gate. |

---

## Sprint-ready stories

### Theme A — Reply pipeline (foundation)

#### P1-01 — Wire orchestrator into `/garmin/ipc` request path with messageCode + GPS-fix guards [M]

**Context.** `src/app.ts` currently logs `event_received` and stops; the comment says `// TODO: dispatch to orchestrator in Phase 1`. We need to call `orchestrate()` on each event, capture the `CommandResult`, and forward it to the reply path (P1-02) — but **only** for `messageCode === 3` events with valid `freeText` starting with `!`. See "Critical event-handling guards" callout above.

**Acceptance criteria:**
- [ ] `handleEvent` writes the idempotency record for every event regardless of messageCode (replay protection is universal).
- [ ] **Guard 1 (messageCode):** if `event.messageCode !== 3`, log `event: "non_free_text"` with the `messageCode` field, write the idempotency record, return without dispatching. SOS (`messageCode=4`) gets a separate `event: "sos_received_ignored"` log line for visibility.
- [ ] **Guard 2 (GPS fix):** compute `hasFix = event.point.gpsFix !== 0 && !(event.point.latitude === 0 && event.point.longitude === 0)`. Pass `lat`/`lon` to `OrchestratorContext` only when `hasFix`; otherwise pass `undefined`.
- [ ] After guards, parse `event.freeText` via `parseCommand` (already implemented).
- [ ] If parse returns `undefined` (unknown command), log `event: "parse_unknown"` and reply `Unknown command. Try !help` (only fires for messageCode=3).
- [ ] On parse success, call `orchestrate(command, { env, imei, lat, lon })`.
- [ ] On orchestrator error, log `event: "orchestrate_error"` with the error message, reply `Error: <short>`.
- [ ] Update the existing idempotency record on completion via `putJSON` with `{ status: "completed", completedAt }`.
- [ ] Worker still always returns 200 to Garmin (errors logged, not bubbled up).
- [ ] Vitest cases:
  - `messageCode=3 + !ping` → orchestrator called, reply sent.
  - `messageCode=0 (breadcrumb)` → idem record written, no orchestrator call, no reply.
  - `messageCode=4 (SOS)` → `sos_received_ignored` logged, no orchestrator call, no reply.
  - `messageCode=3 + gpsFix=0` → orchestrator called with `lat=lon=undefined`.
  - `messageCode=3 + lat=0 + lon=0 + gpsFix=2` → also treated as no-fix (defensive).

**Size:** M.
**Depends on:** none (orchestrator already exists for `!ping`/`!help`/`!cost`; full command set comes later).

---

#### P1-02 — IPC Inbound `sendReply` adapter (real implementation) [M]

**Context.** `src/adapters/outbound/garmin-ipc-inbound.ts` is a stub that throws. Real impl per `materials/Garmin IPC Inbound.txt`: POST `{GARMIN_IPC_INBOUND_BASE_URL}/api/Messaging/Message` with `X-API-Key` header and a body shaped:

```json
{ "Messages": [{
  "Recipients": ["<imei>"],
  "Sender": "<env.IPC_INBOUND_SENDER>",
  "Timestamp": "/Date(<ms>)/",
  "Message": "<≤160 chars>"
}]}
```

Reply budget is 320 chars (two SMS). Each `Message` field is hard-capped at 160 by Iridium; we send up to two requests per reply. P1-15 owns the page-splitting logic and feeds 1–2 message strings to `sendReply`.

**Acceptance criteria:**
- [ ] `sendReply(imei: string, messages: string[], env: Env): Promise<{ count: number }>`.
- [ ] Validates each message ≤ 160 chars; throws a typed error if longer (caller's bug).
- [ ] Sends one HTTP request per message (Garmin's API supports an array but the IDs are simpler if we send sequentially).
- [ ] `Sender` field reads from `env.IPC_INBOUND_SENDER` (new env var, see P1-04). Default value (set in `wrangler.toml [vars]`) equals `RESEND_FROM_EMAIL` — but the field is decoupled so future cutover doesn't conflate device-reply identity with outbound mail identity.
- [ ] Retry on 5xx / 429: 1 s, 4 s, 16 s. After 3 failures, log `event: "reply_delivery_failed"` and rethrow.
- [ ] On 422, surface the `{Code, Description}` body in the thrown error (so we can see e.g. `InvalidMessageError` in logs).
- [ ] On 401/403, log `auth_fail_outbound` and rethrow (means the API key is wrong; alerting required).
- [ ] Returns `{ count: <total messages delivered> }`.
- [ ] Vitest test using `vi.fn()`-mocked `fetch`: success path, 422, 5xx-then-success-on-retry, all-retries-fail.

**Plain-language note.** The `/Date(ms)/` format is .NET's JSON date encoding — Garmin's API was built on .NET WCF. Just stringify a millisecond epoch into that wrapper.

**Size:** M.
**Depends on:** P1-04 (uses `IPC_INBOUND_SENDER`).

---

### Theme B — AI provider (OpenRouter)

#### P1-03 — Rename `adapters/ai/openai.ts` → `adapters/ai/openrouter.ts` [S]

**Context.** PRD §6 locked `gpt-5-mini` direct via OpenAI. Issue #31 supersedes that — Phase 1 routes through **OpenRouter**, a service that exposes one HTTPS API (`https://openrouter.ai/api/v1/chat/completions`) and one API key while letting us pick any model from many providers. Wire change: same OpenAI-style request shape, different base URL, different auth header (`Authorization: Bearer <key>`), plus an `HTTP-Referer` and `X-Title` header for OpenRouter analytics.

**Acceptance criteria:**
- [ ] `src/adapters/ai/openrouter.ts` exists; old `openai.ts` deleted.
- [ ] Function signature stays — but the existing `NarrativeInput`/`NarrativeOutput` types **move out** of the adapter file and into `src/core/narrative.ts` (P1-05). The adapter becomes a thin HTTP wrapper that takes a typed prompt config and returns the raw model response.
- [ ] `pnpm typecheck` + `pnpm test` green after the rename (no real impl yet — still a stub that throws).
- [ ] No remaining references to `OPENAI_*` env vars in this file (those rename in P1-04).

**Size:** S.
**Depends on:** none.

---

#### P1-04 — Provider-neutral env var renames + new IPC sender + journal URL template [S]

**Context.** Per #31 + the auto-memory note, the env schema should be provider-neutral. This story bundles three correlated env changes that all touch `wrangler.toml`, `src/env.ts`, `.dev.vars.example`, `docs/setup-cloudflare.md`, and `CLAUDE.md`.

**Renames:**
- `OPENAI_API_KEY` → `LLM_API_KEY`
- `OPENAI_MODEL` → `LLM_MODEL`
- `OPENAI_INPUT_COST_PER_1K` → `LLM_INPUT_COST_PER_1K`
- `OPENAI_OUTPUT_COST_PER_1K` → `LLM_OUTPUT_COST_PER_1K`

**New vars:**
- `LLM_BASE_URL` — default `https://openrouter.ai/api/v1`.
- `LLM_PROVIDER_HEADERS_JSON` — optional JSON blob for OpenRouter `HTTP-Referer` + `X-Title`. Ignored when unset.
- `IPC_INBOUND_SENDER` — `Sender` field for outbound IPC messages (the on-device "From" string). Default value in `wrangler.toml` matches `RESEND_FROM_EMAIL` for now; decoupled so it can evolve independently.
- `JOURNAL_URL_TEMPLATE` — public URL pattern for committed posts (e.g. Jekyll: `https://brockamer.github.io/trailscribe-journal/{yyyy}/{mm}/{dd}/{slug}.html`). Lets us swap themes without changing code. P1-08 reads this; P1-20 fixes the actual value.

**Acceptance criteria:**
- [ ] `src/env.ts` `Env` interface + zod schema updated; old names removed.
- [ ] `wrangler.toml` `[vars]` block updated; staging + production env overrides updated.
- [ ] `.dev.vars.example` updated.
- [ ] `docs/setup-cloudflare.md` and `CLAUDE.md` updated to list new var names.
- [ ] `wrangler secret list --env staging` and `--env production` show `LLM_API_KEY` (after manual `wrangler secret put`).
- [ ] `pnpm typecheck` green.

**Plain-language note.** `wrangler secret put LLM_API_KEY --env staging` is interactive; you paste the value once and it's encrypted at rest in Cloudflare. The Worker reads it via `env.LLM_API_KEY`. This is the moral equivalent of `chmod 600 /etc/trailscribe/llm.key` plus environment loading, but Cloudflare manages the storage and the Worker boot wiring.

**Size:** S.
**Depends on:** P1-03.

---

#### P1-05 — Narrative module: real OpenRouter call with JSON-mode + token usage [M]

**Context.** `src/core/narrative.ts` doesn't exist yet — needs to be created. Function takes a `!post` event's note + position + cached place name + cached weather and calls OpenRouter in JSON mode to return `{ title, haiku, body }`. The caller (P1-16) consumes this and feeds title + a short summary into the device reply, the full body into the blog publish.

**Type ownership.** `NarrativeInput` and `NarrativeOutput` types live in `src/core/narrative.ts` (moved out of the adapter in P1-03). The adapter `src/adapters/ai/openrouter.ts` deals only in raw chat-completion request/response shapes — it's a thin HTTP wrapper. The adapter knows nothing about narratives; the core module knows nothing about OpenRouter's wire format.

**Acceptance criteria:**
- [ ] `src/core/narrative.ts` exports `generateNarrative(input: NarrativeInput): Promise<NarrativeOutput>`.
- [ ] `NarrativeInput` accepts `lat?` / `lon?` / `placeName?` / `weather?` as optional — when no GPS fix, all four are undefined and the prompt omits position context cleanly.
- [ ] System prompt enforces: title ≤ 60 chars; haiku exactly 5-7-5 syllables ≤ 80 chars; body ≤ 500 chars; tone matches the incoming note's voice.
- [ ] Request uses `response_format: { type: "json_schema", json_schema: { ... } }` (OpenRouter passes through to the underlying provider's structured-output mode).
- [ ] Response parsed with `zod` schema; throws on shape mismatch.
- [ ] Returns `{ title, haiku, body, usage: { prompt_tokens, completion_tokens } }` — usage from the OpenRouter response payload (`response.usage.*`); never use character-count proxies.
- [ ] Default model: `openai/gpt-5-mini` (OpenRouter format is `<provider>/<model>`). User can override via `LLM_MODEL`.
- [ ] Vitest: mocked fetch returns a canned JSON response; assert structured output and that `usage` is propagated.
- [ ] Vitest: mocked fetch returns malformed JSON; assert the function throws a typed error.
- [ ] Vitest: `NarrativeInput` with no lat/lon produces a different (shorter) prompt that omits the position line; assert the prompt body in the mocked request.

**Plain-language note.** "JSON mode" / "structured output" tells the LLM to return JSON conforming to a schema. Without it the model often hallucinates wrapper text ("Here's your post:") that breaks downstream parsing. With it, the API rejects the response if it doesn't match.

**Size:** M.
**Depends on:** P1-03, P1-04.

---

### Theme C — External adapters

#### P1-06 — Resend mail adapter (real send) [S]

**Context.** `src/adapters/mail/resend.ts` is a stub. Resend's API: `POST https://api.resend.com/emails` with `Authorization: Bearer <RESEND_API_KEY>` and a JSON body `{ from, to, subject, html | text }`. Returns `{ id: <message-id> }` on 200.

**Acceptance criteria:**
- [ ] `sendEmail({ to, subject, body, env }): Promise<{ id: string }>`.
- [ ] `from` field combines `RESEND_FROM_NAME` + `RESEND_FROM_EMAIL`: `"TrailScribe <trailscribe@resend.dev>"`.
- [ ] Body sent as plain text (`text` field), not HTML — α-MVP doesn't render markdown.
- [ ] On 4xx (typically 400 = validation, 422 = recipient invalid), log + throw a typed error containing the `name` + `message` fields from Resend's response body.
- [ ] On 5xx / network error, retry 1 s / 4 s / 16 s, then throw.
- [ ] Vitest: success, 400 (invalid recipient), 5xx-retry-success.

**Plain-language note.** Resend's free tier (`trailscribe@resend.dev`) doesn't require DNS — they own the sending domain. Custom-domain setup is a Production-readiness concern (issue #25).

**Size:** S.
**Depends on:** none.

---

#### P1-07 — Todoist tasks adapter (real create) [S]

**Context.** `src/adapters/tasks/todoist.ts` is a stub. Todoist REST API: `POST https://api.todoist.com/rest/v2/tasks` with `Authorization: Bearer <TODOIST_API_TOKEN>` and a JSON body `{ content, description, due_string }`. Returns `{ id, content, ... }` on 200.

**Acceptance criteria:**
- [ ] `addTask({ task, lat?, lon?, timestamp, env }): Promise<{ id: string, url: string }>`.
- [ ] `content` = task text from `!todo <task>`.
- [ ] `description` = formatted location + timestamp: `"From inReach: <lat,lon> @ <ISO>"` when lat/lon both present; else just `"From inReach: <ISO>"`.
- [ ] No `due_string` for α — undated tasks. Phase 2+ may parse `!todo <task> by:tomorrow`.
- [ ] Returns the task `id` and the public Todoist URL (`https://todoist.com/showTask?id=<id>`) for inclusion in the reply.
- [ ] Retry semantics same as Resend (5xx → 1 s / 4 s / 16 s).
- [ ] Vitest: success, 401 (bad token), 5xx-retry, lat/lon absent.

**Size:** S.
**Depends on:** none.

---

#### P1-08 — GitHub Pages publish adapter (commit markdown to journal repo) [M]

**Context.** `src/adapters/publish/github-pages.ts` is a stub. We commit one markdown file per `!post` to a dedicated journal repo (`GITHUB_JOURNAL_REPO`, e.g. `brockamer/trailscribe-journal`). Endpoint is the **GitHub Contents API**: `PUT /repos/{owner}/{repo}/contents/{path}` with a base64 file body and a commit message. Auth via fine-grained PAT with `contents:write` on exactly the journal repo.

Path template comes from `JOURNAL_POST_PATH_TEMPLATE`, default `content/posts/{yyyy}-{mm}-{dd}-{slug}.md`. Public URL uses `JOURNAL_URL_TEMPLATE` (P1-04) so the reply link survives a theme swap.

The slug is derived from the narrative title (lowercase, alphanumerics + hyphens, ≤ 50 chars).

Markdown frontmatter (used by Jekyll/Hugo themes):
```yaml
---
title: "<title>"
date: <ISO>
location: { lat: <n>, lon: <n>, place: "<placeName>" }
weather: "<weather>"
tags: [trailscribe]
---
<haiku>

<body>
```

The `location:` and `weather:` frontmatter keys are omitted when no GPS fix.

**Acceptance criteria:**
- [ ] `publishPost({ title, haiku, body, lat?, lon?, placeName?, weather?, env }): Promise<{ url: string, path: string, sha: string }>`.
- [ ] Slug derivation handles unicode (drop non-ASCII), collapses whitespace, fallback to `untitled-<HHMMSS>` if title is empty after stripping.
- [ ] If a file at the same path already exists (rare — same minute), append `-2`, `-3`, … to the slug until unique. Use the GitHub Contents API GET to check; on 404 the path is free.
- [ ] Body assembled with frontmatter exactly as shown; date in ISO 8601. `location` + `weather` keys omitted when lat/lon absent.
- [ ] `Authorization: Bearer <GITHUB_JOURNAL_TOKEN>`, `User-Agent: trailscribe`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.
- [ ] Returns the public URL by interpolating `JOURNAL_URL_TEMPLATE` with `{yyyy}`, `{mm}`, `{dd}`, `{slug}`. Also returns the API-returned commit SHA.
- [ ] Retry 5xx / 502 / 503 / 504 with 1 s / 4 s / 16 s.
- [ ] Vitest: success, slug-collision retry, 401 (token bad), 5xx retry, lat/lon-absent (frontmatter omits keys).

**Plain-language note.** The journal repo is a **separate** repo from this one — Jekyll or Hugo builds it into a static site at `<user>.github.io/<repo>`. Theme/repo creation is a one-time setup step in P1-20 that pins the actual `JOURNAL_URL_TEMPLATE` value.

**Size:** M.
**Depends on:** P1-04.

---

#### P1-09 — Reverse-geocode adapter (Nominatim, KV-cached 24 h) [S]

**Context.** `src/adapters/location/geocode.ts` is a stub. **Nominatim** is the OpenStreetMap reverse-geocode service — free, no auth, with a polite-use policy: **1 req/sec max** and a `User-Agent` identifying us (otherwise blocked). Endpoint: `GET https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=<lat>&lon=<lon>`. Response has `display_name` (long), `address.city`, `address.state`, etc.

We cache aggressively in `TS_CACHE` because positions don't move much within a short walk and Garmin's GPS is precise to ~5 m. Key: `geo:<lat-rounded-4>:<lon-rounded-4>` (≈11 m grid). TTL 24 h.

**Acceptance criteria:**
- [ ] `reverseGeocode(lat: number, lon: number, env: Env): Promise<string>` returns a short place name suitable for embedding in a reply (e.g. `"Palisade Glacier, Inyo Co., CA"`, ≤ 60 chars).
- [ ] Function is **never called** when lat/lon are undefined or both zero — that's caller responsibility (orchestrator strips them in P1-01). Story does not need to defensively check.
- [ ] Cache check first (`TS_CACHE` `geo:<key>`); on hit, return immediately.
- [ ] On miss, fetch Nominatim with `User-Agent: trailscribe (https://github.com/brockamer/trailscribe)`.
- [ ] Strategy for short names: prefer `address.peak || address.locality || address.town || address.village || address.county`, then `address.state`, joined by `, `.
- [ ] Cache the short name in KV with TTL 86400 s.
- [ ] On Nominatim 4xx / 5xx / network error: log `geocode_failed`, return `"unknown location"` (don't throw — geocoding is non-critical).
- [ ] Vitest: cache hit, cache miss success, 5xx fallback to "unknown location".

**Plain-language note.** "1 req/sec" is enforced by Nominatim's terms-of-use, not technically; abuse gets you banned. The cache makes us trivially compliant — repeat positions never re-fetch.

**Size:** S.
**Depends on:** none.

---

#### P1-10 — Weather adapter (Open-Meteo, KV-cached 1 h) [S]

**Context.** `src/adapters/location/weather.ts` is a stub. **Open-Meteo** is a free, no-auth weather API. Endpoint: `GET https://api.open-meteo.com/v1/forecast?latitude=<lat>&longitude=<lon>&current=temperature_2m,wind_speed_10m,weather_code`. Returns current conditions.

Cache key: `wx:<lat-rounded-2>:<lon-rounded-2>` (≈1 km grid). TTL 3600 s.

**Acceptance criteria:**
- [ ] `currentWeather(lat: number, lon: number, env: Env): Promise<string>` returns a ≤ 30-char human string like `"42°F, 8mph W, clear"`.
- [ ] Like P1-09: never called when lat/lon undefined; orchestrator guards in P1-01.
- [ ] Cache check first; on hit, return.
- [ ] On miss, fetch Open-Meteo, format with imperial units (PRD personas are US/Iceland/Patagonia — imperial-or-metric is a future preference; default imperial).
- [ ] Map `weather_code` (WMO codes 0–99) to short labels: `0`=clear, `1-3`=partly cloudy, `45,48`=fog, `51-57`=drizzle, `61-67`=rain, `71-77`=snow, `80-82`=showers, `95-99`=thunderstorm. Compact table in source.
- [ ] Cache the formatted string with TTL 3600 s.
- [ ] On error: return `"weather unavailable"` (don't throw).
- [ ] Vitest: cache hit, cache miss + clear day, 5xx fallback.

**Size:** S.
**Depends on:** none.

---

### Theme D — Core supporting modules

#### P1-11 — Ledger module (real token usage, monthly + per-day KV rollup) [M]

**Context.** `src/core/ledger.ts` doesn't exist. It tracks every command transaction with cost data so `!cost` can answer accurately and the daily-budget gate (P1-14) has data to read.

**KV layout (in `TS_LEDGER`):**
- `ledger:<YYYY-MM>` — single JSON object per month with running totals (no TTL — kept indefinitely).
- `ledger:<YYYY-MM-DD>` — single JSON object per day with running totals (TTL 8 d — covers the budget-gate window with margin).
- Shape (both keys): `{ period, requests, prompt_tokens, completion_tokens, usd_cost, by_command, last_update_ms }`.

Reads + writes are read-modify-write — KV is eventually consistent, so concurrent writes can lose updates. Acceptable at α volume (< 1 msg/sec). Phase 3 migrates to D1 (SQL) for proper transactionality.

**Acceptance criteria:**
- [ ] `src/core/ledger.ts` exports:
  - `recordTransaction({ command, usage, env }): Promise<{ usd_cost: number }>` — writes both `ledger:<YYYY-MM>` and `ledger:<YYYY-MM-DD>` atomically (one after the other; if the second write fails, log but don't throw).
  - `monthlyTotals(env, yyyymm?): Promise<LedgerSnapshot>`
  - `dailyTotals(env, yyyymmdd?): Promise<LedgerSnapshot>`
- [ ] `usd_cost` calculated from `LLM_INPUT_COST_PER_1K` × prompt_tokens + `LLM_OUTPUT_COST_PER_1K` × completion_tokens; non-AI commands record `usage = { prompt_tokens: 0, completion_tokens: 0 }` and `usd_cost = 0`.
- [ ] Read-modify-write with one-retry-on-conflict (re-read, recompute, re-put) — log `ledger_concurrent_write` if the second write also conflicts, but still return success (we've recorded the cost; the KV write is best-effort).
- [ ] Vitest: append a transaction to a fresh month, assert running totals; append two in series, assert sum; per-day totals match per-month for transactions in the same day.

**Plain-language note.** "Eventually consistent" means: when the Worker writes a key, a reader at the same edge sees it immediately, but readers at other edges may see the old value for up to ~60 seconds. Concurrent writes from different edges can race — last-write-wins. For α, single-operator and < 1 msg/sec means concurrent writes don't happen.

**Size:** M.
**Depends on:** P1-04 (uses `LLM_*_COST_PER_1K`).

---

#### P1-12 — Context window module (per-IMEI rolling 5-event cache) [S]

**Context.** `src/core/context.ts` doesn't exist. It stores the last 5 position+message events per IMEI in `TS_CONTEXT` (`ctx:<imei>`, TTL 30 d). Phase 1 use: `!post` narrative module reads recent positions to seed the LLM prompt with movement context (e.g. "moved from glacier to camp"). Phase 2 use: `!brief` aggregates these into a daily summary.

**Acceptance criteria:**
- [ ] `src/core/context.ts` exports:
  - `appendEvent(imei, event, env): Promise<void>` — appends, drops oldest beyond 5.
  - `recentEvents(imei, env): Promise<Event[]>` — returns up to 5, newest-first.
- [ ] Event shape: `{ timestamp, lat?, lon?, command_type, free_text }`. lat/lon both optional and dropped on no-fix.
- [ ] Read-modify-write semantics same as ledger; KV TTL 30 d (extended on every append).
- [ ] Vitest: append 6, assert 5 retained (oldest dropped); appendEvent on cold key initializes empty array.

**Size:** S.
**Depends on:** none.

---

#### P1-13 — Op-level idempotency checkpoints + `withCheckpoint` helper [M]

**Context.** PRD §5 specifies that the idempotency record evolves as sub-ops complete. The current `src/core/idempotency.ts` only handles the receipt phase (`status: "received"`). Phase 1 needs to append per-op checkpoints so a replayed webhook skips already-done expensive ops (LLM call, blog commit, email send, task create, reply send).

**Record shape extension:**
```typescript
{ status: "received" | "processing" | "completed" | "failed",
  receivedAt: number,
  completedOps: ("narrative" | "publish" | "mail" | "todo" | "reply")[],
  opResults?: Record<string, unknown>,  // cached return values per op
  completedAt?: number,
  failedAt?: number,
  error?: string }
```

**Integration helper.** All command handlers (P1-16/17/18) integrate the same way via:

```typescript
withCheckpoint<T>(env, idemKey, opName, fn: () => Promise<T>): Promise<T>
```

If `opName` is already in `completedOps`, returns the cached result from `opResults[opName]` without invoking `fn`. Otherwise calls `fn`, stores the result in `opResults[opName]`, appends `opName` to `completedOps`, and returns the result. Read-modify-write per call. This keeps replay logic identical across commands.

**Acceptance criteria:**
- [ ] `src/core/idempotency.ts` extends record shape as above (zod-validated on read).
- [ ] Exports `withCheckpoint(env, idemKey, opName, fn)` — wraps fn with read-cached-result-or-call-and-store semantics.
- [ ] Exports `markFailed(env, idemKey, error)` — sets `status="failed"`, `failedAt`, `error`.
- [ ] On replay: if `record.status === "completed"`, return immediately with no side effects (existing behavior, but now also no reply re-send).
- [ ] On replay with `status === "processing"` or `"failed"`: `withCheckpoint` calls let already-done ops short-circuit; remaining ops retry.
- [ ] `opResults` values must be JSON-serializable (Worker KV constraint); helper throws if a callback returns a non-serializable value.
- [ ] Vitest: `withCheckpoint` first-call invokes fn and stores result; replay returns cached result without invoking fn; failed op (fn throws) does not store in `completedOps`.
- [ ] Vitest: mock a `!post` that succeeds at narrative + publish but fails at reply; replay; assert narrative + publish are not re-called and only reply is retried.

**Plain-language note.** "Replay" here means Garmin re-sends the *same webhook payload* (same `idempotency_key`) because we 200'd late, the device retransmitted, or the user manually retried. We can detect this by KV lookup. Without checkpoints we'd duplicate the OpenRouter call (\$0.03 wasted) and republish the blog post.

**Size:** M.
**Depends on:** none.

---

#### P1-14 — Daily token budget gate [S]

**Context.** PRD §6 D4: `DAILY_TOKEN_BUDGET=50000` tokens/day. Before `!post` calls OpenRouter, check today's running total in the ledger. If `tokens_today + estimated_prompt_tokens > budget`, return the canned message and don't call.

**Acceptance criteria:**
- [ ] `src/core/budget.ts` exports `checkBudget(env, estimated): Promise<{ allowed: boolean, remaining: number }>`.
- [ ] Reads today's tokens via `dailyTotals(env)` (P1-11).
- [ ] `estimated_prompt_tokens` is a fixed constant for now (`ESTIMATED_POST_TOKENS = 400`); P3 will measure historical p95.
- [ ] On `allowed=false`, command handler returns `"Daily AI budget reached. Retry tomorrow or raise DAILY_TOKEN_BUDGET."` (≤ 80 chars).
- [ ] If `DAILY_TOKEN_BUDGET=0`, gate is disabled (always allowed).
- [ ] Vitest: budget=1000, two-300-token transactions allowed, third rejected; budget=0, all allowed.

**Size:** S.
**Depends on:** P1-11.

---

### Theme E — Reply formatter

#### P1-15 — Reply builder: 320-char budget, two-SMS paging, optional cost suffix, link injection [M]

**Context.** Multiple commands generate reply content and the device only accepts ≤ 160 chars per message. The reply builder takes a `CommandResult` (body string + optional lat/lon) and produces 1–2 strings each ≤ 160. If `APPEND_COST_SUFFIX=true`, the suffix `· $X.XX` is appended to the *last* page and counts against the budget.

When lat/lon are present, the reply includes Google Maps + MapShare links (already implemented in `src/core/links.ts`), trimmed to fit. When lat/lon are absent (no GPS fix), no map links are emitted.

**Acceptance criteria:**
- [ ] `src/core/reply.ts` exports `buildReply({ body, lat?, lon?, costUsdMtd?, env }): string[]` returning 1 or 2 strings.
- [ ] Each string ≤ 160 chars (asserted; throws on violation — caller bug).
- [ ] If body + links + suffix ≤ 160: one message.
- [ ] Otherwise: page-split. Append `(1/2)` and `(2/2)` markers (5 chars each, counted in budget).
- [ ] Maps link is `buildGoogleMapsLink(lat, lon, env)`; MapShare is `buildMapShareLink(env)`. Both included on the page that has room. **Both omitted entirely** when lat/lon are undefined.
- [ ] If `APPEND_COST_SUFFIX=true`: ` · $X.XX` (9 chars) appended to last page; if it overflows, truncate body, not suffix.
- [ ] Vitest cases: short reply, one-page-with-links, long reply needing two pages, with-and-without cost suffix, lat/lon absent (no map link emitted, including no `?q=0,0`).

**Plain-language note.** Iridium's 160-char limit is the same hard cap as legacy SMS; messages 1 byte over get rejected with `422 InvalidMessageError`. Two-message paging is the only way to deliver 161–320 chars. Beyond 320 we route content to email/blog and reply with just a confirmation.

**Size:** M.
**Depends on:** none.

---

### Theme F — Command handlers

#### P1-16 — `!post` pipeline (geocode + weather + narrative + publish + reply) [L]

**Context.** Compose the end-to-end happy path for `!post <note>`:

1. Parse → `{ type: "post", note }`.
2. Lookup recent context (P1-12) for the prompt.
3. **If lat/lon present:** reverse-geocode (P1-09) → place name (cached) and fetch weather (P1-10) → conditions string (cached). Skip both when no GPS fix.
4. Generate narrative (P1-05) → `{ title, haiku, body, usage }`. Wrapped in `withCheckpoint(...,"narrative")`.
5. Commit to journal repo (P1-08) → `{ url, sha }`. Wrapped in `withCheckpoint(...,"publish")`.
6. Record ledger transaction (P1-11).
7. Append context (P1-12).
8. Build reply (P1-15): `"Posted: <title> · <url>"` plus map link if lat/lon present. Reply send wrapped in `withCheckpoint(...,"reply")`.

Every side-effecting step (4, 5, 8) goes through `withCheckpoint` (P1-13) so replay skips already-done ops automatically.

**Acceptance criteria:**
- [ ] `src/core/commands/post.ts` exports `handlePost(cmd, ctx): Promise<CommandResult>`.
- [ ] Budget gate (P1-14) check before step 4; on rejection, return canned message and skip narrative+publish.
- [ ] Steps 3 and the reply's map link skipped cleanly when `ctx.lat`/`ctx.lon` undefined; no errors, no "unknown location" in narrative when GPS is absent (narrative module accepts undefined).
- [ ] On any per-step failure, `markFailed` + return a short error reply.
- [ ] Replay: a `!post` that completed steps 4–5 but failed at 8 must not re-run 4 or 5 on retry — `withCheckpoint` returns cached results.
- [ ] Vitest integration test: end-to-end with mocked external HTTP, asserts narrative + publish + ledger written; replay variant asserts no re-publish.
- [ ] Vitest no-GPS variant: asserts geocode + weather not called, no map link in reply, narrative still generated.
- [ ] Manual staging test (documented in story completion note): one real `!post` from the device produces a real markdown commit and a real device reply.

**Size:** L.
**Depends on:** P1-05, P1-08, P1-09, P1-10, P1-11, P1-12, P1-13, P1-14, P1-15, P1-02.

---

#### P1-17 — `!mail` pipeline (geocode + weather + Resend + reply) [M]

**Context.** Pipeline for `!mail to:_ subj:_ body:_`:

1. Parse → `{ type: "mail", to, subj, body }`.
2. **If lat/lon present:** reverse-geocode (P1-09) + weather (P1-10).
3. Compose enriched email body. With GPS: original body + `"\n\n---\nFrom inReach @ <place> (<lat,lon>, <weather>) — sent <ISO>"`. Without GPS: `"\n\n---\nFrom inReach — sent <ISO>"`.
4. Send via Resend (P1-06). `withCheckpoint(...,"mail")`.
5. Record ledger transaction (no LLM cost).
6. Append context.
7. Build reply: `"Sent to <to>"` + map link if lat/lon present. `withCheckpoint(...,"reply")`.

**Acceptance criteria:**
- [ ] `src/core/commands/mail.ts` exports `handleMail(cmd, ctx): Promise<CommandResult>`.
- [ ] Validate `to` is a syntactically valid email (zod or simple regex); reject early with `"Bad to: <to>"`.
- [ ] Replay: skips Resend send if `mail` op complete (via `withCheckpoint`).
- [ ] No-GPS path: footer omits location; reply omits map link.
- [ ] On Resend 4xx: return `"Mail failed: <Resend code/msg>"` (truncated to 80 chars).
- [ ] Vitest integration: end-to-end with mocked HTTP; replay variant; no-GPS variant.
- [ ] Manual staging test: one real `!mail` to a held-out recipient confirms delivery.

**Size:** M.
**Depends on:** P1-06, P1-09, P1-10, P1-11, P1-12, P1-13, P1-15, P1-02.

---

#### P1-18 — `!todo` pipeline (Todoist + reply) [S]

**Context.** Pipeline for `!todo <task>`:

1. Parse → `{ type: "todo", task }`.
2. Create Todoist task (P1-07). `withCheckpoint(...,"todo")`.
3. Record ledger.
4. Append context.
5. Build reply: `"Task added · <url>"`. `withCheckpoint(...,"reply")`.

**Acceptance criteria:**
- [ ] `src/core/commands/todo.ts` exports `handleTodo(cmd, ctx): Promise<CommandResult>`.
- [ ] Replay: skips Todoist create if `todo` op complete.
- [ ] On Todoist 4xx: return `"Todo failed: <code/msg>"`.
- [ ] Vitest integration; replay variant; no-GPS variant (description omits coords cleanly).
- [ ] Manual staging test.

**Size:** S.
**Depends on:** P1-07, P1-11, P1-12, P1-13, P1-15, P1-02.

---

#### P1-19 — `!ping`, `!help`, `!cost` real reply paths [S]

**Context.** Existing orchestrator returns canned strings for these. P1-01 wired the orchestrator to the request path; this story finishes the loop by sending the reply via `sendReply` (P1-02) and, for `!cost`, reading real ledger data (P1-11).

**Acceptance criteria:**
- [ ] `!ping` → `pong` delivered via IPC Inbound; ledger gets a 0-cost transaction.
- [ ] `!help` → reply equals current `helpText()` output; budget-builder pages it (it's ≈ 100 chars; one message).
- [ ] `!cost` → reads `monthlyTotals(env)`, formats `"<requests> req · <tokens>k tok · $<cost> (since <YYYY-MM-01>)"` (≤ 80 chars).
- [ ] Vitest integration tests: each command, end-to-end with mocked `sendReply`.
- [ ] Manual staging test: `!ping` → `pong` on the device.

**Size:** S.
**Depends on:** P1-01, P1-02, P1-11, P1-15.

---

### Theme G — End-to-end verification

#### P1-20 — Journal repo bootstrap (one-time setup) [S]

**Context.** P1-08 commits markdown to `GITHUB_JOURNAL_REPO`; that repo must exist with a working theme before `!post` can produce a viewable blog. This story also pins `JOURNAL_URL_TEMPLATE` to whatever URL pattern the chosen theme produces, so reply links don't 404.

**Acceptance criteria:**
- [ ] Repo `brockamer/trailscribe-journal` (or whatever the user picks) created, public.
- [ ] GitHub Pages enabled, source = `main` branch, `/` root.
- [ ] Theme picked: Jekyll `minima` (recommended — zero-config, GitHub builds automatically) or Hugo `terminal`-style (needs an Action). Theme committed.
- [ ] `content/posts/2026-04-26-hello.md` placeholder committed with the same frontmatter shape P1-08 emits; visible at the public Pages URL.
- [ ] **Pin `JOURNAL_URL_TEMPLATE`** in `wrangler.toml` to match the theme's actual URL pattern (Jekyll default: `{owner}.github.io/{repo}/{yyyy}/{mm}/{dd}/{slug}.html`). Verify by clicking the placeholder post's URL.
- [ ] Fine-grained PAT with `contents:write` scoped to *only* this repo generated; stored as `GITHUB_JOURNAL_TOKEN` secret in staging + production via `wrangler secret put`.
- [ ] `docs/setup-cloudflare.md` updated with the journal-repo setup steps (theme choice, Pages config, PAT scoping, URL template).

**Size:** S.
**Depends on:** none (user-performed setup; no code).

---

#### P1-21 — Staging burn-in: 6 commands × real APIs [M]

**Context.** Final integration check before prod. Every command exercised against real third-party APIs from the staging Worker, with logs captured and ledger inspected.

**Acceptance criteria:**
- [ ] Tested from device or fixture: `!ping`, `!help`, `!cost`, `!post`, `!mail`, `!todo` each round-trip successfully.
- [ ] `wrangler tail --env staging` log capture pasted into the story completion note showing one full transaction per command.
- [ ] Ledger inspected via `wrangler kv key get "ledger:2026-MM" --binding TS_LEDGER --env staging` — totals match the count of transactions performed.
- [ ] Reply received on the device for each command.
- [ ] Smoke test of guards: send a `!post` with a no-GPS fixture and a `messageCode=0` breadcrumb; assert no false replies, narrative succeeds without enrichment.
- [ ] If any command fails: file the bug, fix, retest. Do not advance to P1-23.

**Size:** M.
**Depends on:** P1-16, P1-17, P1-18, P1-19, P1-20.

---

#### P1-22 — Idempotency replay verification [S]

**Context.** PRD success criterion: 0 duplicate side-effects across 10 manual replays.

**Acceptance criteria:**
- [ ] Test plan documented: 10 `curl` invocations replaying the same webhook payload to staging with the same bearer token. Mix of `!post`, `!mail`, `!todo` (the side-effecting commands).
- [ ] After each replay: assert journal repo did not get a new commit; Resend dashboard shows 1 email (not 11); Todoist shows 1 task; `wrangler tail` shows `idempotent_replay` log entries; only one ledger transaction recorded.
- [ ] Story completion note: paste the assertion outputs.

**Size:** S.
**Depends on:** P1-21.

---

#### P1-23 — Cost measurement (20 real `!post` transactions) [S]

**Context.** PRD success criterion: per-tx cost ≤ \$0.05 measured across 20 transactions.

**Acceptance criteria:**
- [ ] 20 real `!post` transactions executed (can be from the device or via curl-fixture; LLM cost is what matters).
- [ ] Ledger inspected; per-transaction USD cost computed (`usd_cost / requests` for `post`-type only).
- [ ] Mean ≤ \$0.05; max ≤ \$0.05 (hard ceiling \$0.08 per PRD §7).
- [ ] If mean > \$0.05: investigate (prompt too long? wrong model?) and either tune or escalate; do not advance to prod.
- [ ] Story completion note: ledger snapshot + per-tx breakdown.

**Size:** S.
**Depends on:** P1-21.

**Note on production cutover.** First production deploy + cutover from staging is tracked separately in [#32 — Production Cloudflare setup](https://github.com/brockamer/trailscribe/issues/32) and [#33 — Re-enable auto-deploy](https://github.com/brockamer/trailscribe/issues/33), under the **Production-readiness** milestone. Phase 1 closes when staging burn-in (P1-21), idempotency (P1-22), and cost measurement (P1-23) all pass. Production is a separate gate.

---

## Sizing summary

| Size | Count |
|---|---|
| S | 12 |
| M | 10 |
| L | 1 |

**Rough total:** ~5–7 focused days of work. Real-API integration is more involved than scaffolding; budgeting for one full day on `!post` (P1-16) alone, plus ~half-day per other adapter.

## Execution order (recommended sequencing)

**Critical path:** P1-04 → P1-03 → P1-05 (LLM stack) and P1-02 (reply send) and P1-11 (ledger) before P1-16 (`!post` is the most complex command). Then P1-21 → P1-22 → P1-23 to close.

**Parallel tracks (any order, once unblocked):**
- Adapters: P1-06, P1-07, P1-08, P1-09, P1-10 — independent; can land concurrently.
- Core supporting: P1-12, P1-13, P1-14 — can land alongside adapters.
- P1-20 (journal-repo bootstrap) is user-performed setup; should happen early so P1-08 has the URL template to validate against.

**Suggested sprint shape (2-week sprint):**
- Days 1–2: P1-01 (with guards), P1-02, P1-03, P1-04 (orchestrator + LLM rename — clears the foundation).
- Days 3–4: P1-05, P1-06, P1-07, P1-09, P1-10 (LLM real call + simple adapters).
- Day 5: P1-08 (GH Pages — meatiest adapter), P1-20 (journal repo, in parallel).
- Days 6–7: P1-11, P1-12, P1-13, P1-14, P1-15 (core support + reply formatter).
- Days 8–9: P1-16 (the big one), P1-17, P1-18, P1-19.
- Day 10: P1-21 → P1-22 → P1-23 → milestone close.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OpenRouter rate-limits or model availability changes | M | Block `!post` | Default to a widely-available model (`openai/gpt-5-mini`); env var lets us swap in seconds. Alert on 429 spike. |
| GitHub fine-grained PAT setup blocks P1-20 | M | Block `!post` end-to-end | P1-20 is intentionally early in the sprint; PAT scoping doc steps in `docs/setup-cloudflare.md`. |
| `JOURNAL_URL_TEMPLATE` mismatch with chosen theme | L | Reply links 404 | P1-20 verifies the placeholder post URL before pinning the template. |
| Resend free-tier limits (3000/mo, 100/day) | L | `!mail` failures during burn-in | Sufficient for α volume; track in ledger; upgrade if needed. |
| Nominatim rate-limits or User-Agent banning | L | `!post` enrichment fallback to "unknown" | Cache aggressively (24 h, ~11 m grid); identify in `User-Agent`. Worst case: returns "unknown location" — non-fatal. |
| KV concurrent-write races on ledger | L | Lost transaction | Read-modify-write with one retry; log when retry fails. Single-operator α volume makes this rare. |
| Cost drifts above \$0.05/tx with `gpt-5-mini` | L–M | Fails P1-23 | Tune prompt length (≤ 300 tokens output); fall back to `openai/gpt-4o-mini` or similar. PRD allows hard ceiling \$0.08. |
| 160-char Iridium cap rejects edge-case replies | L | 422 from IPC Inbound | P1-15 asserts ≤ 160 per page in code; CI test forces violation and asserts the throw. |
| Garmin tenant credentials drift between staging and prod | L | Prod webhook auth fails | Each env has its own `GARMIN_INBOUND_TOKEN` and `GARMIN_IPC_INBOUND_API_KEY` secrets; staging proves the path before prod cutover. |
| Breadcrumb spam if guard 1 regresses | L | UX fail + cost | P1-01 Vitest case for messageCode=0 — regression-locked. |

---

## Out of scope for Phase 1

- **Phase 2+ commands:** `!where`, `!weather`, `!drop`, `!brief`, `!ai`, `!camp`, `!share`, `!blast`. Deferred per PRD §2.
- **Production cutover:** First prod deploy, custom domain, prod DNS for Resend custom-domain sender. Lives in **Production-readiness** milestone (#32, #33, #25, #26).
- **Durable Objects / D1 migration:** Phase 2+. KV is sufficient for α volume.
- **Photo/media support:** Schema V4 + R2 + image resizing. Post-v1.0.
- **Multi-user or team features:** Single-operator α.
- **Web dashboard:** Headless API only for α.
- **Email-fallback reply path:** Skipped for α per locked decision D9.
- **Ledger budget alerts / dashboards:** Phase 3.
- **Resend custom-domain sender:** Production-readiness #25 (not blocking α).

---

## Sign-off gate

After every checkbox in **Milestone exit criteria** is true:

1. Walk through this checklist on the `phase-1-alpha-mvp` PR or issue #34.
2. Confirm each item with a citation (commit, log capture, ledger snapshot).
3. Move issue #34 to Done; close epic #30; close the **Phase 1 — α-MVP** milestone.
4. Archive this plan to `plans/archived/2026-MM/phase-1-alpha-mvp.md` (mirror Phase 0's pattern: `plans/archived/2026-04/phase-0-scaffolding.md`).
5. Propose `plans/phase-2-beta.md` covering the deferred commands and DO/D1 migration.

**No production deploy until** P1-21 + P1-22 + P1-23 are all green. Production cutover is its own gate, tracked under Production-readiness.
