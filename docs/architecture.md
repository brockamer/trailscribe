# Architecture

TrailScribe is a single Cloudflare Worker that receives Garmin IPC Outbound
webhooks, dispatches `!command` actions to per-integration adapters, and
replies via Garmin IPC Inbound. All state lives in Cloudflare KV for α-MVP;
Durable Objects and D1 come in later phases. See [`PRD.md`](PRD.md) §3 for
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
                   │    1. verify Authorization: Bearer <token>         │
                   │    2. parse Garmin V2 envelope                     │
                   │    3. per event:                                   │
                   │        a. IMEI allowlist check                     │
                   │        b. idempotency key (sha256 composite)       │
                   │        c. KV.get idem:<key> → skip if hit          │
                   │        d. KV.put idem:<key>, TTL 48h               │
                   │        e. dispatch to orchestrator (Phase 1)       │
                   │    4. ALWAYS return 200 OK to avoid retry cascade  │
                   └──┬──────────────────────────────────────────────┬──┘
                      │                                              │
              ┌───────┴───────┐                        ┌─────────────┴─────────────┐
              │  KV           │                        │  Tool adapters            │
              │  TS_IDEMPOTENCY TS_LEDGER              │  openai · resend · todoist│
              │  TS_CONTEXT   TS_CACHE                 │  github-pages · nominatim │
              └───────────────┘                        │  open-meteo               │
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

## Modules

| Path | Role |
|---|---|
| `src/index.ts` | Worker entry; `export default { fetch }`; delegates to Hono app |
| `src/app.ts` | Hono factory; routes, bearer verification, envelope parse, idempotency |
| `src/env.ts` | Typed `Env` binding + zod `EnvSchema` + helpers (`imeiAllowSet`, `dailyTokenBudget`, …) |
| `src/core/types.ts` | `ParsedCommand`, `GarminEvent`, `GarminEnvelope`, `CommandResult` |
| `src/core/grammar.ts` | `parseCommand()` — α-MVP verb parser |
| `src/core/idempotency.ts` | Composite-key derivation, SHA-256 helper, `IdempotencyRecord` |
| `src/core/orchestrator.ts` | Dispatch by command type (Phase 1 wires real adapters) |
| `src/core/narrative.ts` | Prompt + JSON-mode OpenAI call (Phase 1) |
| `src/core/context.ts` | Per-IMEI rolling window in `TS_CONTEXT` (Phase 1) |
| `src/core/ledger.ts` | Monthly rollup in `TS_LEDGER` using real OpenAI usage (Phase 1) |
| `src/core/commands.ts` | Thin per-command handler registry (Phase 1) |
| `src/core/links.ts` | Google Maps + MapShare link builders |
| `src/core/tracking.ts` | `handleStopTrack` orchestrator (mc 12) + `storeTrackRecord` KV writer + `TrackSessionRecord` |
| `src/core/track-metrics.ts` | Pure functions: `haversineKm`, `totalDistanceKm`, `elevationProfile` (5pt median smoothing), `paceStats`, `routeShape`, `activityHint`, `computeMetrics` aggregator |
| `src/adapters/location/mapshare.ts` | `fetchMapShareKml` + `parsePings` — KML breadcrumb feed for closed tracking sessions (Mode B) |
| `src/adapters/inbound/…` | (reserved — single Hono route today; keep for multi-gateway future) |
| `src/adapters/outbound/garmin-ipc-inbound.ts` | `sendReply(imei, msg, env)` — POST /Messaging/Message (Phase 1) |
| `src/adapters/mail/resend.ts` | `sendEmail()` — Resend transactional API (Phase 1) |
| `src/adapters/tasks/todoist.ts` | `addTask()` — Todoist REST (Phase 1) |
| `src/adapters/publish/github-pages.ts` | `publishPost()` — GitHub Contents API commits (Phase 1) |
| `src/adapters/location/geocode.ts` | `reverseGeocode()` — Nominatim, cached in `TS_CACHE` (Phase 1) |
| `src/adapters/location/weather.ts` | `currentWeather()` — Open-Meteo, cached (Phase 1) |
| `src/adapters/ai/openai.ts` | `generateNarrative()` — JSON-mode + real `usage` (Phase 1) |
| `src/adapters/storage/kv.ts` | Typed KV helpers (`getJSON`, `putJSON`, `exists`) |
| `src/adapters/logging/worker-logs.ts` | Structured JSON logger |

## Data contracts

- **Inbound (Garmin → us):** `{ Version, Events: [GarminEvent, …] }` — schema V2 with tolerance for V3/V4 extras. See [`materials/Garmin IPC Outbound.txt`](../materials/Garmin%20IPC%20Outbound.txt).
- **Outbound (us → Garmin):** `POST /api/Messaging/Message` with `{ Messages: [{ Recipients: [imei], Sender, Timestamp: "/Date(ms)/", Message }] }`. 160-char hard cap; we paginate for two-SMS replies. See [`materials/Garmin IPC Inbound.txt`](../materials/Garmin%20IPC%20Inbound.txt).
- **Auth:** incoming = static bearer token in `Authorization: Bearer <GARMIN_INBOUND_TOKEN>`; outgoing = `X-API-Key: <GARMIN_IPC_INBOUND_API_KEY>`.

## Idempotency (α)

Key = `sha256(imei : timeStamp : messageCode : sha256(freeText||payload||""))`.
Stored under `idem:<key>` in `TS_IDEMPOTENCY` with TTL 48h. Replays short-circuit
before any side-effecting work. Op-level checkpoints (for partial-failure
recovery) are Phase 1. Durable Objects (strong consistency) is Phase 2. Full
detail in [`PRD.md`](PRD.md) §5.

## Reply budget

Hard contract: total reply ≤ 320 characters across ≤ 2 Garmin Inbound messages
(160 each). `APPEND_COST_SUFFIX=true` appends `· $X.XX` which counts against
the budget. Longer content (full narratives, detailed help) goes to the blog
or email — never to the device.

## Historical deployment targets

Pipedream and n8n-on-Proxmox were explored in earlier iterations; the code
paths were broken (unpublished package imports, in-memory state on serverless)
and those docs are archived at [`archive/`](archive/). Do not use them.
