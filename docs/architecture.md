# Architecture

TrailScribe is a single Cloudflare Worker that receives Garmin IPC Outbound
webhooks, dispatches `!command` actions to per-integration adapters, and
replies via Garmin IPC Inbound. All state lives in Cloudflare KV;
Durable Objects and D1 come in Phase 3. See [`PRD.md`](PRD.md) §3 for
design rationale and phased-evolution detail.

## System flow

```
 ┌────────────────┐         HTTPS POST           ┌─────────────────────┐
 │  Garmin inReach│ ────────────────────────────▶│  Garmin Gateway     │
 │   (device)     │                              │  (IPC Outbound)     │
 └────────────────┘                              └──────────┬──────────┘
                                                            │ JSON Event V2
                                                            ▼
                   ┌────────────────────────────────────────────────────┐
                   │  Cloudflare Worker  (src/index.ts → src/app.ts)    │
                   │                                                    │
                   │  POST /garmin/ipc                                  │
                   │    1. verify X-Outbound-Auth-Token header          │
                   │    2. env gate: checkEnv() (#212)                  │
                   │    3. parse Garmin V2 envelope                     │
                   │    4. per event:                                   │
                   │        a. IMEI allowlist check                     │
                   │        b. idempotency key (sha256 composite)       │
                   │        c. skip if idem:<key> is "completed"        │
                   │        d. skip if an image generation is in flight │
                   │        e. mc=3 Free Text  → grammar → orchestrator │
                   │           mc=10/12 Track  → tracking (Mode B)      │
                   │           other codes     → log and drop           │
                   │    5. ALWAYS return 200 OK to avoid retry cascade  │
                   │                                                    │
                   │  GET /health → { env_ok }                          │
                   └──┬──────────────────────────────────────────────┬──┘
                      │                                              │
              ┌───────┴───────┐                        ┌─────────────┴─────────────┐
              │  KV           │                        │  Tool adapters            │
              │  TS_IDEMPOTENCY TS_LEDGER              │  openrouter · replicate   │
              │  TS_CONTEXT   TS_CACHE                 │  resend · todoist         │
              │  TS_TRACKS    │                        │  github-pages · nominatim │
              └───────────────┘                        │  open-meteo · mapshare    │
                                                       └─────────────┬─────────────┘
                                                                     │
                                                                     ▼
                                  ┌─────────────────────────────────────────────┐
                                  │  Garmin IPC Inbound API                     │
                                  │  POST {base}/api/Messaging/Message          │
                                  │  Auth: X-API-Key: <key>                     │
                                  │  Body: ≤160 chars; pagination for two SMS   │
                                  └──────────────────────────┬──────────────────┘
                                                             │
                                                             ▼
                                                ┌────────────────────┐
                                                │  Garmin inReach    │
                                                │  (reply displayed) │
                                                └────────────────────┘
```

Every failure inside the request path is logged and still answers HTTP 200:
a failed bearer check (`auth_fail`), a malformed env (`env_invalid`), a
rejected IMEI (`imei_not_allowed`) and an adapter error alike. Garmin's retry
schedule cannot repair any of them, and a fault left unanswered for five days
suspends the tenant.

## Modules

| Path                                          | Role                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                | Worker entry; `export default { fetch }`; delegates to the Hono app                                     |
| `src/app.ts`                                  | Hono factory; routes, token check, env gate, IMEI allowlist, idempotency, message-code dispatch         |
| `src/env.ts`                                  | Typed `Env` binding + zod `EnvSchema`; `checkEnv()` (#212) and helpers (`imeiAllowSet`, …)              |
| `src/core/types.ts`                           | `ParsedCommand`, `GarminEvent`, `GarminEnvelope`, `CommandResult`                                       |
| `src/core/grammar.ts`                         | `parseCommand()` — `!command` parser for all 15 commands                                                |
| `src/core/idempotency.ts`                     | Composite-key derivation; `idem:<key>` record; `withCheckpoint` per-op replay guard                     |
| `src/core/orchestrator.ts`                    | Dispatch by command; `!ping`, `!help` and `!cost` are answered inline                                   |
| `src/core/commands/`                          | One handler per command: `post`, `postimg`, `mail`, `todo`, `where`, `weather`, `drop`, …               |
| `src/core/narrative.ts`                       | LLM narrative for `!post`, `!postimg` and track posts — JSON mode via OpenRouter                        |
| `src/core/imageprompt.ts`                     | Image-generation prompt for `!postimg`                                                                  |
| `src/core/image-pending.ts`                   | In-flight Replicate prediction marker: resume a paid prediction, lease against concurrent redelivery    |
| `src/core/localtime.ts`                       | Civil local time of day from the Open-Meteo offset and sunrise/sunset (#274)                            |
| `src/core/plaintext.ts`                       | Plain-text prompt sentence and bold-marker strip for `!ai`, `!camp` and `!brief` replies (#271)         |
| `src/core/context.ts`                         | Per-IMEI rolling window (last 5 events) in `TS_CONTEXT`                                                 |
| `src/core/fieldlog.ts`                        | Per-IMEI journal entries for `!drop` / `!brief`, in `TS_CONTEXT`                                        |
| `src/core/addressbook.ts`                     | `ADDRESS_BOOK_JSON` alias resolution for `!share` / `!blast`                                            |
| `src/core/ledger.ts`                          | Monthly and daily rollups in `TS_LEDGER` from real OpenRouter `usage`; separate image bucket            |
| `src/core/budget.ts`                          | `DAILY_TOKEN_BUDGET` gate, checked before the LLM call in `!post`, `!postimg`, `!ai`, `!camp`, `!brief` |
| `src/core/reply.ts`                           | `buildReply()` — ≤320-char, two-SMS formatter; keeps every link whole                                   |
| `src/core/tracking.ts`                        | Mode B: Start Track / Stop Track session state in `TS_TRACKS`; `handleStopTrack`                        |
| `src/core/track-metrics.ts`                   | Distance, elevation, pace and stationary/at-rest classification from MapShare KML points                |
| `src/core/units.ts`                           | Metric → imperial display helpers (#195)                                                                |
| `src/adapters/outbound/garmin-ipc-inbound.ts` | `sendReply()` — `POST /api/Messaging/Message`                                                           |
| `src/adapters/ai/openrouter.ts`               | `chatCompletion()` — OpenRouter chat API; real `usage`; one retry on `content_filter` (#270)            |
| `src/adapters/ai/replicate.ts`                | `generateImage()` — Replicate predictions API (`!postimg`)                                              |
| `src/adapters/mail/resend.ts`                 | `sendEmail()` — Resend transactional API                                                                |
| `src/adapters/tasks/todoist.ts`               | `addTask()` — Todoist REST                                                                              |
| `src/adapters/publish/github-pages.ts`        | `publishPost()`, `publishPostWithImage()`, `publishTrackPost()` — GitHub Contents API commits           |
| `src/adapters/location/geocode.ts`            | `reverseGeocode()` — Nominatim, cached 24 h in `TS_CACHE`                                               |
| `src/adapters/location/weather.ts`            | `currentWeather()` / `currentWeatherDetail()` — Open-Meteo, cached 1 h in `TS_CACHE`                    |
| `src/adapters/location/mapshare.ts`           | `fetchMapShareKml()` / `parsePings()` — Garmin MapShare KML feed (Mode B)                               |
| `src/adapters/storage/kv.ts`                  | Typed KV helpers (`getJSON`, `putJSON`, `exists`)                                                       |
| `src/adapters/logging/worker-logs.ts`         | Structured JSON logger                                                                                  |

Google Maps links are built inline in the `where`, `share` and `blast`
handlers; MapShare page URLs come from `MAPSHARE_BASE` + `MAPSHARE_KEY`.

## KV namespaces

| Binding          | Holds                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `TS_IDEMPOTENCY` | `idem:<key>` message record with per-op checkpoints (48 h); `imgpend:<key>` image marker |
| `TS_LEDGER`      | `ledger:<YYYY-MM>` and `ledger:<YYYY-MM-DD>` usage rollups                               |
| `TS_CONTEXT`     | `ctx:<imei>` rolling window (30 d); `fieldlog:<imei>` journal entries                    |
| `TS_CACHE`       | `geo:<lat>:<lon>` place names (24 h); Open-Meteo weather (1 h)                           |
| `TS_TRACKS`      | Mode B session state: `track_start:`, `track_interval:`, `track_events:`, `track:` keys  |

## Tracking sessions (Mode B)

A tracking session needs no `!command`. The device emits `messageCode: 10`
(Start Track) and `messageCode: 12` (Stop Track) on its own. On mc=10 the
Worker records the start time in `TS_TRACKS`. On mc=12, `handleStopTrack`
pulls the session's breadcrumbs from the MapShare KML feed, rolls them up with
`track-metrics`, has the LLM write a narrative, commits a journal post and
replies with its link. The track narrative does not pass the daily token
budget gate. Other tracking codes (mc=0, mc=11) are not dispatched; a nonzero
`status.intervalChange` is latched for refusal hints. Design:
[`superpowers/specs/archived/2026-09/2026-05-01-tracking-session-artifacts-design.md`](superpowers/specs/archived/2026-09/2026-05-01-tracking-session-artifacts-design.md).

## Data contracts

- **Inbound (Garmin → us):** `{ Version, Events: [GarminEvent, …] }` — schema V2 with tolerance for V3/V4 extras. See [`materials/Garmin IPC Outbound.pdf`](../materials/Garmin%20IPC%20Outbound.pdf).
- **Outbound (us → Garmin):** `POST /api/Messaging/Message` with `{ Messages: [{ Recipients: [imei], Sender, Timestamp: "/Date(ms)/", Message }] }`. 160-char hard cap; we paginate for two-SMS replies. See [`materials/Garmin IPC Inbound.pdf`](../materials/Garmin%20IPC%20Inbound.pdf).
- **Auth:** incoming = the raw `GARMIN_INBOUND_TOKEN` in the `X-Outbound-Auth-Token` header (Garmin does not use `Authorization: Bearer`; PRD §8 D1); outgoing = `X-API-Key: <GARMIN_IPC_INBOUND_API_KEY>`.

## Idempotency

Key = `sha256(imei : timeStamp : messageCode : sha256(freeText||payload||""))`.
Stored under `idem:<key>` in `TS_IDEMPOTENCY` with TTL 48h. A replay of a
completed message short-circuits before any side-effecting work. A replay of a
partly finished message re-runs, and `withCheckpoint` skips each sub-op that
already finished (publish, email, image, reply). Moving this to a Durable
Object for strong consistency is Phase 3 (#153). Full detail in
[`PRD.md`](PRD.md) §5.

## Reply budget

Hard contract: total reply ≤ 320 characters across ≤ 2 Garmin Inbound messages
(160 each). `APPEND_COST_SUFFIX=true` appends `· $X.XX` which counts against
the budget. Longer content (full narratives, detailed help) goes to the blog
or email — never to the device.

## Historical deployment targets

Pipedream and n8n-on-Proxmox were explored in earlier iterations; the code
paths were broken (unpublished package imports, in-memory state on serverless)
and those docs are archived at [`archive/`](archive/). Do not use them.
