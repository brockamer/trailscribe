# TrailScribe — Product Requirements Document

**Status:** **Signed off 2026-04-22.** All decisions D1–D9 resolved. Proceed to Phase 0 (see `plans/phase-0-scaffolding.md`).
**Owner:** Brock Amer
**Updated:** 2026-04-22
**Scope:** α-MVP (Phase 1). Later phases referenced for alignment, not specified in full.

---

## 1. Product Summary

### Problem
Satellite messengers (Garmin inReach) keep off-grid users safe but isolate them from modern digital tools. Users can send 160-character texts; they cannot journal, file tasks, email with context, or leverage AI from the field. Today's workarounds — manual transcription after a trip, terse `OK AT CAMP` messages, entire rest days spent catching up in cafés — destroy productivity and erode the connection that motivates satellite ownership in the first place.

### Product
TrailScribe is an AI-native serverless agent that transforms satellite messages into rich, actionable workflows. From an inReach, a user sends a compact `!command`; TrailScribe receives the webhook, enriches context (location → place name, weather, map links), invokes an LLM where appropriate, performs the action (publish blog post, send email, create task), and replies with a concise confirmation that fits satellite size limits.

### Core value proposition
- **One command** replaces a manual sequence that previously required cell coverage.
- **AI narrative generation** turns GPS + short note into a publishable blog entry.
- **Under $0.05 per transaction** — total cost for the entire enriched workflow, less than a single premium satellite message.
- **Zero configuration in the field** — all integrations pre-wired; no device-side setup during the trip.
- **Bandwidth-respecting** — replies capped at two SMS (≤320 chars) including cost suffix.

### Personas (from product decks — canonical)

**Natalie — Field Botanist, Eastern Sierra.** 10–15 days/month at 8k–13k ft, documenting rare plant populations. Uses `!post` for timestamped, geotagged field entries and `!mail lab@university.edu` to enrich specimen-ID requests with coordinates, elevation, and weather. Eliminates 4–6 hrs/trip of post-trip transcription. Her winning outcome: the field journal writes itself.

**Marcus — Expedition Guide, PNW / Alaska / Patagonia.** 8–12 day trips, 6–10 clients. Sends evening `!post` updates that families can follow; uses `!mail ops@company.com` when conditions change. Each update publishes to a private expedition blog. Displaces multiple $0.50 fragmented messages per operational event. Winning outcome: professional-grade client communication from the backcountry.

**Yuki — Solo Bikepacker and Digital Storyteller.** 3–6 week trips through Iceland, Mongolia, Patagonia. Has 45k followers; sponsor income depends on consistency. `!post` publishes a narrative the moment she sees something, with elevation/weather/place name auto-attached. Eliminates café data-entry days. Winning outcome: blog never goes dark.

### Non-goals (MVP)
- No web dashboard, no photo upload, no multi-user/team features, no SOS integration, no voice, no offline-device logic.
- No `!blast`, `!share`, `!camp`, `!brief`, `!drop`, `!where`, `!ai` commands. All deferred (see §8).
- No Pipedream / n8n / generic deploy. Workers-only for α.
- No non-inReach device support. Architecture is adapter-based; other devices deferred.

---

## 2. MVP Scope

### Commands (α-MVP)

| Command | Purpose | External calls | Owner in decks |
|---|---|---|---|
| `!post <note>` | Journaling. Enriches position → narrative `{title, haiku, body}` → publishes to GitHub Pages journal. | LLM (OpenRouter), Nominatim (cached), Open-Meteo (cached), GitHub Pages (markdown commits) | Natalie, Marcus, Yuki |
| `!mail to:_ subj:_ body:_` | Enriched email. Appends coordinates, place name, elevation, weather, map links. | Nominatim (cached), Open-Meteo (cached), Resend | Natalie, Marcus |
| `!todo <task>` | Creates a task in Todoist with GPS + timestamp in note. | Todoist | Natalie |
| `!ping` | Health check → `pong`. | — | operational |
| `!help` | Command summary. | — | operational |
| `!cost` | Month-to-date request count, tokens, USD. | — | operational |

### Explicit deferrals (with reason)

| Command / feature | Deferred to | Why deferred |
|---|---|---|
| `!where` | Phase 2 | Bandwidth-expensive pure-read; replaces MapShare (user already has). Low marginal value vs. map links in every reply. |
| `!drop` (FieldLog) | Phase 2 | Requires persistent FieldLog store (D1 table or sheet). MVP punts structured journaling; unstructured `!post` covers the journaling narrative. |
| `!brief` | Phase 2 | Depends on FieldLog + ledger + message history aggregation. Nothing to summarize until `!drop`/`!post` volume exists. |
| `!camp` | Phase 3 | Real web search integration; heavy on tokens and latency. Fails satellite UX without tight constraints we haven't proven yet. |
| `!ai <q>` | Phase 3 | Large AI replies chunked to SMS is a UX research problem (see radio-llm precedent). MVP embeds AI in `!post`'s narrative where structure is constrained. |
| `!share` | Phase 4 | Variant of `!mail`; adds contact-book config. Marginal over `!mail` with a manual address. |
| `!blast` | Phase 4 | Broadcast to groups needs address-book config + multi-recipient error handling. Not blocking MVP. |
| Photos / media | Post-v1.0 | Schema V4 + R2 + image resizing. Big ask; MVP proves text workflow first. |
| Web dashboard | Post-v1.0 | Trip visualization is a separate product surface. MVP is headless. |
| `!weather` | Phase 2 | Referenced in Marcus's deck example; not in the "three commands" summary. Cheap to add post-α once `context` module is real. |

### Reply budget (hard contract)
- **Max total reply: 320 characters** (2 SMS, Iridium 160-char frame × 2). Applies to EVERY command's reply, including `!post` confirmation, `!help`, `!cost`, etc.
- If `APPEND_COST_SUFFIX=true`, the `· $X.XX` suffix counts against the budget.
- When coordinates exist, the reply includes Google Maps + MapShare links (counted against budget). Reply body is truncated to fit.
- Longer content (narratives, full help) goes to email/blog, not the device reply.

### Success criteria for α-MVP
- 6 commands work end-to-end with real APIs.
- Per-transaction cost ≤ $0.05 measured across 20 real transactions.
- Delivery success rate ≥ 99% over 50 transactions (excluding Iridium/Garmin outages).
- Idempotency: zero duplicate side-effects on duplicate webhook delivery across 10 intentional-replay tests.
- Budget: month-to-date cost visible via `!cost` and always matches ledger.

---

## 3. Architecture

### Target: Cloudflare Workers + KV (Phase 1)
Endorsed by the deep research report and consistent with the original engineering spec. Workers give us:

- **Serverless idempotency** via KV bindings (no stateful server to manage).
- **Secrets management** via `wrangler secret put` (vs. `.env` leakage risk).
- **Global edge** — cold-start insensitive, suitable for Garmin's near-real-time webhook latency tolerance.
- **Cost model** at MVP scale is effectively $0 infrastructure (Free tier covers expected volume; LLM + email API dominate).

### Layered architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1 — Inbound Gateway                                      │
│  Cloudflare Worker (Hono) — POST /garmin/ipc                    │
│  • Verify bearer token (shared secret)                          │
│  • Parse Garmin Event Schema V2/V3                              │
│  • Enforce IMEI allowlist                                        │
│  • Idempotency check (KV) — short-circuit on duplicate          │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2 — Command Processor                                    │
│  parseCommand(freeText) → ParsedCommand                         │
│  • Salvaged from existing src/agent/grammar.ts (with bugfixes)  │
│  • Typed discriminated union                                    │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3 — Orchestrator                                         │
│  Dispatch by command type → pipeline                            │
│  • Partial-failure checkpoints (KV state per sub-op)            │
│  • Budget check against ledger before expensive ops             │
│  • Accurate token accounting via LLM usage field                │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4 — Tool Adapters                                        │
│  • narrative.ts      (LLM via OpenRouter, JSON → t/h/b)         │
│  • mail/resend.ts    (Resend API)                               │
│  • todoist.ts        (Todoist REST API)                         │
│  • publish/github-pages.ts  (GitHub Contents API)               │
│  • geocode.ts        (Nominatim, cached 24h)                    │
│  • weather.ts        (Open-Meteo, cached 1h)                    │
│  • ipc-inbound.ts    (Garmin POST /Messaging.svc)               │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Layer 5 — Outbound Reply                                       │
│  Garmin IPC Inbound /Messaging.svc (X-API-Key auth)             │
│  α: on failure, log degraded_reply (no email-fallback per D9)   │
└─────────────────────────────────────────────────────────────────┘
```

### KV namespaces (α-MVP)

| Binding | Purpose | Key pattern | TTL |
|---|---|---|---|
| `TS_IDEMPOTENCY` | Dedup processed msgIds + op-level checkpoints | `idem:<key>` / `op:<key>:<op>` | 48h |
| `TS_LEDGER` | Monthly usage (req count, tokens, USD) | `ledger:<YYYY-MM>` | — |
| `TS_CONTEXT` | Per-IMEI rolling window (last 5 positions/messages) for narrative continuity | `ctx:<imei>` | 30d |
| `TS_CACHE` | Geocode + weather cache | `geo:<lat:4,lon:4>` / `wx:<lat:2,lon:2>` | geo 24h / wx 1h |

### Phased evolution (for alignment, not α)
- **Phase 2:** Migrate `TS_CONTEXT` → Durable Objects (strong consistency for rapid message sequences). Add Cloudflare Queues for async retries.
- **Phase 3:** Migrate `TS_LEDGER` → D1 (SQL analytics, per-user budgets, budget alerts). Add Analytics Engine.
- **Phase 4+:** R2 + Image Resizing for photos (schema V4 media events).

### Tech stack (α)
- **Runtime:** Cloudflare Workers
- **Language:** TypeScript (strict, ESM)
- **HTTP framework:** Hono (portable across Workers/Node/Bun; replaces Express from existing code)
- **Validation:** zod (env schema, request body validation)
- **Testing:** Vitest + Miniflare (replaces Jest — Workers-native)
- **Build/Deploy:** Wrangler via `deploy-cloudflare.yml` GitHub Action

### Salvaged from existing repo
Per Verdict B in onboarding (preserved):
- `src/agent/grammar.ts` → `src/core/grammar.ts` (subset commands; fix `!mail subj` regex)
- `ParsedCommand` discriminated union → `src/core/types.ts`
- `src/tools/links.ts` → `src/core/links.ts`
- Zod env-schema pattern → `src/env.ts` (expanded)
- All `docs/*` (updated for Workers target; n8n/Pipedream docs move to `docs/archive/`)
- Wiring diagram (update to show Workers instead of generic "webhook")

### Rebuilt (per Verdict B)
Every `src/tools/*.ts`, `src/runtime/*.ts`, `src/http/*.ts`. CI workflow. Pipedream/n8n/Workers examples (the Workers example becomes the canonical `src/index.ts`).

---

## 4. Transport

### Inbound: Garmin IPC Outbound webhook → Cloudflare Worker

**Authoritative source:** Garmin IPC Outbound Developer Guide v2.0.8 (09/08/2025).

**Endpoint:** `POST https://trailscribe.<subdomain>.workers.dev/garmin/ipc`

**Schema version for MVP: V2.** Rationale: simplest payload, covers all fields we need (`imei`, `messageCode`, `freeText`, `timeStamp`, `point{latitude,longitude,altitude}`, `addresses`, `status`). V3 adds only `transportMode` (satellite|internet); not worth the cost of having to handle two schemas at once. V4 adds media — deferred with photos. **We will configure Portal Connect for V2; code will tolerate V3/V4 fields if present (ignore `transportMode`, `mediaBytes`, etc.).**

**Request contract (Garmin → us):**
- `Content-Type: application/json`
- Body = `{ "Version": "2.0", "Events": [ <event>, ... ] }` — array may have >1 event
- We parse each event in the array independently; a failure on one event does not fail the others
- Response: **200 OK** always (with body `"ok"`). Anything else triggers Garmin's retry cycle (2/4/8/16/32/64/128s, then 12h pauses × 5 days → suspension). We do NOT want Garmin to retry for application-level errors; internal errors are swallowed, logged, and reported to the device via IPC Inbound reply.

**Auth (inbound):**
Garmin's IPC Outbound supports two auth modes per their docs:
1. **OAuth bearer** — Garmin calls customer's OAuth server, obtains token, includes in header. Requires running an OAuth endpoint.
2. **Static token** — customer provides a fixed token via Portal Connect; Garmin sends it in HTTP headers on every POST.

**Decision: static bearer token.** Rationale:
- OAuth adds an endpoint to build and a cert to rotate for zero security gain at MVP scale.
- Static token is a strong random secret stored in Wrangler Secrets (`GARMIN_INBOUND_TOKEN`).
- We verify `Authorization: Bearer <token>` on every POST; missing/mismatched → 200 OK with logged warning (to avoid triggering retry cascade on attacker probing) but short-circuits before any processing.

**⚠️ Conflict with task prompt:** You asked for HMAC on inbound. Garmin does not support HMAC signatures on IPC Outbound — the options are OAuth or static token. **Recommend static token for MVP** (swap to OAuth later if we need rotation automation). If you require HMAC behavior, we'd have to proxy Garmin's webhook through a second gateway we control — added complexity without materially different security properties.

**IMEI allowlist (defense-in-depth):**
Even with a valid token, we verify incoming `imei` is in `IMEI_ALLOWLIST` env var. Single-operator MVP has exactly one IMEI. Reject silently (200 OK) on miss.

### Outbound: Cloudflare Worker → Garmin IPC Inbound

**Authoritative source:** Garmin IPC Inbound Developer Guide v3.1.1 (10/10/2024).

**Endpoint:** `POST https://{tenant}.inreachapp.com/api/Messaging/Message` (IPCv2) or `https://{tenant-base}/IPCInbound/V1/Messaging.svc` (v1). We target **IPCv2** (`Messaging/Message`).

**Auth:** `X-API-Key: <key>` header. Key generated via explore.garmin.com Admin Controls → Portal Connect → Generate API Key. Stored in `GARMIN_IPC_INBOUND_API_KEY`.

**Request body:**
```json
{
  "Messages": [{
    "Recipients": ["<15-digit IMEI>"],
    "Sender": "trailscribe@<domain>",
    "Timestamp": "/Date(1666666666000)/",
    "Message": "<≤160 chars>"
  }]
}
```

**Critical limits:**
- **Message body: 160 characters MAX.** (Iridium hard limit enforced server-side; returns 422 `InvalidMessageError` on overage.)
- **Reply budget: 320 chars total** → we send **two messages** per reply when content exceeds 160. Reply builder pages content; each page gets a `(1/2)` / `(2/2)` suffix to preserve integrity across out-of-order delivery.
- **Timestamp:** `/Date(ms)/` format, must be now-ish (not future, not before 2011).
- **Response:** `{ "count": N }` on 200 OK. Error responses carry `{ Code, Message, Description, URL, IMEI }`.

**Reply-delivery failure (α).** Per D9 (§8), email-fallback to the device is **skipped for α**. If IPC Inbound returns 5xx/429 after 3 retries with exponential backoff, we write a ledger entry `reply_delivery: failed` and return 200 OK to Garmin. Side effects (blog post, email, task) still persist — only the reply confirmation failed. Surfaced via `!cost` and log inspection. Phase 2 will revisit if reliability data warrants adding a real email-fallback path.

### Retry / failure handling
- **Inbound-from-Garmin:** we never NACK for app errors (would cascade retries). We 200 OK and surface errors to the user via IPC Inbound reply (e.g., `"Error: Todoist auth failed"`).
- **Outbound-to-Garmin (IPC Inbound):** 3 retries with backoff 1s/4s/16s. After failure, log `reply_delivery: failed` to the ledger and return 200 OK upstream (no email-fallback in α — per D9). Side effects already persisted; only the reply confirmation is lost.

### Garmin Professional tier requirement
**⚠️ PREREQUISITE.** IPC Outbound + Inbound are Professional/Enterprise features only. Consumer inReach plans do not expose these APIs. This gates the entire architecture. If user does not have a Professional account, we must fall back to **Cloudflare Email Workers** as the inbound path (Garmin can forward device messages to an email, which CF Email Workers can ingest). This is a strict decision point — see §8.

---

## 5. Idempotency Spec

### Why this matters
Garmin's retry schedule is 2/4/8/16/32/64/128 seconds on non-200 response, then 12-hour pauses × 5 days. Users manually retry on slow replies. LLM/Resend/Todoist/GitHub Pages are all side-effect-bearing — a duplicate blog post or duplicate email is a real UX failure and real dollar cost (duplicate LLM call ≈ $0.03).

### Idempotency key derivation
```
idempotency_key = sha256( imei || ":" || timeStamp || ":" || messageCode || ":" || content_hash )
  where content_hash = sha256( freeText || payload || "" )
```
- `timeStamp` is Garmin's milliseconds-since-epoch — deterministic per device transmission.
- `messageCode` distinguishes Position Report (0) from Free Text (3); prevents accidental collisions across event types.
- `content_hash` covers `freeText` (most events) and `payload` (binary, media) — a device never re-sends identical content at identical timestamp unless it's a retry.
- No `msgId` field exists in Garmin's schema — the composite above replaces what the deep research called "message_id".

### Storage
- **KV key:** `idem:<idempotency_key>`
- **TTL:** 48 hours. Covers Garmin's 5-day worst-case? No — but Garmin's retry cycle only aggressively retries for the first ~4 minutes (128s back-off plateau); after that, pauses are 12h. The 48h window covers 100% of fast-retry cases and ~95% of user manual retries. A later deduplication is acceptable — a 72h-old message re-delivering is so rare we can log-and-proceed. **Trade-off:** TTL too long → KV cost. Too short → dupes. 48h is a pragmatic middle.

### Message lifecycle
Each event traverses:
```
received → processing → (per-op) checkpoints → completed | failed
```
- On receipt: write `idem:<key> = { status: "processing", receivedAt }` with TTL 48h.
- On each sub-op completion (e.g., `narrative_generated`, `blog_published`, `reply_sent`), overwrite with `{ status, <op>: true, ... }`.
- On final completion: `{ status: "completed", completedAt }`.
- On failure: `{ status: "failed", error, failedAt, completedOps: [...] }`.

### Partial-failure recovery
If the same webhook replays after partial completion:
- Read `idem:<key>`. If `status="completed"` → 200 OK, noop, send no new reply.
- If `status="processing"` or `"failed"` → consult completed sub-ops. Skip already-done ops, retry remainder.
- Example: `!post` completed `narrative_generated` + `blog_published` but failed on `reply_sent`. On replay, skip narrative + blog, only retry reply. Prevents duplicate blog posts / duplicate LLM calls.

### Guarantees
- **At-least-once for outbound side-effects** (reply delivery) because we accept best-effort and log degraded replies.
- **At-most-once for expensive side-effects** (LLM calls, blog publishes, email sends, task creation) via op-level checkpoints.
- **Exactly-once** is a Phase 2 target (Durable Objects give strong consistency). KV's eventual consistency is acceptable at MVP volume (<1 msg/second).

### Cost of idempotency
~$0.00001 per message in KV ops. Trivial vs. the $0.03 cost of a single duplicate LLM call. Pays for itself on the first prevented duplicate.

---

## 6. Cost Model

### Target: <$0.05 per transaction, $0.03 typical

### Per-command cost breakdown (estimated)

| Command | LLM | Publish/Email | Todoist | Nominatim | Open-Meteo | CF Infra | **Total** |
|---|---|---|---|---|---|---|---|
| `!post` | $0.020–0.030 | $0 (GitHub Pages) | — | $0 (free) | $0 (free) | $0.001 | **$0.021–0.031** |
| `!mail` | — | $0 (Resend free tier) | — | $0 (cached) | $0 (cached) | $0.0005 | **~$0.001** |
| `!todo` | — | — | $0 (free) | — | — | $0.0002 | **~$0.0002** |
| `!ping` | — | — | — | — | — | $0.0002 | **~$0.0002** |
| `!help` | — | — | — | — | — | $0.0002 | **~$0.0002** |
| `!cost` | — | — | — | — | — | $0.0002 | **~$0.0002** |

**Headline:** `!post` dominates cost. Non-AI commands are effectively free.

### LLM configuration
> Per issue [#31](https://github.com/brockamer/trailscribe/issues/31), the AI layer routes through **OpenRouter** rather than OpenAI directly. OpenRouter exposes one HTTPS API and one API key while letting us pick any model from many providers — same OpenAI-compatible request/response shape, different base URL and auth header. Lets us swap models without code changes.

- **Model:** `anthropic/claude-sonnet-4-6` (OpenRouter format `<provider>/<model>`). Swapped back from the brief `openai/gpt-5-mini` direction (2026-04-22 → 2026-04-25) after P1-21 burn-in proved gpt-5-mini is a *reasoning model* that consumes all completion tokens on chain-of-thought before producing the JSON output — caused empty-content failures on shorter prompts (no-GPS edge case). Claude Sonnet 4.6 is a non-reasoning model: structured JSON output is reliable within the configured `max_tokens` budget (currently 600), no chain-of-thought token consumption.
- **Output mode:** JSON mode with schema `{ title: string ≤60ch, haiku: string ≤80ch, body: string ≤500ch }`.
- **Prompt:** Concise system prompt with explicit length directives ("Respond in under 150 tokens", "haiku must be exactly 5-7-5").
- **Target token use:** ≤300 tokens per `!post` narrative (prompt + response). Actual $/tx depends on the current model's pricing — will be set in env (`LLM_INPUT_COST_PER_1K`, `LLM_OUTPUT_COST_PER_1K`) from the OpenRouter or model-provider pricing page at deploy time and updated when prices change. **Design assumes cost remains under $0.05/tx; alert if drift above $0.03 sustained.**

### Token accounting (ground truth)
- Read `usage.prompt_tokens` and `usage.completion_tokens` from the LLM response (OpenRouter mirrors the OpenAI response shape). **Never use character-count proxies** (as existing code does).
- Ledger records: `{ command, timestamp, prompt_tokens, completion_tokens, usd_cost, command_tags }`.
- Monthly rollup via `ledger:<YYYY-MM>` KV key.

### Daily budget enforcement
- `DAILY_TOKEN_BUDGET` env var (integer, 0 = unlimited).
- Before `!post` dispatches to the LLM, orchestrator checks today's token total. If `tokens_today + estimated_prompt > budget`, the command returns `"Daily AI budget reached. Retry tomorrow or raise DAILY_TOKEN_BUDGET."` and does NOT call the LLM.
- Non-AI commands (`!mail`, `!todo`, etc.) are not budget-gated — they have trivial cost.
- **My recommended default:** `DAILY_TOKEN_BUDGET=50000` (≈ 150 posts/day at full prompt+response). You'll want to set this with real numbers after one week of usage data.

### Reply cost suffix
- `APPEND_COST_SUFFIX=true` appends ` · $X.XX` (≤9 chars) to every reply.
- Suffix counts against the 320-char reply budget.
- Recommended: **false** for α (saves 9 chars on every reply), add later after user feedback.

### Cost visibility
- `!cost` reply format: `"123 req · 45.2k tok · $1.37 (since 2026-04-01)"` — 46 chars, fits in one SMS.
- Monthly budget alerts: Phase 3 feature (needs D1 for historical views).

---

## 7. Success Metrics

### Launch criteria for α-MVP (tight definition of "shipping")
- [ ] All 6 commands working end-to-end with real APIs (not stubs).
- [ ] First real satellite transaction from user's inReach → worker → reply on device.
- [ ] Idempotency verified: 10 manually replayed webhooks produce 0 duplicate side-effects.
- [ ] Cost: ≥20 real `!post` transactions show <$0.05 each in ledger.
- [ ] Secrets are in Wrangler Secrets (not committed, not in `.env` in staging).
- [ ] CI green on `main`, staging deployed, production deployed.

### Operational KPIs (track monthly)
- **Per-transaction cost** (target <$0.05; hard ceiling $0.08)
- **Delivery success rate** — inbound-received vs. reply-delivered (target ≥99% excluding Iridium/Garmin outages)
- **Command usage frequency** — per-command counts; informs Phase 2 scope
- **Idempotency hit rate** — should be <5% of inbound volume in steady state (higher = Garmin/Iridium retries = investigate)
- **Uptime** — Workers baseline is ~99.99%; target 99.5% for our code (excludes external API failures)
- **p50/p95 latency** — inbound-received to reply-sent. Target p95 <10s (AI calls dominate)
- **LLM token efficiency** — avg tokens per `!post`. Target ≤300 input+output; alert on drift.

### Non-launch-blocking but tracked
- Monthly active commands
- Blog post publish success rate (GitHub Contents API accepts the commit)
- Email delivery success rate (Resend doesn't bounce)
- Todoist task creation success rate

---

## 8. Risks & Open Decisions

### Resolved by new materials
- **License:** MIT, open source. ✅ (Confirmed by both decks.)
- **Deploy target:** Cloudflare Workers. ✅ (Endorsed by deep research.)
- **MVP commands:** `!post`, `!mail`, `!todo` + operational (`!ping`, `!help`, `!cost`). ✅ (From decks.)
- **Idempotency storage:** KV for α, Durable Objects later. ✅ (Deep research.)
- **Architecture direction:** Verdict B (selective rebuild) stands. ✅

### Signed off (2026-04-22)

- **D1. Inbound auth:** Static token stored as `GARMIN_INBOUND_TOKEN` Wrangler Secret. Garmin IPC Outbound sends the token as a raw value in the `X-Outbound-Auth-Token` header (not the standard `Authorization: Bearer` form — verified against the live Garmin gateway 2026-04-25). Rotation yearly.
- **D2. Garmin Professional tier:** Available. Full IPC Outbound + IPC Inbound path enabled.
- **D3. Schema version:** V2 for α. Code tolerant of V3/V4 fields.
- **D4. Daily token budget:** `DAILY_TOKEN_BUDGET=50000` tokens/day (≈ 150 `!post` narratives/day). Revise after one week of real usage.
- **D6. IPC Inbound primary reply + email fallback.** (Email fallback implementation depends on D9 — see below.)
- **D7. Branch rename:** `master` → `main` at Phase 0. Update `origin/HEAD`, GitHub default branch, CI target.

### Override (2026-04-22)
- **Model:** `claude-sonnet-4-6` (reverted from the brief `gpt-5-mini` swap after empirical burn-in failure on 2026-04-25 — see §LLM configuration). Per [#31](https://github.com/brockamer/trailscribe/issues/31), routed through OpenRouter as `anthropic/claude-sonnet-4-6`; env var is `LLM_MODEL` (provider-neutral). Cost per 1K pinned in `wrangler.toml`: `0.00015` input, `0.0006` output (OpenRouter pass-through pricing).

### Resolved 2026-04-22 (replaces "Still open" section below)

- **D5. Blog platform:** **GitHub Pages + markdown commits via GitHub Contents API.** Journal lives in a dedicated repo (e.g., `brockamer/trailscribe-journal`); Worker commits `_posts/YYYY-MM-DD-<slug>.md` with frontmatter. Theme TBD at Phase 0 (default: Jekyll `minima` for zero-config, swap to Hugo later if desired).
- **D8. Outbound email:** **Resend.** `RESEND_API_KEY` secret; `RESEND_FROM_EMAIL=trailscribe@resend.dev` for α, move to own-domain later. Replaces all Gmail OAuth bindings in §3.
- **D9. Email-fallback reply:** **skipped for α.** If IPC Inbound returns 5xx after 3 retries (1s/4s/16s backoff), write ledger entry `reply_delivery: failed` and return 200 OK to Garmin. Side effects (blog post, email, task) still persist. Revisit in Phase 2 if reliability data warrants.

### Original decision text (for reference)

**D5. Blog platform (Posthaven cancelled).**
Requirements: programmatic publish from a Worker, public blog, low setup/cost, clean reader UX.

Options considered:
| Platform | API | Cost | Reader UX | Setup |
|---|---|---|---|---|
| **GitHub Pages + markdown commits** | GitHub REST (you already have token) | $0 | Depends on theme (Jekyll/Hugo) | Add repo + theme |
| **Ghost (Pro)** | Ghost Admin API | $9/mo | Best-in-class | Account + API key |
| **Ghost (self-host)** | Ghost Admin API | Infra cost | Best-in-class | Real ops burden |
| **Bear Blog** | Limited (email-post add-on) | Free / $2 mo | Minimal / excellent | Account |
| **micro.blog** | MicroPub (IndieWeb) | $5/mo | Clean / IndieWeb-flavored | Account |
| **Substack** | Limited | Free | Email-first | Account |

→ **My recommendation: GitHub Pages + markdown commits via GitHub Contents API.**
- Reasons: you already have GitHub SSH/token set up; zero subscription; posts are durable markdown in a repo (easy to migrate, easy to audit, easy to edit after); Worker commits a file, done; satisfies Yuki-style "blog never dark" without vendor lock-in.
- Tradeoff: requires picking a theme (Hugo minimal theme like `hugo-theme-terminal` or Jekyll `minima` — 30min setup) and wiring a deploy action (GitHub's built-in Pages auto-builds Jekyll; Hugo needs one Action). Theme/deploy setup happens once at Phase 0; not in the hot path.
- Binding: repo name → `trailscribe-journal` or similar, public, branch `main`, path `_posts/YYYY-MM-DD-<slug>.md`.

→ **Thumbs-up / thumbs-down, or name a different platform.** If thumbs-up, I'll default the adapter to GitHub Pages in the Phase 0 plan and you can later swap for Ghost with a single-file change.

**D8. Dedicated outbound email (decoupled from personal Gmail).**
Your direction: decouple.

Options:
| Provider | Auth | Free tier | Worker fit | Sender domain |
|---|---|---|---|---|
| **Resend** | API key | 3k emails/mo, 100/day | Native (fetch + JSON) | `trailscribe@resend.dev` free, or own domain |
| **Postmark** | API key | 100/mo | Native (fetch) | Own domain required after trial |
| **SendGrid** | API key | 100/day | Native | Own domain |
| **New Gmail account** | OAuth refresh token | Free | Awkward in Workers | `<name>@gmail.com` |
| **Mailgun / SES** | API key | Paid-ish | Native | Own domain |

→ **My recommendation: Resend** with sender `trailscribe@resend.dev` for α (migrate to your own domain later when you have one).
- Reasons: API-key auth (no OAuth-refresh dance, which is miserable in Workers); generous free tier for a solo user; clean JSON API; fully decouples TrailScribe email from your personal identity; sender label `TrailScribe <trailscribe@resend.dev>` matches the product name.
- Caveat: Posthaven-style email-to-blog doesn't apply (we're using GitHub Pages per D5). Resend is the transactional path for `!mail` replies and (if enabled in D9) email-fallback.
- Implications for variable names: replace `GMAIL_SENDER` / `GMAIL_CLIENT_ID` / `GMAIL_REFRESH_TOKEN` / etc. with `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `RESEND_FROM_NAME`.

→ **Thumbs-up / thumbs-down, or name a different provider.** If you already have Mailgun/SES/Postmark in another project, say so and we'll reuse.

**D9. Device email for fallback reply (when IPC Inbound fails)?**
With D2=yes, IPC Inbound is the reliable path. Email fallback is belt-and-suspenders.

→ **My recommendation: skip email-fallback for α.** If IPC Inbound returns 5xx after 3 retries (1s/4s/16s backoff), log to ledger with `reply_delivery: failed`. The side-effect (blog post, email, task) still went through — only the reply confirmation failed. You'll see this via `!cost` or log inspection. Email-fallback adds complexity (need device email address + format assumptions) for a rare case. Revisit in Phase 2 if IPC Inbound reliability turns out to be a real problem.

→ **Thumbs-up** = no email-fallback for α. **Or** provide device email and I'll wire it.

### Non-blocking but worth flagging
- **Hono vs Express.** Hono is Workers-native, Express isn't. I'll use Hono. Mentioning so you don't reach for Express reflexively.
- **Vitest vs Jest.** Workers testing works much better with Vitest + Miniflare. Swapping at Phase 0.
- **Node-specific deps in existing code.** `express`, `ts-node-dev`, `axios` all go away. `zod` stays. No user decision needed.
- **MIT license boilerplate email / CoC email.** Both files use placeholder `[your‑email@example.com]`. I'll substitute your GitHub-email-of-record at Phase 0 unless you object.
- **README gets a substantial rewrite at Phase 0** to reflect Workers-first reality and kill the broken Pipedream example.

---

## 9. Phase 2+ (preview, not specified here)

For alignment only — each phase gets its own PRD/plan when we reach it.

- **Phase 2 — β-MVP (~2 weeks):** `!where`, `!weather`, `!drop` (FieldLog in KV for now), `!brief`. Migrate `TS_CONTEXT` to Durable Objects. Add Cloudflare Queues.
- **Phase 3 — v1.0 (~2 weeks):** `!ai`, `!camp`. Migrate `TS_LEDGER` to D1. Add budget alerts, usage dashboard. Multi-message chunking (per radio-llm pattern).
- **Phase 4 — v1.1 (~1 week):** `!blast`, `!share`. Contact book config.
- **Phase 5 — hardening (~1–2 weeks):** Rate limits, retry polish, observability dashboard, multi-month ledger.
- **Post-v1.0:** Photos (schema V4, R2 + Image Resizing), web dashboard, multi-user.

---

## 10. Approval

**Reviewer:** Brock Amer
**Sign-off action:** Answer D1–D9 in §8, with any edits to the PRD. Once sign-off is recorded (in chat or by editing this file), we proceed to Phase 0 scaffolding plan (`plans/phase-0-scaffolding.md`).

**Out of scope for this PRD:** code. No implementation until sign-off.
