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
                   │        d. skip if a job:<key> record exists (#268) │
                   │        e. mc=3 Free Text  → grammar → orchestrator │
                   │           mc=10/12 Track  → tracking (Mode B)      │
                   │           other codes     → log and drop           │
                   │    5. ALWAYS return 200 OK to avoid retry cascade  │
                   │                                                    │
                   │  POST /replicate/callback (#268)                   │
                   │    signed by Replicate; finishes !postimg          │
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

Every failure inside the `/garmin/ipc` request path is logged and still answers HTTP 200:
a failed bearer check (`auth_fail`), a malformed env (`env_invalid`), a
rejected IMEI (`imei_not_allowed`) and an adapter error alike. Garmin's retry
schedule cannot repair any of them, and a fault left unanswered for five days
suspends the tenant. `/replicate/callback` is the exception: its status codes
control Replicate's retries (see "Async completion" below).

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
| `src/core/jobs.ts`                            | Provider-callback job record `job:<key>`; its existence is the lease against Garmin re-delivery (#268)  |
| `src/core/localtime.ts`                       | Civil local time of day from the Open-Meteo offset and sunrise/sunset (#274)                            |
| `src/core/plaintext.ts`                       | Plain-text prompt sentence and bold-marker strip for `!ai`, `!camp` and `!brief` replies (#271)         |
| `src/core/context.ts`                         | Per-IMEI rolling window (last 5 events) in `TS_CONTEXT`                                                 |
| `src/core/fieldlog.ts`                        | Per-IMEI journal entries for `!drop` / `!brief`, in `TS_CONTEXT`                                        |
| `src/core/addressbook.ts`                     | `ADDRESS_BOOK_JSON` alias resolution for `!share` / `!blast`                                            |
| `src/core/ledger.ts`                          | Monthly and daily rollups in `TS_LEDGER`; cost is OpenRouter's `usage.cost` (#162); image bucket        |
| `src/core/budget.ts`                          | `DAILY_TOKEN_BUDGET` gate, checked before the LLM call in `!post`, `!postimg`, `!ai`, `!camp`, `!brief` |
| `src/core/reply.ts`                           | `buildReply()` — ≤320-char, two-SMS formatter; keeps every link whole                                   |
| `src/core/delivery.ts`                        | Shared reply tail: `deliverCommandResult()` (`buildReply`, checkpointed send, `markCompleted`)          |
| `src/core/tracking.ts`                        | Mode B: Start Track / Stop Track session state in `TS_TRACKS`; `handleStopTrack`                        |
| `src/core/track-metrics.ts`                   | Distance, elevation, pace and stationary/at-rest classification from MapShare KML points                |
| `src/core/units.ts`                           | Metric → imperial display helpers (#195)                                                                |
| `src/replicate-callback.ts`                   | `POST /replicate/callback`: verify signature, match job, finish `!postimg` in `waitUntil` (#268)        |
| `src/adapters/outbound/garmin-ipc-inbound.ts` | `sendReply()` — `POST /api/Messaging/Message`                                                           |
| `src/adapters/outbound/deliver.ts`            | `deliver()` — text pages go to `sendReply()`; the media branch waits for #285                           |
| `src/adapters/ai/openrouter.ts`               | `chatCompletion()` — OpenRouter chat API; real `usage`; one retry on `content_filter` (#270)            |
| `src/adapters/ai/replicate.ts`                | `createPrediction()` (with completion webhook) and `fetchOutput()` — Replicate predictions API          |
| `src/adapters/ai/replicate-webhook.ts`        | `verifyReplicateWebhook()` — Standard-Webhooks signature check; signing secret cached in `TS_CACHE`     |
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

| Binding          | Holds                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `TS_IDEMPOTENCY` | `idem:<key>` message record with per-op checkpoints (48 h); `job:<key>` job record for provider-callback completion (48 h)   |
| `TS_LEDGER`      | `ledger:<YYYY-MM>` and `ledger:<YYYY-MM-DD>` usage rollups                                                                   |
| `TS_CONTEXT`     | `ctx:<imei>` rolling window (30 d); `fieldlog:<imei>` journal entries                                                        |
| `TS_CACHE`       | `geo:<lat>:<lon>` place names (24 h); Open-Meteo weather (1 h); `replicate:webhook-secret` Replicate signing secret (no TTL) |
| `TS_TRACKS`      | Mode B session state: `track_start:`, `track_interval:`, `track_events:`, `track:` keys                                      |

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

## Async completion (`!postimg`, #268)

An image render can outlast Garmin's re-delivery point (about 71 s), so
`!postimg` runs as two requests joined by a job record. The Worker answers
Garmin within seconds; Replicate's signed callback finishes the post and sends
the one SMS. Decision: [`PRD.md`](PRD.md) §8 D12. Design, limits and risks:
[`superpowers/specs/2026-10-13-async-postimg-replicate-webhook-design.md`](superpowers/specs/2026-10-13-async-postimg-replicate-webhook-design.md).

**Request 1 — Garmin → Worker** (`POST /garmin/ipc`, `startPostImg`; target under 15 s. Staging, 2026-10-14: 18.6 s, of which place, weather and the narrative LLM call took 16.8 s and the prediction create plus the job write 1.8 s):

1. `handleEvent` skips the event when `idem:<key>` is `completed`, or when a `job:<key>` record exists (`concurrent_replay_skipped`). Otherwise it calls `orchestrate` with the Worker's origin, taken from the request URL.
2. The refusals reply at once: no GPS fix and no caption, or the daily token budget is exhausted.
3. Place and weather, then the narrative (checkpoint `narrative`) and the text ledger (checkpoint `ledger_text`).
4. With no caption and no narrative subject, publish text-only and reply now.
5. Create the Replicate prediction with `webhook=<origin>/replicate/callback?key=<idempotency key>` and `webhook_events_filter: ["completed"]`. There is no `Prefer: wait` header, so Replicate does not hold the request open. If it fails, publish text-only and reply now.
6. Write `job:<key>` once, after the create succeeded: the narrative, caption, position, place, weather and the `predictionId`. If the write fails, publish text-only and reply now.
7. Return `{ deferred: true }`. `handleEvent` logs `orchestrate_deferred`, sends no reply and does not complete the record. Garmin gets HTTP 200.

**Request 2 — Replicate → Worker** (`POST /replicate/callback?key=<idempotency key>`):

1. The env gate (#212) runs first; an invalid env answers 503.
2. Read the raw body once as text and verify the signature. Failure answers 401.
3. Apply the answer table below.
4. Write `finishStartedAt` into the job record (best-effort), answer 200, and run the finish inside `ctx.waitUntil`.
5. `finishPostImg`: on `succeeded`, download the image, record the image ledger (checkpoint `ledger_image`), commit post and image together (checkpoint `publish`) and append the context. On any other terminal status, or a failed download, commit text-only (checkpoint `publish`). A publish failure marks the record `failed` and produces the `Error:` reply, which step 6 still sends.
6. `deliverCommandResult` builds the reply and sends it under the `reply` checkpoint, then marks the record `completed` once the send succeeded (the `Error:` reply included); a failed send marks it `failed`. The job record is deleted on every path. The finish logs `postimg_finish_ms`.

**Callback answers** (evaluated in order; a 503 makes Replicate retry for about a minute, a 200 stops it):

| Condition                                                   | Answer | Log                                                  |
| ----------------------------------------------------------- | ------ | ---------------------------------------------------- |
| Env invalid                                                 | 503    | `env_invalid`                                        |
| Header missing, timestamp outside 300 s, or signature wrong | 401    | `replicate_signature_failed` (reason)                |
| Signing secret cannot be fetched                            | 503    | `replicate_signature_failed` (`secret_unavailable`)  |
| `key` query parameter missing                               | 200    | `replicate_callback_ignored` (`no_key`, warn)        |
| Body is not JSON, or has no `id` or `status`                | 200    | `replicate_callback_ignored` (`bad_body`, warn)      |
| `status` not terminal                                       | 200    | `replicate_callback_ignored` (`not_terminal`)        |
| Idempotency record already `completed` or `failed`          | 200    | `replicate_callback_duplicate`                       |
| No job record (it may not be visible here yet)              | 503    | `replicate_callback_job_missing`                     |
| Job `predictionId` differs from the body `id`               | 200    | `replicate_callback_ignored` (`prediction_mismatch`) |
| `finishStartedAt` set and less than 2 minutes old           | 200    | `replicate_callback_duplicate` (`concurrent`)        |
| Otherwise                                                   | 200    | Finish runs in `waitUntil`                           |

**What the operator sees:**

| Case                                         | Journal         | SMS                                                   |
| -------------------------------------------- | --------------- | ----------------------------------------------------- |
| Success                                      | Post with image | `Posted: <title>` and the URL                         |
| Render `failed`, `canceled` or `aborted`     | Text-only post  | `Posted: <title> (no image — retry !postimg)` and URL |
| Image download fails                         | Text-only post  | Same                                                  |
| Prediction create or job write fails         | Text-only post  | Same, sent from request 1                             |
| Publish fails (request 2)                    | None            | `Error: <message>`                                    |
| No fix and no caption, or budget exhausted   | None            | The refusal                                           |
| Callback lost (every Replicate retry failed) | None            | None; logged; the operator resends                    |

The SMS is sent when the render finishes, then waits for the device's next
mailbox check (#284).

**The finish has 30 s.** `waitUntil` gives the finish 30 s after the response.
A normal finish takes about 6 s, but the 30 s must also count the retry
ladders inside it. The IPC Inbound send retries 5xx, 429 and network errors at
1 s, 4 s and 16 s. On the text-only path (a failed render or download) the
publish (`publishPost` → `putContents`) retries 5xx and network errors at the
same 1 s, 4 s and 16 s, and the reply comes after it. A degraded GitHub
followed by a slow Garmin together can exceed 30 s. Cloudflare then cancels the
finish and logs a "waitUntil() tasks did not complete within the allowed time"
warning. A cancelled finish runs no `finally`: no `deleteJob`, no
`postimg_finish_ms`, and the job record stays until its 48 h TTL. On that
degraded-GitHub path the post itself can be lost, not only the SMS. The image
path commits through GraphQL `createCommitOnBranch` with no retry loop, so
there the post is committed before the SMS and only the SMS is at risk.

**A lost callback is not swept.** The reliable marker in Workers Logs is a
`postimg_deferred` line with no later `postimg_finish_ms` for the same `key`
(both lines log `key`). These lines explain it:

- `replicate_signature_failed`: a key or secret problem (carries `reason`, no `key`; match by time).
- `replicate_callback_ignored` with `no_key`: the callback URL lost its query string.
- `replicate_callback_job_missing`: the job record was not visible.
- `replicate_secret_fetch_failed`: the signing secret could not be fetched (no `key`; match by time).
- The Cloudflare "waitUntil() tasks did not complete within the allowed time" warning: the finish was cut off.

When `postimg_finish_ms` is there but no SMS arrived, look for
`reply_send_failed` (the post was published) or `postimg_finish_error`. To
recover, check the journal first, then resend `!postimg`. A late callback plus
a resend gives two posts.

The stored Workers Logs can occasionally miss lines. On 2026-10-14 the stored
copy of one staging callback lacked its last log line and its request record,
although `wrangler tail` showed the Worker printed them. A missing
`postimg_finish_ms` is therefore a reason to check the journal, not proof
that the post failed; for a live check, use `wrangler tail`.

## Data contracts

- **Inbound (Garmin → us):** `{ Version, Events: [GarminEvent, …] }` — schema V2 with tolerance for V3/V4 extras. Since Outbound v2.0.9, `imei` can be a comma-separated list (a message sent via Internet from a multi-device account); `handleEvent` takes the first allowlisted IMEI as the sender and reply recipient, and logs `imei_multi`. A V4 media event logs `media_event` with its metadata, never the bytes or the transcription. See [`materials/Garmin IPC Outbound.pdf`](../materials/Garmin%20IPC%20Outbound.pdf) (v2.0.10).
- **Outbound (us → Garmin):** `POST /api/Messaging/Message` with `{ Messages: [{ Recipients: [imei], Sender, Timestamp: "/Date(ms)/", Message }] }`. We send at most 160 chars per message and paginate for two-SMS replies; the API maximum has been 1600 since Inbound v3.1.2, and #284 probes what the device shows. See [`materials/Garmin IPC Inbound.pdf`](../materials/Garmin%20IPC%20Inbound.pdf) (v3.1.4).
- **Auth:** incoming = the raw `GARMIN_INBOUND_TOKEN` in the `X-Outbound-Auth-Token` header (Garmin does not use `Authorization: Bearer`; PRD §8 D1); outgoing = `X-API-Key: <GARMIN_IPC_INBOUND_API_KEY>`.

## Idempotency

Key = `sha256(imei : timeStamp : messageCode : sha256(content))`, where
`content` is `"media:" + mediaId` on a V4 media event and
`freeText||payload||""` otherwise (#282). `imei` is the single sender — see
the allowlist note under Data contracts.
Stored under `idem:<key>` in `TS_IDEMPOTENCY` with TTL 48h. A replay of a
completed message short-circuits before any side-effecting work. A replay of a
partly finished message re-runs, and `withCheckpoint` skips each sub-op that
already finished (narrative, ledger writes, publish, email, reply). Moving this to a Durable
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
