# Async `!postimg` by Replicate webhook — Design Spec

**Status:** Approved in conversation 2026-10-13, pending review of this file.
**Author:** Claude (Opus 5.5) with Brock Amer
**Date:** 2026-10-13
**Issue:** #268 (milestone _Groundwork_). Later consumers: #246 (`!postvid`), #285 (media design).

## 1. Problem

`!postimg` holds Garmin's webhook request open for the whole image render. The 2026-10-01 production run took 59.3 s: about 9.3 s for place, weather and narrative, 42.9 s of Replicate `predict_time`, and about 6 s for the poll wait, the journal commit and the reply. Garmin re-delivers an event it has not had an answer to after about 71 s, so the margin is about 12 s, and Replicate queueing alone has been measured at over 60 s (#235). The 180 s lease in `src/core/image-pending.ts` stops a re-delivery from producing a second post, but the first request can still be cut off.

## 2. Goal

The Worker answers Garmin within 15 s. The image finishes when Replicate calls back. The operator receives the same single SMS as today, and the journal gets the same single commit with post and image together. This is the first path in the Worker that finishes work after Garmin has its answer; `!postvid` and the media work use it later.

The design must be dependable for a remote operator who cannot inspect anything from the field, and it must not add mechanisms beyond what that requires.

## 3. Decisions

| #   | Decision                                                                                                                                                                                                                                                                             | Source                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| 1   | Replicate webhook to a new Worker route. No Durable Object, no Queues, no cron.                                                                                                                                                                                                      | #268, 2026-10-03          |
| 2   | Split the pipeline: `startPostImg` in the Garmin request, `finishPostImg` in the callback, joined by an explicit job record. Not "replay the command on callback", which would re-fetch weather and need a budget-skip rule.                                                         | Operator, 2026-10-13      |
| 3   | No new secret. The Worker fetches the signing secret with the existing `IMAGE_API_KEY` from `GET /v1/webhooks/default/secret` and caches it in `TS_CACHE`. This replaces the "one new secret" recorded on #268. Staging and production each get their own account's secret this way. | Operator, 2026-10-13      |
| 4   | A callback that never succeeds is logged, not swept. The operator sends `!postimg` again. A sweep can be added later if Workers Logs ever show a lost callback.                                                                                                                      | Operator, 2026-10-13      |
| 5   | The callback URL carries only the idempotency key, not the IMEI. Replicate stores the URL; the IMEI stays in our KV.                                                                                                                                                                 | Spec, approved 2026-10-13 |
| 6   | Post and image are committed together at completion, in one commit, as today. This keeps the #250 feed and preview behaviour.                                                                                                                                                        | #268 recommendation       |
| 7   | The polling loop is removed from the `!postimg` path. There is one completion path, not two.                                                                                                                                                                                         | Spec, approved 2026-10-13 |

## 4. Facts this design depends on

Verified 2026-10-13 from Replicate's documentation (`/docs/topics/webhooks`, `/setup-webhook`, `/receive-webhook`, `/verify-webhook`):

- The prediction create body takes `webhook` (URL) and `webhook_events_filter`. `["completed"]` sends one request when the prediction reaches `succeeded`, `failed` or `canceled`. Replicate recommends query parameters in the webhook URL for the caller's own IDs.
- The callback is an HTTP POST whose body is the prediction object, the same shape as `GET /v1/predictions/{id}`.
- Only the terminal webhook is retried: after a network failure or any 4xx or 5xx response, on exponential backoff. "The final retry is sent about 1 minute after the prediction completed." The endpoint "should respond with a 2xx status code within a few seconds; otherwise, the webhook might be retried."
- "Identical webhooks can be sent more than once", and "in rare cases, webhooks for a single prediction may arrive out of order."
- Signature: headers `webhook-id`, `webhook-timestamp` (seconds) and `webhook-signature` (space-separated `v1,<base64>` entries). HMAC-SHA256 over `` `${id}.${timestamp}.${body}` `` with the raw body. The secret has the form `whsec_<base64>`.
- Output files of API predictions are deleted after one hour.

Verified 2026-10-13 against the Standard Webhooks reference library (`standard-webhooks/libraries/javascript`): the key is the **Base64-decoded** part after `whsec_`, and the default timestamp tolerance is 5 minutes. The library's test vector (secret `whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw`, id `msg_p5jXN8AQM9LWM0D4loKWxJek`, timestamp `1614265330`, payload `{"test": 2432232314}`) gives `v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=` with the decoded key and a different value with the raw string; reproduced locally with Node `crypto`.

**Not yet confirmed — the staging check (§11.2) settles both:**

- Replicate's page says to use "the base64 portion of the signing secret" as the key without saying whether to decode it. This design assumes Standard Webhooks behaviour (decode).
- Replicate preserves the query string of the webhook URL. Its documentation recommends query parameters but does not state this outright.

## 5. Data flow

### 5.1 Request 1 — Garmin → Worker (target under 15 s)

1. `handleEvent` → `orchestrate` → `startPostImg`.
2. The existing refusals reply immediately: no GPS fix and no caption, or the daily token budget exhausted.
3. Place and weather (as today), narrative (checkpoint `narrative`), text ledger (checkpoint `ledger_text`). The text ledger moves before the image step; the #213 reasoning (record real spend before anything that can fail) still applies.
4. If the narrative gave no subject and there is no caption, publish text-only and reply now, as today.
5. Create the prediction with `webhook: <origin>/replicate/callback?key=<idemKey>` and `webhook_events_filter: ["completed"]`. Do **not** send `Prefer: wait=60`: with it, Replicate holds our request open for up to 60 s.
6. Write the job record `job:<idemKey>` (§6), including `predictionId`. This is the only write in request 1.
7. Return `{ deferred: true }`. `handleEvent` logs `orchestrate_deferred` and returns without a reply and without `markCompleted`. Garmin gets HTTP 200.

If step 5 fails, publish text-only and return the fallback reply now (§10). If step 6 fails, the prediction is already paid for but its callback could not find the job, so do the same: publish text-only, reply now, and complete the record; the callback then stops at the "already completed" row of §8. The operator never gets silence from request 1. `origin` is the Worker's public origin, taken from the incoming Garmin request URL (`new URL(c.req.url).origin`), so no variable holds it.

**Why one write, after the create.** Cloudflare KV allows one write per second to the same key ([KV limits](https://developers.cloudflare.com/kv/platform/limits/): "Writes to same key | 1 per second"). A create call without `Prefer: wait` returns in under a second, so a write before it and a write after it would routinely collide. A record without a `predictionId` would also be useless: the callback cannot match it and the lease (§9) cannot act on it.

### 5.2 Request 2 — Replicate → Worker (`POST /replicate/callback?key=<idemKey>`)

1. Run the env gate (#212). Invalid → log `env_invalid`, answer 503.
2. Read the raw body once as text, then verify the signature (§7). Fail → 401.
3. Apply the checks in §8 to decide between 200-no-action, 503 and proceed.
4. Write `finishStartedAt` into the job record. Best-effort: if the write fails (for example a same-key rate limit on a prediction that failed within a second), log it and continue; the checkpoints still stop a sequential duplicate.
5. Answer 200 and run `finishPostImg(job, prediction)` inside `ctx.waitUntil`.

`finishPostImg`:

- `succeeded`: download the output image → image ledger (checkpoint `ledger_image`) → one commit with post and image (checkpoint `publish`) → context append → reply through `deliverCommandResult` (checkpoint `reply`) → `markCompleted` → delete the job record.
- `failed`, `canceled`, `aborted`, or an image download failure: text-only commit (checkpoint `publish`) and the fallback reply, then the same tail.
- A publish failure: `markFailed` and the error reply, as `failPipeline` does today, then delete the job record. Every finish ends with the record terminal (`completed` or `failed`) and the job record deleted.
- Log `postimg_finish_ms` (wall time of the finish) on every path.

The image bytes are no longer stored in a checkpoint (the current `image` op stores them as Base64 in the idempotency record). Once `publish` is checkpointed, a replay does not need them.

## 6. Job record

Key `job:<idemKey>` in `TS_IDEMPOTENCY`, TTL 48 h (`IDEMPOTENCY_TTL_SECONDS`, so a job never outlives the record it belongs to). Replaces `imgpend:<idemKey>`.

```ts
interface PostImgJob {
  kind: "postimg";
  imei: string;
  createdAt: number; // ms epoch
  predictionId: string; // the record is written only after the create succeeds
  finishStartedAt?: number; // ms epoch, set by the callback before waitUntil
  caption?: string;
  narrative: { title: string; haiku: string; body: string };
  lat?: number;
  lon?: number;
  placeName?: string;
  weather?: string;
}
type Job = PostImgJob; // a union; #246 adds a kind
```

The record holds everything `finishPostImg` needs, so the callback never re-runs enrichment or the narrative, and the published post always matches the narrative. It is also the media seam "the pending marker carries the IMEI and enough context for a later media send".

The key is written at most three times — at create, at `finishStartedAt`, and the delete after the finish — and each pair is separated by the render or by the finish, so the one-write-per-second limit holds in normal operation. The one exception is a prediction that fails within a second of creation; §5.2 step 4 makes that write best-effort for this reason.

## 7. Signature verification

`src/adapters/ai/replicate-webhook.ts`:

1. `webhook-id`, `webhook-timestamp` and `webhook-signature` must all be present.
2. `webhook-timestamp` must be within 300 s of the Worker clock, in either direction.
3. Key = Base64-decode of the secret after `whsec_`. Compute HMAC-SHA256 (WebCrypto) over `` `${id}.${timestamp}.${rawBody}` `` and compare it, in constant time, with each `v1,` entry of `webhook-signature`. One match passes.
4. The secret is cached in `TS_CACHE` under `replicate:webhook-secret` as `{ key, fetchedAt }`, with no TTL. On a miss, fetch it with `IMAGE_API_KEY`. If no entry matches and the cached secret is older than 10 minutes, fetch once more and check again; this covers a rotation by Replicate and limits forged requests to one secret fetch per 10 minutes. If the secret cannot be fetched, answer 503.
5. The secret and the signature header are never logged. A pass logs `replicate_signature_ok`; a fail logs `replicate_signature_failed` with the reason (missing header, stale timestamp, mismatch).

## 8. Callback decisions

Evaluated in order after the signature passes. A 503 makes Replicate retry (for about a minute); a 200 stops it.

| Condition                                                         | Answer | Action and log                                                                |
| ----------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| `key` query parameter missing                                     | 200    | `replicate_callback_ignored` (`no_key`)                                       |
| Body `status` not terminal                                        | 200    | `replicate_callback_ignored` (`not_terminal`); the filter should prevent this |
| Idempotency record `completed` or `failed` (a finish already ran) | 200    | `replicate_callback_duplicate`                                                |
| No job record                                                     | 503    | `replicate_callback_job_missing` (KV may not show the record here yet)        |
| Record `predictionId` differs from body `id`                      | 200    | `replicate_callback_ignored` (`prediction_mismatch`)                          |
| `finishStartedAt` set and less than 2 minutes old                 | 200    | `replicate_callback_duplicate` (concurrent delivery)                          |
| Otherwise                                                         | 200    | Write `finishStartedAt`, run `finishPostImg` in `waitUntil`                   |

Every callback logs `replicate_callback` with `key`, `predictionId`, `status`, `predict_time` and the first 2 KB of the raw body (the `ipc_received.rawBodySample` pattern; the body holds the image prompt, which is published anyway, and a short-lived output URL).

## 9. Garmin re-delivery lease

`handleEvent` skips an event (`concurrent_replay_skipped`, as today) when a job record exists for its key, at any age. Every job record carries a `predictionId` (§6), so a record means "an image is paid for": a re-delivery must never buy a second one. If the job is stuck because its callback was lost, decision 4 applies.

No record means nothing is waiting, and a re-delivery runs `startPostImg` again with the narrative from its checkpoint. If request 1 died after §5.1 step 5 but before step 6, the re-delivery creates a second prediction (about $0.10); the first one's callback then finds no record for its id and is ignored as `prediction_mismatch` once the second record is visible. That cost is accepted to keep one simple rule.

This replaces `IMAGE_LEASE_MS` (180 s) and the time-window check in `imageGenerationInFlight`. The reasoning moves from `src/core/image-pending.ts` to `src/core/jobs.ts`.

## 10. What the operator sees

| Case                                         | Journal         | SMS                                                   |
| -------------------------------------------- | --------------- | ----------------------------------------------------- |
| Success                                      | Post with image | `Posted: <title>` and the URL (unchanged)             |
| Render `failed` or `canceled`                | Text-only post  | `Posted: <title> (no image — retry !postimg)` and URL |
| Image download fails                         | Text-only post  | Same                                                  |
| Prediction create fails (request 1)          | Text-only post  | Same, sent from request 1                             |
| Publish fails (request 2)                    | None            | `Error: <message>` (as today)                         |
| No fix and no caption, or budget exhausted   | None            | The refusal (as today)                                |
| Callback lost (every Replicate retry failed) | None            | None; logged; the operator resends                    |

The SMS leaves the Worker about 45–60 s after the command and reaches the device at its next mailbox check (unchanged; see #284).

## 11. Components

| File                                                  | Change                                                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/ai/replicate.ts`                        | `createPrediction({ prompt, resolution, webhookUrl, env })` → `{ id }`; `fetchOutput(prediction)` → `{ bytes, mimeType }`. `generateImage` and its polling loop are removed.                         |
| `src/adapters/ai/replicate-webhook.ts` (new)          | `verifyReplicateWebhook(headers, rawBody, env, now?)` and the secret cache (§7).                                                                                                                     |
| `src/core/jobs.ts` (new; replaces `image-pending.ts`) | `Job` type, `readJob`, `writeJob`, `deleteJob`, `jobBlocksRedelivery` (§6, §9).                                                                                                                      |
| `src/core/commands/postimg.ts`                        | `startPostImg` (§5.1) and `finishPostImg` (§5.2). `handlePostImg` becomes `startPostImg`.                                                                                                            |
| `src/replicate-callback.ts` (new)                     | The route handler (§5.2, §8). Mounted by `app.ts` as `POST /replicate/callback`.                                                                                                                     |
| `src/app.ts`                                          | The reply tail of `handleEvent` (build reply, cost suffix, `reply` checkpoint, `markCompleted`) becomes `deliverCommandResult()`, used by both requests. The lease check uses `jobBlocksRedelivery`. |
| `src/core/orchestrator.ts`, `src/core/types.ts`       | `OrchestratorContext` gains `origin`; `orchestrate` can return `{ deferred: true }`.                                                                                                                 |
| `src/adapters/outbound/garmin-ipc-inbound.ts`         | `deliver(imei, { pages, media? }, env)`: pages go to `sendReply`; `media` throws "not implemented (#285)". `deliverCommandResult` calls `deliver`.                                                   |

### 11.1 Media seams (#268 acceptance criteria)

| Seam                                                         | State                                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Delivery function for text pages plus optional media         | New: `deliver()`; media branch unimplemented by design                       |
| Pending record carries the IMEI and context for a media send | New: the job record (§6)                                                     |
| `GarminEvent` media fields                                   | Done in #282 (`src/core/types.ts`)                                           |
| Idempotency hash uses `mediaId`, never `mediaBytes`          | Done in #282 (`src/core/idempotency.ts`)                                     |
| No webhook route assumes a small request body                | Both routes read the body once as text; a test covers a large Garmin V4 body |

## 12. Testing

### 12.1 Unit and route tests (Vitest + Miniflare, no network)

- **Signature:** the Standard Webhooks vector passes; a changed body, a wrong secret, a timestamp outside 300 s and a missing header fail; a header with several entries passes when one is right; a mismatch with a secret older than 10 minutes re-fetches once; a younger one does not.
- **Recorded request:** one real staging callback, its headers and body saved under `tests/fixtures/replicate/`, re-signed with a test secret. It proves the code parses Replicate's real format; the vector proves the algorithm. The account secret is never committed.
- **Route:** every row of §8; the `waitUntil` promise is awaited through a fake execution context.
- **Pipeline:** create carries `webhook` and the filter and no `Prefer` header; the job record is written once, only after a successful create, and a create failure or a job-write failure each gives the text-only fallback with a reply; each row of §10; the success SMS text is byte-identical to today's.
- **`app.ts`:** a deferred result sends no reply and does not complete the record; a re-delivery with a `predictionId` record is skipped, without one it runs again.
- **Seams:** `deliver()` routes pages to `sendReply` and throws for media.

### 12.2 Staging check (no device; staging deploys are pre-approved)

1. Deploy to staging and send one `!postimg` Garmin event with the replay script. Staging publishes to the public journal and sends a real SMS to the inReach (`IPC_INBOUND_DRY_RUN = "false"`), so the caption must be acceptable to publish.
2. From Workers Logs: time to answer Garmin, `replicate_signature_ok`, one publish, one reply, `postimg_finish_ms`.
3. Check the logged real request locally against the real secret (dev token from `~/.secrets`), with the decoded and the raw key, to settle §4. Save it as the fixture (re-signed).
4. Send the captured body again, signed with the real secret and a current timestamp (the original falls outside the 300 s window), and confirm `replicate_callback_duplicate` and no second post.
5. Delete the test post and its image from the journal repository (operator decision, 2026-10-13).

### 12.3 Production and device (after merge; closes #268)

Three real `!postimg` runs from the inReach: Garmin answered within 15 s (Workers Logs), SMS wall time recorded against the 59.3 s baseline. These need the device and can share a session with the #284 probes.

## 13. Documents

- **PRD:** new route `POST /replicate/callback` (authenticated by Replicate's signature); the two-request model for `!postimg`; the KV table row `job:<key>` replacing `imgpend:<key>`; `replicate:webhook-secret` in `TS_CACHE`; new §8 decision D12 (job completion by provider webhook). Operator sign-off before the code PR merges.
- **`AGENTS.md`:** architecture tree (`jobs.ts`, `replicate-webhook.ts`, `replicate-callback.ts`; `image-pending.ts` removed).
- **`docs/architecture.md`:** the route and the two-request sequence.
- **#268 body:** decisions 2–5 and 7, and three amended acceptance criteria — the recorded fixture is re-signed with a test secret; the lease reasoning lives in `src/core/jobs.ts`; the PRD gains no new secret.

## 14. Limits and risks

- **`waitUntil` gives the finish 30 s after the response.** [Workers context API](https://developers.cloudflare.com/workers/runtime-apis/context/): HTTP-triggered work "can extend execution for up to 30 seconds after the response is sent", and promises not settled by then "are canceled", with a warning in Workers Logs. A normal finish is about 6 s. The worst case is the IPC Inbound retry ladder (1 s, 4 s, 16 s) on a slow Garmin, which approaches the limit; the publish happens before the SMS, so the post survives and only the SMS can be lost, the same outcome as an IPC failure today. `postimg_finish_ms` and the cancellation warning measure it.
- **KV visibility has about one minute of Replicate retries to cover.** [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/): a write is "usually immediately visible" in the location that made it, and "may take up to 60 seconds or more" elsewhere. The cover is the render itself: a typical callback arrives about 40 s after the job record is written. The stress case is a prediction that fails within seconds, where only Replicate's retries (the last about one minute after completion) and the likelihood that both requests reach the same Cloudflare location cover it.
- **A lost callback leaves a job unfinished** (decision 4). It shows in Workers Logs as `replicate_callback_job_missing` or `replicate_signature_failed` lines without a later `postimg_finish_ms`.

## 15. Out of scope

A lost-callback sweep; polling as a second completion path; a stuck-job timer; image or voice delivery to the device (#285); `!postvid` (#246); the Stop Track lease (#259).
