# Async `!postimg` by Replicate webhook — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 1–8 suit subagents; **Task 9 runs in the main session with the operator present** (secrets, a real SMS, the operator's credentials).

**Goal:** `!postimg` answers Garmin's webhook within 15 s and finishes the journal post and the SMS from Replicate's signed completion callback.

**Architecture:** `startPostImg` runs in the Garmin request (budget, enrichment, narrative, text ledger, prediction create with a webhook URL, one KV job-record write) and returns `{ deferred: true }`. A new route, `POST /replicate/callback`, verifies Replicate's Standard-Webhooks signature, matches the body to the job record, answers 200 at once and runs `finishPostImg` plus the shared reply code inside `ctx.waitUntil`. The polling loop and the 180 s time lease are removed; a job record's existence is the lease.

**Tech Stack:** Cloudflare Workers (TypeScript strict, ESM), Hono 4.12, Cloudflare KV, WebCrypto HMAC, Vitest 2 (node environment, in-memory KV mock in `tests/helpers/env.ts`).

**Spec:** `docs/superpowers/specs/2026-10-13-async-postimg-replicate-webhook-design.md` (read it first; section numbers below refer to it). Issue #268.

## Global Constraints

- Garmin's route `POST /garmin/ipc` always answers HTTP 200 (unchanged).
- Callback answers: 401 bad or missing signature; 503 retryable (secret unavailable, job record not visible, env invalid); 200 for everything else.
- SMS text is byte-identical to today: success `Posted: <title>` + journal URL; fallback `Posted: <title> (no image — retry !postimg)` + journal URL; publish failure `Error: <first 80 chars>`.
- Reply budget unchanged (≤320 chars, `buildReply` does the paging).
- No new env vars, secrets, services or npm dependencies. `package.json` does not change.
- Never log the signing secret, the `webhook-signature` header, or `IMAGE_API_KEY`.
- KV keys: `job:<idemKey>` in `TS_IDEMPOTENCY` with `expirationTtl: IDEMPOTENCY_TTL_SECONDS` (48 h); `replicate:webhook-secret` in `TS_CACHE`, no TTL, value `{ "key": "whsec_…", "fetchedAt": <ms> }`.
- KV allows one write per second per key: `job:<idemKey>` is written once in request 1, once at `finishStartedAt` (best-effort), and deleted at the end of the finish.
- Constants: timestamp tolerance 300 s; secret re-fetch only when the cached copy is older than 10 min; finish lease 2 min.
- Prediction create: `webhook: ${origin}/replicate/callback?key=${encodeURIComponent(idemKey)}`, `webhook_events_filter: ["completed"]`, no `Prefer` header, `input.resolution: "2 MP"`.
- Strict TS, JSDoc on every exported function, ESM imports with the `.js` suffix, short focused functions (AGENTS.md conventions).
- Every commit leaves `pnpm test`, `pnpm typecheck` and `pnpm lint` green; run `pnpm format` on staged files before each commit (CI runs `pnpm format:check`).
- Commit messages end with the two trailer lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01WetzfUf8yx6fQDiKwRzZpq`.
- Tests mock `fetch` by assigning `globalThis.fetch` (restore in `afterEach`) and mock `../src/adapters/outbound/garmin-ipc-inbound.js` with `{ sendReply: vi.fn() }` — 16 test files already do this, so new code must reach `sendReply` through a separate module, never by adding exports that those mocks would drop.

## Review Focus

1. A validly signed callback whose `?key=` belongs to a different job (a captured body replayed against another key) must do nothing: `prediction_mismatch`, 200, no publish, no SMS. Test in Task 6.
2. A `webhook-signature` header with extra spaces, or an unknown version entry beside a valid `v1,` entry, must pass; a header holding only a `v2,` entry must fail. Test in Task 1.
3. Replicate `output` as an array of URLs must use the first URL; `status: "aborted"` must give the text-only post and fallback SMS, never silence. Tests in Tasks 2 and 5.
4. A signed callback whose body is not JSON, or lacks `id` or `status`, must answer 200 (ignored), not throw a 500 that makes Replicate retry. Test in Task 6.
5. When the SMS send fails inside the finish, the idempotency record must end `failed` and the job record must be deleted, so a later duplicate callback stops with 200 instead of a minute of 503 retries. Test in Task 6.

---

## File map

| File                                                       | Responsibility                                                                         | Task    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------- |
| `src/adapters/ai/replicate-webhook.ts`                     | Signature verification and the cached signing secret                                   | 1       |
| `tests/helpers/replicate-signing.ts`                       | Test-side signer (node `crypto`, independent of the WebCrypto code) and seeding        | 1       |
| `src/adapters/ai/replicate.ts`                             | `createPrediction`, `fetchOutput`, `isTerminalStatus`; old poll code removed in Task 7 | 2, 7    |
| `src/core/jobs.ts`                                         | Job record type and KV helpers; lease rule                                             | 3       |
| `src/adapters/outbound/deliver.ts`                         | `deliver()` media seam over `sendReply`                                                | 4       |
| `src/core/delivery.ts`                                     | `sendPagesWithCheckpoint`, `deliverCommandResult` (shared reply tail)                  | 4       |
| `src/core/commands/postimg.ts`                             | `startPostImg`, `finishPostImg`; `handlePostImg` removed in Task 7                     | 5, 7    |
| `src/core/types.ts`, `src/core/orchestrator.ts`            | `DeferredResult`, `OrchestrateResult`, `isDeferred`, `origin` on the context           | 5, 7    |
| `src/replicate-callback.ts`                                | Callback route logic (§8 table) and the finish runner                                  | 6       |
| `src/app.ts`                                               | Mount the route; pass `origin`; deferred handling; lease via `jobBlocksRedelivery`     | 4, 6, 7 |
| `tests/helpers/exec-ctx.ts`                                | Fake `ExecutionContext` that collects `waitUntil` promises                             | 6       |
| `src/core/image-pending.ts`, `tests/image-pending.test.ts` | Deleted                                                                                | 7       |
| `docs/PRD.md`, `AGENTS.md`, `docs/architecture.md`         | Documentation                                                                          | 8       |
| `tests/fixtures/replicate/callback-succeeded.json`         | Recorded staging callback body                                                         | 9       |

Branch: `feat/268-async-postimg`, created from `main` after PR #298 (spec and this plan) merges.

---

### Task 1: Signature verification and the cached signing secret

**Files:**

- Create: `src/adapters/ai/replicate-webhook.ts`
- Create: `tests/helpers/replicate-signing.ts`
- Test: `tests/replicate-webhook.test.ts`

**Interfaces:**

- Consumes: `Env` (`IMAGE_API_KEY`, `TS_CACHE`), `log` from `src/adapters/logging/worker-logs.ts`.
- Produces:
  - `verifyReplicateWebhook(headers: Headers, rawBody: string, env: Env, opts?: { now?: () => number; fetchImpl?: typeof fetch }): Promise<VerifyResult>`
  - `type VerifyResult = { ok: true } | { ok: false; reason: "missing_header" | "stale_timestamp" | "mismatch" | "secret_unavailable" }`
  - `WEBHOOK_SECRET_CACHE_KEY = "replicate:webhook-secret"`
  - Test helpers: `TEST_WEBHOOK_SECRET`, `signReplicateBody(body, opts?) → Record<string, string>`, `seedWebhookSecret(env, secret?, fetchedAt?)`.

- [ ] **Step 1: Write the test helper**

`tests/helpers/replicate-signing.ts`:

```ts
import { createHmac } from "node:crypto";
import type { Env } from "../../src/env.js";

/** Standard Webhooks reference test secret (libraries/javascript/src/webhook.test.ts). */
export const TEST_WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

/**
 * Sign a body the way Replicate does (Standard Webhooks v1): HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with the Base64-decoded part after `whsec_`.
 * Uses node `crypto`, deliberately independent of the WebCrypto code under test.
 */
export function signReplicateBody(
  body: string,
  opts: { secret?: string; id?: string; timestampSec?: number } = {},
): Record<string, string> {
  const secret = opts.secret ?? TEST_WEBHOOK_SECRET;
  const id = opts.id ?? "msg_test_0001";
  const ts = String(opts.timestampSec ?? Math.floor(Date.now() / 1000));
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return {
    "content-type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${sig}`,
  };
}

/** Put a signing secret in the cache so verification needs no network. */
export async function seedWebhookSecret(
  env: Env,
  secret = TEST_WEBHOOK_SECRET,
  fetchedAt = Date.now(),
): Promise<void> {
  await env.TS_CACHE.put("replicate:webhook-secret", JSON.stringify({ key: secret, fetchedAt }));
}
```

- [ ] **Step 2: Write the failing tests**

`tests/replicate-webhook.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  verifyReplicateWebhook,
  WEBHOOK_SECRET_CACHE_KEY,
} from "../src/adapters/ai/replicate-webhook.js";
import { makeTestEnv } from "./helpers/env.js";
import {
  TEST_WEBHOOK_SECRET,
  seedWebhookSecret,
  signReplicateBody,
} from "./helpers/replicate-signing.js";
import type { Env } from "../src/env.js";

// Standard Webhooks reference vector (verified locally 2026-10-13).
const VEC_ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const VEC_TS = 1614265330;
const VEC_BODY = '{"test": 2432232314}';
const VEC_SIG = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
const OTHER_SECRET = "whsec_" + Buffer.from("x".repeat(32)).toString("base64");

let env: Env;
let logSpy: ReturnType<typeof vi.spyOn>;

function vecHeaders(sig = VEC_SIG): Headers {
  return new Headers({
    "webhook-id": VEC_ID,
    "webhook-timestamp": String(VEC_TS),
    "webhook-signature": sig,
  });
}
const atVec = () => VEC_TS * 1000;

beforeEach(() => {
  env = makeTestEnv();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
});

describe("verifyReplicateWebhook — algorithm", () => {
  test("the Standard Webhooks reference vector passes", async () => {
    await seedWebhookSecret(env, TEST_WEBHOOK_SECRET, atVec());
    const r = await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: atVec });
    expect(r).toEqual({ ok: true });
  });

  test("a changed body fails", async () => {
    await seedWebhookSecret(env, TEST_WEBHOOK_SECRET, atVec());
    const r = await verifyReplicateWebhook(vecHeaders(), '{"test": 2432232315}', env, {
      now: atVec,
    });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
  });

  test("a wrong, recently fetched secret fails without a re-fetch", async () => {
    await seedWebhookSecret(env, OTHER_SECRET, atVec());
    const fetchImpl = vi.fn();
    const r = await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: atVec, fetchImpl });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("a timestamp more than 300 s old or ahead fails", async () => {
    await seedWebhookSecret(env, TEST_WEBHOOK_SECRET, atVec());
    const late = () => (VEC_TS + 301) * 1000;
    const early = () => (VEC_TS - 301) * 1000;
    expect(await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: late })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
    expect(await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: early })).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
  });

  test("a missing header fails", async () => {
    const h = vecHeaders();
    h.delete("webhook-id");
    expect(await verifyReplicateWebhook(h, VEC_BODY, env, { now: atVec })).toEqual({
      ok: false,
      reason: "missing_header",
    });
  });

  test("Review Focus 2: extra spaces and an unknown entry beside a valid v1 entry pass", async () => {
    await seedWebhookSecret(env, TEST_WEBHOOK_SECRET, atVec());
    const header = `v2,AAAA   v1,bm90LXRoZS1zaWc=  ${VEC_SIG} `;
    expect(await verifyReplicateWebhook(vecHeaders(header), VEC_BODY, env, { now: atVec })).toEqual(
      {
        ok: true,
      },
    );
  });

  test("Review Focus 2: a header holding only a v2 entry fails", async () => {
    await seedWebhookSecret(env, TEST_WEBHOOK_SECRET, atVec());
    const header = VEC_SIG.replace(/^v1,/, "v2,");
    expect(await verifyReplicateWebhook(vecHeaders(header), VEC_BODY, env, { now: atVec })).toEqual(
      {
        ok: false,
        reason: "mismatch",
      },
    );
  });
});

describe("verifyReplicateWebhook — secret cache", () => {
  test("a cache miss fetches the secret with IMAGE_API_KEY, caches it, and the next call does not fetch", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ key: TEST_WEBHOOK_SECRET }), { status: 200 }),
    );
    const r1 = await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: atVec, fetchImpl });
    expect(r1).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.replicate.com/v1/webhooks/default/secret");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${env.IMAGE_API_KEY}`,
    );
    const cached = JSON.parse((await env.TS_CACHE.get(WEBHOOK_SECRET_CACHE_KEY)) ?? "{}");
    expect(cached.key).toBe(TEST_WEBHOOK_SECRET);

    const r2 = await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: atVec, fetchImpl });
    expect(r2).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("rotation: a mismatch with a cached secret older than 10 min re-fetches once and passes", async () => {
    await seedWebhookSecret(env, OTHER_SECRET, atVec() - 11 * 60 * 1000);
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ key: TEST_WEBHOOK_SECRET }), { status: 200 }),
    );
    const r = await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: atVec, fetchImpl });
    expect(r).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("a failed secret fetch on a cache miss gives secret_unavailable", async () => {
    const fetchImpl = vi.fn(async () => new Response("boom", { status: 500 }));
    const r = await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: atVec, fetchImpl });
    expect(r).toEqual({ ok: false, reason: "secret_unavailable" });
  });

  test("a failed cache write still verifies with the fetched secret", async () => {
    vi.spyOn(env.TS_CACHE, "put").mockRejectedValueOnce(new Error("KV 429"));
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ key: TEST_WEBHOOK_SECRET }), { status: 200 }),
    );
    const r = await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: atVec, fetchImpl });
    expect(r).toEqual({ ok: true });
  });

  test("the secret and the signature never reach the log", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ key: TEST_WEBHOOK_SECRET }), { status: 200 }),
    );
    await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: atVec, fetchImpl });
    await verifyReplicateWebhook(vecHeaders("v1,AAAA"), VEC_BODY, env, { now: atVec, fetchImpl });
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain(TEST_WEBHOOK_SECRET.slice(6));
    expect(logged).not.toContain(VEC_SIG.slice(3));
  });

  test("the test signer agrees with the production verifier", async () => {
    await seedWebhookSecret(env);
    const body = '{"id":"p1","status":"succeeded"}';
    const headers = new Headers(signReplicateBody(body));
    expect(await verifyReplicateWebhook(headers, body, env)).toEqual({ ok: true });
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/replicate-webhook.test.ts`
Expected: FAIL — `Cannot find module '../src/adapters/ai/replicate-webhook.js'`.

- [ ] **Step 4: Write the implementation**

`src/adapters/ai/replicate-webhook.ts`:

```ts
import type { Env } from "../../env.js";
import { log } from "../logging/worker-logs.js";

/**
 * Replicate webhook signature verification (#268, spec §7).
 *
 * Replicate signs callbacks per Standard Webhooks v1: headers `webhook-id`,
 * `webhook-timestamp` (seconds) and `webhook-signature` (space-separated
 * `v1,<base64>` entries); HMAC-SHA256 over `${id}.${timestamp}.${rawBody}`
 * keyed with the Base64-DECODED part of the `whsec_…` secret. Replicate's own
 * page does not say "decoded"; the Standard Webhooks reference library does,
 * and the staging check on #268 confirms it against a real callback.
 *
 * The secret is fetched with the existing `IMAGE_API_KEY` from
 * `GET /v1/webhooks/default/secret` and cached in `TS_CACHE` with no TTL. A
 * mismatch against a copy older than 10 minutes re-fetches once (rotation);
 * the age gate caps forged requests at one fetch per 10 minutes.
 */

export const WEBHOOK_SECRET_CACHE_KEY = "replicate:webhook-secret";
const SECRET_URL = "https://api.replicate.com/v1/webhooks/default/secret";
const TOLERANCE_SECONDS = 300;
const REFETCH_AFTER_MS = 10 * 60 * 1000;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "stale_timestamp" | "mismatch" | "secret_unavailable" };

interface CachedSecret {
  key: string;
  fetchedAt: number;
}

/**
 * Verify a Replicate callback. `rawBody` must be the exact request text.
 * Never logs the secret or the signature.
 */
export async function verifyReplicateWebhook(
  headers: Headers,
  rawBody: string,
  env: Env,
  opts: { now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<VerifyResult> {
  const now = opts.now ?? Date.now;
  const id = headers.get("webhook-id");
  const ts = headers.get("webhook-timestamp");
  const sigHeader = headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return { ok: false, reason: "missing_header" };

  const tsSec = Number(ts);
  if (!Number.isFinite(tsSec) || Math.abs(now() / 1000 - tsSec) > TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const candidates = sigHeader
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .flatMap((entry) => {
      const comma = entry.indexOf(",");
      if (comma < 0) return [];
      return entry.slice(0, comma) === "v1" ? [entry.slice(comma + 1)] : [];
    });
  if (candidates.length === 0) return { ok: false, reason: "mismatch" };

  const signed = `${id}.${ts}.${rawBody}`;

  let secret = await readCachedSecret(env);
  if (secret === undefined) {
    secret = await fetchAndCacheSecret(env, now, opts.fetchImpl);
    if (secret === undefined) return { ok: false, reason: "secret_unavailable" };
  }
  if (await matches(secret.key, signed, candidates)) return { ok: true };
  if (now() - secret.fetchedAt < REFETCH_AFTER_MS) return { ok: false, reason: "mismatch" };

  const fresh = await fetchAndCacheSecret(env, now, opts.fetchImpl);
  if (fresh === undefined) return { ok: false, reason: "secret_unavailable" };
  return (await matches(fresh.key, signed, candidates))
    ? { ok: true }
    : { ok: false, reason: "mismatch" };
}

async function matches(secret: string, signed: string, candidates: string[]): Promise<boolean> {
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(secret.startsWith("whsec_") ? secret.slice(6) : secret);
  } catch {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const expected = bytesToBase64(new Uint8Array(mac));
  return candidates.some((c) => constantTimeEqual(c, expected));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readCachedSecret(env: Env): Promise<CachedSecret | undefined> {
  try {
    const raw = await env.TS_CACHE.get(WEBHOOK_SECRET_CACHE_KEY);
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as Partial<CachedSecret>;
    if (typeof parsed.key === "string" && typeof parsed.fetchedAt === "number") {
      return { key: parsed.key, fetchedAt: parsed.fetchedAt };
    }
  } catch {
    // Corrupt cache entry: treat as a miss and re-fetch.
  }
  return undefined;
}

async function fetchAndCacheSecret(
  env: Env,
  now: () => number,
  fetchImpl: typeof fetch = fetch,
): Promise<CachedSecret | undefined> {
  let key: unknown;
  try {
    const res = await fetchImpl(SECRET_URL, {
      headers: { Authorization: `Bearer ${env.IMAGE_API_KEY}` },
    });
    if (!res.ok) {
      log({ event: "replicate_secret_fetch_failed", level: "warn", status: res.status });
      return undefined;
    }
    key = ((await res.json()) as { key?: unknown }).key;
  } catch (e) {
    log({
      event: "replicate_secret_fetch_failed",
      level: "warn",
      status: 0,
      error: e instanceof Error ? e.message : String(e),
    });
    return undefined;
  }
  if (typeof key !== "string" || key.length === 0) {
    log({
      event: "replicate_secret_fetch_failed",
      level: "warn",
      status: 200,
      error: "no key field",
    });
    return undefined;
  }
  const secret: CachedSecret = { key, fetchedAt: now() };
  try {
    await env.TS_CACHE.put(WEBHOOK_SECRET_CACHE_KEY, JSON.stringify(secret));
  } catch {
    // A failed cache write (e.g. the one-write-per-second limit) must not fail
    // verification; the next callback re-fetches.
  }
  return secret;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/replicate-webhook.test.ts && pnpm typecheck && pnpm lint`
Expected: all tests PASS; typecheck and lint clean. If `crypto.subtle.importKey` rejects the `Uint8Array` type under `@cloudflare/workers-types`, pass `keyBytes.buffer as ArrayBuffer` instead.

- [ ] **Step 6: Commit**

```bash
pnpm format src/adapters/ai/replicate-webhook.ts tests/replicate-webhook.test.ts tests/helpers/replicate-signing.ts
git add src/adapters/ai/replicate-webhook.ts tests/replicate-webhook.test.ts tests/helpers/replicate-signing.ts
git commit -m "feat(replicate): verify Standard Webhooks signatures with a cached signing secret (#268)"
```

(Add the two trailer lines from Global Constraints to every commit message.)

---

### Task 2: Prediction create with a webhook, and output download

**Files:**

- Modify: `src/adapters/ai/replicate.ts` (add exports; `generateImage` stays until Task 7)
- Test: `tests/replicate.test.ts` (add describe blocks; the `generateImage` blocks are deleted in Task 7)

**Interfaces:**

- Consumes: `Env` (`IMAGE_PROVIDER`, `IMAGE_MODEL`, `IMAGE_API_KEY`, `IMAGE_COST_PER_CALL_USD`), existing `ImageGenError`, `pickOutputUrl`, `safeText`, `TERMINAL_STATUSES`.
- Produces:
  - `export interface ReplicatePrediction` (the existing interface, now exported, plus `metrics?: { predict_time?: number }`)
  - `createPrediction(args: { prompt: string; resolution?: "1 MP" | "2 MP" | "4 MP"; aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4"; webhookUrl: string; env: Env; fetchImpl?: typeof fetch }): Promise<{ id: string; status: string }>`
  - `fetchOutput(prediction: Pick<ReplicatePrediction, "id" | "output">, env: Env, fetchImpl?: typeof fetch): Promise<{ bytes: ArrayBuffer; mimeType: string; model: string; costUsd: number }>`
  - `isTerminalStatus(status: string): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `tests/replicate.test.ts` (extend the import line to `import { createPrediction, fetchOutput, generateImage, ImageGenError, isTerminalStatus } from "../src/adapters/ai/replicate.js";`):

```ts
const WEBHOOK = "https://w.test/replicate/callback?key=k1";

describe("createPrediction — webhook mode (#268)", () => {
  test("POSTs input, webhook and the completed filter, with no Prefer header", async () => {
    fetchImpl.mockResolvedValueOnce(predictionResponse({ id: "pred-1", status: "starting" }));
    const r = await createPrediction({
      prompt: "a lake at dusk",
      resolution: "2 MP",
      webhookUrl: WEBHOOK,
      env,
      fetchImpl,
    });
    expect(r).toEqual({ id: "pred-1", status: "starting" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.replicate.com/v1/models/${env.IMAGE_MODEL}/predictions`);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${env.IMAGE_API_KEY}`);
    expect(headers.Prefer).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      input: { prompt: "a lake at dusk", resolution: "2 MP" },
      webhook: WEBHOOK,
      webhook_events_filter: ["completed"],
    });
  });

  test("a 4xx surfaces as ImageGenError with the provider body", async () => {
    fetchImpl.mockResolvedValueOnce(new Response("bad input", { status: 422 }));
    await expect(
      createPrediction({ prompt: "x", webhookUrl: WEBHOOK, env, fetchImpl }),
    ).rejects.toMatchObject({
      name: "ImageGenError",
      status: 422,
      providerResponse: "bad input",
    });
  });

  test("a network error surfaces as ImageGenError status 0", async () => {
    fetchImpl.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(
      createPrediction({ prompt: "x", webhookUrl: WEBHOOK, env, fetchImpl }),
    ).rejects.toMatchObject({
      status: 0,
    });
  });

  test("a response without an id is an error, not a silent deferral", async () => {
    fetchImpl.mockResolvedValueOnce(predictionResponse({ status: "starting" }));
    await expect(
      createPrediction({ prompt: "x", webhookUrl: WEBHOOK, env, fetchImpl }),
    ).rejects.toBeInstanceOf(ImageGenError);
  });

  test("rejects a non-replicate IMAGE_PROVIDER", async () => {
    const other = { ...env, IMAGE_PROVIDER: "other" };
    await expect(
      createPrediction({ prompt: "x", webhookUrl: WEBHOOK, env: other, fetchImpl }),
    ).rejects.toBeInstanceOf(ImageGenError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("fetchOutput (#268)", () => {
  test("downloads a string output without an Authorization header", async () => {
    fetchImpl.mockResolvedValueOnce(imageResponse(PNG_BYTES, "image/webp"));
    const r = await fetchOutput(
      { id: "p", output: "https://replicate.delivery/a.webp" },
      env,
      fetchImpl,
    );
    expect(r.mimeType).toBe("image/webp");
    expect(r.bytes.byteLength).toBe(4);
    expect(r.model).toBe(env.IMAGE_MODEL);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit | undefined];
    expect(init).toBeUndefined();
  });

  test("Review Focus 3: an array output uses the first URL", async () => {
    fetchImpl.mockResolvedValueOnce(imageResponse(PNG_BYTES));
    await fetchOutput(
      { id: "p", output: ["https://replicate.delivery/1.png", "https://replicate.delivery/2.png"] },
      env,
      fetchImpl,
    );
    expect(fetchImpl.mock.calls[0][0]).toBe("https://replicate.delivery/1.png");
  });

  test("an empty output is an ImageGenError carrying the prediction id", async () => {
    await expect(fetchOutput({ id: "p9", output: null }, env, fetchImpl)).rejects.toMatchObject({
      predictionId: "p9",
    });
  });

  test("an HTTP error on download is an ImageGenError", async () => {
    fetchImpl.mockResolvedValueOnce(new Response("gone", { status: 404 }));
    await expect(
      fetchOutput({ id: "p", output: "https://replicate.delivery/a.webp" }, env, fetchImpl),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("isTerminalStatus (#268)", () => {
  test("succeeded, failed, canceled and aborted are terminal; starting and processing are not", () => {
    for (const s of ["succeeded", "failed", "canceled", "aborted"])
      expect(isTerminalStatus(s)).toBe(true);
    for (const s of ["starting", "processing", "something-new"])
      expect(isTerminalStatus(s)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/replicate.test.ts`
Expected: FAIL — `createPrediction is not a function` (and the other two).

- [ ] **Step 3: Write the implementation**

In `src/adapters/ai/replicate.ts`:

1. Change `interface ReplicatePrediction {` to `export interface ReplicatePrediction {`, add the field `metrics?: { predict_time?: number };`, and widen `status` to `string` (keep the existing comment and list the known values in it: `starting | processing | succeeded | failed | canceled | aborted`). A callback body is external input and Replicate may add statuses; `isTerminalStatus` decides, and tests can pass plain string literals.
2. Append:

```ts
/**
 * Create a prediction that reports back by webhook (#268, spec §5.1).
 *
 * No `Prefer: wait` header: with it Replicate holds this request open for up
 * to 60 s, which is the delay this design removes. `webhook_events_filter:
 * ["completed"]` makes Replicate call back once, on the terminal state.
 */
export async function createPrediction(args: {
  prompt: string;
  resolution?: "1 MP" | "2 MP" | "4 MP";
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  webhookUrl: string;
  env: Env;
  fetchImpl?: typeof fetch;
}): Promise<{ id: string; status: string }> {
  const { env } = args;
  const httpFetch = args.fetchImpl ?? fetch;
  if (env.IMAGE_PROVIDER !== "replicate") {
    throw new ImageGenError({
      status: 0,
      message: `unsupported IMAGE_PROVIDER: ${env.IMAGE_PROVIDER}`,
    });
  }
  const input: Record<string, unknown> = { prompt: args.prompt };
  if (args.aspectRatio !== undefined) input.aspect_ratio = args.aspectRatio;
  if (args.resolution !== undefined) input.resolution = args.resolution;

  let res: Response;
  try {
    res = await httpFetch(`https://api.replicate.com/v1/models/${env.IMAGE_MODEL}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.IMAGE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input,
        webhook: args.webhookUrl,
        webhook_events_filter: ["completed"],
      }),
    });
  } catch (e) {
    throw new ImageGenError({
      status: 0,
      message: `network error contacting Replicate: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  if (!res.ok) {
    throw new ImageGenError({
      status: res.status,
      message: `Replicate prediction failed: HTTP ${res.status}`,
      providerResponse: await safeText(res),
    });
  }
  const body = (await res.json()) as Partial<ReplicatePrediction>;
  if (typeof body.id !== "string" || body.id.length === 0) {
    throw new ImageGenError({
      status: 0,
      message: "Replicate create response has no prediction id",
      providerResponse: JSON.stringify(body),
    });
  }
  return { id: body.id, status: typeof body.status === "string" ? body.status : "unknown" };
}

/**
 * Download a finished prediction's image (#268). No Authorization header: the
 * delivery URL is pre-signed object storage and rejects a bearer token.
 */
export async function fetchOutput(
  prediction: Pick<ReplicatePrediction, "id" | "output">,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: ArrayBuffer; mimeType: string; model: string; costUsd: number }> {
  const outputUrl = pickOutputUrl(prediction.output);
  if (outputUrl === undefined) {
    throw new ImageGenError({
      status: 0,
      message: "Replicate output is empty or not a URL",
      predictionId: prediction.id,
    });
  }
  let res: Response;
  try {
    res = await fetchImpl(outputUrl);
  } catch (e) {
    throw new ImageGenError({
      status: 0,
      message: `network error fetching generated image: ${e instanceof Error ? e.message : String(e)}`,
      predictionId: prediction.id,
    });
  }
  if (!res.ok) {
    throw new ImageGenError({
      status: res.status,
      message: `Failed to fetch generated image bytes: HTTP ${res.status}`,
      predictionId: prediction.id,
    });
  }
  return {
    bytes: await res.arrayBuffer(),
    mimeType: res.headers.get("content-type") ?? "image/webp",
    model: env.IMAGE_MODEL,
    costUsd: Number.parseFloat(env.IMAGE_COST_PER_CALL_USD) || 0,
  };
}

/** True for a status after which a prediction never changes again. */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/replicate.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS (old `generateImage` tests still pass too).

- [ ] **Step 5: Commit**

```bash
pnpm format src/adapters/ai/replicate.ts tests/replicate.test.ts
git add src/adapters/ai/replicate.ts tests/replicate.test.ts
git commit -m "feat(replicate): create predictions with a completion webhook; download outputs separately (#268)"
```

---

### Task 3: The job record

**Files:**

- Create: `src/core/jobs.ts`
- Test: `tests/jobs.test.ts`

**Interfaces:**

- Consumes: `IDEMPOTENCY_TTL_SECONDS` from `src/core/idempotency.ts`, `log`.
- Produces:
  - `interface PostImgJob { kind: "postimg"; imei: string; createdAt: number; predictionId: string; finishStartedAt?: number; caption?: string; narrative: { title: string; haiku: string; body: string }; lat?: number; lon?: number; placeName?: string; weather?: string }`
  - `type Job = PostImgJob`
  - `FINISH_LEASE_MS = 120_000`
  - `writeJob(env, idemKey, job): Promise<void>` — throws on KV failure (the caller falls back)
  - `readJob(env, idemKey): Promise<Job | undefined>` — corrupt or incomplete → `undefined`
  - `deleteJob(env, idemKey): Promise<void>` — best-effort
  - `markFinishStarted(env, idemKey, job, now?): Promise<void>` — best-effort
  - `finishInProgress(job, now?): boolean`
  - `jobBlocksRedelivery(env, idemKey): Promise<boolean>`

- [ ] **Step 1: Write the failing tests**

`tests/jobs.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  deleteJob,
  finishInProgress,
  FINISH_LEASE_MS,
  jobBlocksRedelivery,
  markFinishStarted,
  readJob,
  writeJob,
  type PostImgJob,
} from "../src/core/jobs.js";
import { IDEMPOTENCY_TTL_SECONDS } from "../src/core/idempotency.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;
const KEY = "k1";
const JOB: PostImgJob = {
  kind: "postimg",
  imei: "123456789012345",
  createdAt: 1_000,
  predictionId: "pred-1",
  caption: "fog on the ridge",
  narrative: { title: "Ridge Fog", haiku: "a\nb\nc", body: "Body." },
  lat: 37.1,
  lon: -118.5,
  placeName: "Lake Sabrina",
  weather: "42°F clear",
};

beforeEach(() => {
  env = makeTestEnv();
});

describe("job record (#268)", () => {
  test("round-trips under job:<key> with the 48 h idempotency TTL", async () => {
    const put = vi.spyOn(env.TS_IDEMPOTENCY, "put");
    await writeJob(env, KEY, JOB);
    expect(put).toHaveBeenCalledWith(`job:${KEY}`, expect.any(String), {
      expirationTtl: IDEMPOTENCY_TTL_SECONDS,
    });
    expect(await readJob(env, KEY)).toEqual(JOB);
  });

  test("absent reads as undefined", async () => {
    expect(await readJob(env, "nope")).toBeUndefined();
  });

  test("corrupt JSON or a record without predictionId reads as undefined", async () => {
    await env.TS_IDEMPOTENCY.put(`job:${KEY}`, "{not json");
    expect(await readJob(env, KEY)).toBeUndefined();
    const { predictionId: _omit, ...noPred } = JOB;
    await env.TS_IDEMPOTENCY.put(`job:${KEY}`, JSON.stringify(noPred));
    expect(await readJob(env, KEY)).toBeUndefined();
  });

  test("writeJob propagates a KV failure so the caller can fall back", async () => {
    vi.spyOn(env.TS_IDEMPOTENCY, "put").mockRejectedValueOnce(new Error("KV 429"));
    await expect(writeJob(env, KEY, JOB)).rejects.toThrow("KV 429");
  });

  test("deleteJob removes it and swallows a KV failure", async () => {
    await writeJob(env, KEY, JOB);
    await deleteJob(env, KEY);
    expect(await readJob(env, KEY)).toBeUndefined();
    vi.spyOn(env.TS_IDEMPOTENCY, "delete").mockRejectedValueOnce(new Error("KV down"));
    await expect(deleteJob(env, KEY)).resolves.toBeUndefined();
  });

  test("jobBlocksRedelivery is true while a job exists and false after delete", async () => {
    expect(await jobBlocksRedelivery(env, KEY)).toBe(false);
    await writeJob(env, KEY, JOB);
    expect(await jobBlocksRedelivery(env, KEY)).toBe(true);
    await deleteJob(env, KEY);
    expect(await jobBlocksRedelivery(env, KEY)).toBe(false);
  });

  test("finishInProgress: unset → false; under 2 min → true; at 2 min → false", () => {
    expect(finishInProgress(JOB, 10_000)).toBe(false);
    const started = { ...JOB, finishStartedAt: 10_000 };
    expect(finishInProgress(started, 10_000 + FINISH_LEASE_MS - 1)).toBe(true);
    expect(finishInProgress(started, 10_000 + FINISH_LEASE_MS)).toBe(false);
  });

  test("markFinishStarted writes finishStartedAt and swallows a KV failure", async () => {
    await writeJob(env, KEY, JOB);
    await markFinishStarted(env, KEY, JOB, 5_000);
    expect((await readJob(env, KEY))?.finishStartedAt).toBe(5_000);
    vi.spyOn(env.TS_IDEMPOTENCY, "put").mockRejectedValueOnce(new Error("KV 429"));
    await expect(markFinishStarted(env, KEY, JOB, 6_000)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/jobs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

`src/core/jobs.ts`:

```ts
import type { Env } from "../env.js";
import { IDEMPOTENCY_TTL_SECONDS } from "./idempotency.js";
import { log } from "../adapters/logging/worker-logs.js";

/**
 * Job record for work that finishes in a provider callback (#268, spec §6).
 *
 * Written ONCE, after the provider job exists, so every record carries a paid
 * `predictionId`. Cloudflare KV allows one write per second per key; a write
 * before and another after the create call would collide, and a record with
 * no `predictionId` could not be matched by the callback or act as a lease.
 *
 * **Lease (replaces the 180 s window of the old `image-pending.ts`).** While a
 * record exists, a Garmin re-delivery of the same event is skipped at any age:
 * the record means a picture is paid for, and a second one must never be
 * bought. The old lease needed a time window because `!postimg` held Garmin's
 * request open past its ~71 s re-delivery point while polling; now Garmin has
 * its answer in ~10 s, the poll is gone, and the only remaining question is
 * "is a paid job outstanding?". A job whose callback is lost stays outstanding
 * until the 48 h TTL; the operator resends (decision 4 in the spec).
 */

export interface PostImgJob {
  kind: "postimg";
  imei: string;
  /** ms epoch when the record was written. */
  createdAt: number;
  predictionId: string;
  /** ms epoch; set by the callback just before the finish runs. */
  finishStartedAt?: number;
  caption?: string;
  narrative: { title: string; haiku: string; body: string };
  lat?: number;
  lon?: number;
  placeName?: string;
  weather?: string;
}

/** Union of job kinds; `!postvid` (#246) adds a member. */
export type Job = PostImgJob;

/** A second callback inside this window after a finish started is a duplicate. */
export const FINISH_LEASE_MS = 120_000;

const jobKey = (idemKey: string) => `job:${idemKey}`;

/** Write the job record. Throws on KV failure; the caller falls back to text-only. */
export async function writeJob(env: Env, idemKey: string, job: Job): Promise<void> {
  await env.TS_IDEMPOTENCY.put(jobKey(idemKey), JSON.stringify(job), {
    expirationTtl: IDEMPOTENCY_TTL_SECONDS,
  });
}

/** Read the job record. A corrupt or incomplete record reads as absent. */
export async function readJob(env: Env, idemKey: string): Promise<Job | undefined> {
  let raw: string | null;
  try {
    raw = await env.TS_IDEMPOTENCY.get(jobKey(idemKey));
  } catch {
    return undefined;
  }
  if (raw === null) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<PostImgJob>;
    if (
      p.kind === "postimg" &&
      typeof p.imei === "string" &&
      typeof p.predictionId === "string" &&
      typeof p.createdAt === "number" &&
      typeof p.narrative?.title === "string" &&
      typeof p.narrative?.body === "string"
    ) {
      return p as PostImgJob;
    }
  } catch {
    // fall through
  }
  log({ event: "job_record_unreadable", level: "warn", key: idemKey });
  return undefined;
}

/** Delete the job record. Best-effort: the TTL reaps a leftover. */
export async function deleteJob(env: Env, idemKey: string): Promise<void> {
  try {
    await env.TS_IDEMPOTENCY.delete(jobKey(idemKey));
  } catch {
    // TTL reaps it.
  }
}

/**
 * Record that a finish has started. Best-effort: on a prediction that failed
 * within a second this write can hit the per-key rate limit, and the
 * checkpoints still stop a sequential duplicate.
 */
export async function markFinishStarted(
  env: Env,
  idemKey: string,
  job: Job,
  now: number = Date.now(),
): Promise<void> {
  try {
    await writeJob(env, idemKey, { ...job, finishStartedAt: now });
  } catch (e) {
    log({
      event: "job_finish_mark_failed",
      level: "warn",
      key: idemKey,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** True when another callback started a finish less than `FINISH_LEASE_MS` ago. */
export function finishInProgress(job: Job, now: number = Date.now()): boolean {
  return job.finishStartedAt !== undefined && now - job.finishStartedAt < FINISH_LEASE_MS;
}

/** True while a paid job is outstanding for this event: skip a Garmin re-delivery. */
export async function jobBlocksRedelivery(env: Env, idemKey: string): Promise<boolean> {
  return (await readJob(env, idemKey)) !== undefined;
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/jobs.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS. If lint flags the unused `_omit` destructure in the test, keep the underscore prefix (the repo's ESLint config ignores `_`-prefixed vars) or build `noPred` with `const noPred = { ...JOB } as Partial<PostImgJob>; delete noPred.predictionId;`.

- [ ] **Step 5: Commit**

```bash
pnpm format src/core/jobs.ts tests/jobs.test.ts
git add src/core/jobs.ts tests/jobs.test.ts
git commit -m "feat(jobs): KV job record for provider-callback completion; existence is the lease (#268)"
```

---

### Task 4: Delivery seam and the shared reply tail (refactor, no behaviour change)

**Files:**

- Create: `src/adapters/outbound/deliver.ts`
- Create: `src/core/delivery.ts`
- Modify: `src/app.ts` (replace `trySendReplyWithCheckpoint` and the reply tail of `handleEvent`)
- Test: `tests/delivery.test.ts`

**Interfaces:**

- Consumes: `sendReply`, `IpcInboundError` from `src/adapters/outbound/garmin-ipc-inbound.ts`; `buildReply`; `monthlyTotals`; `appendCostSuffix`; `withCheckpoint`, `markCompleted`.
- Produces:
  - `interface OutboundMedia { mimeType: string; bytes: ArrayBuffer }`
  - `deliver(imei: string, payload: { pages: string[]; media?: OutboundMedia }, env: Env): Promise<{ count: number }>`
  - `sendPagesWithCheckpoint(env: Env, idemKey: string, imei: string, pages: string[]): Promise<boolean>`
  - `deliverCommandResult(env: Env, idemKey: string, imei: string, result: CommandResult): Promise<boolean>` — builds the reply, sends it under the `reply` checkpoint, and calls `markCompleted` on success. Returns `false` on a send failure (record not completed).

`deliver` lives in its own module because 16 test files mock `garmin-ipc-inbound.js` as `{ sendReply }`; a `deliver` export added to that module would be `undefined` under those mocks.

- [ ] **Step 1: Write the failing tests**

`tests/delivery.test.ts`:

```ts
import { beforeEach, describe, expect, test, vi } from "vitest";
import { deliver } from "../src/adapters/outbound/deliver.js";
import { deliverCommandResult } from "../src/core/delivery.js";
import { readRecord, writeRecord } from "../src/core/idempotency.js";
import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", async (orig) => ({
  ...(await orig<typeof import("../src/adapters/outbound/garmin-ipc-inbound.js")>()),
  sendReply: vi.fn().mockResolvedValue({ count: 1 }),
}));
const sendReplyMock = vi.mocked(sendReply);

let env: Env;
beforeEach(() => {
  env = makeTestEnv();
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("deliver — media seam (#268)", () => {
  test("pages go to sendReply", async () => {
    await deliver("123456789012345", { pages: ["hello"] }, env);
    expect(sendReplyMock).toHaveBeenCalledWith("123456789012345", ["hello"], env);
  });

  test("media is not implemented yet and says so", async () => {
    await expect(
      deliver(
        "123456789012345",
        { pages: [], media: { mimeType: "image/avif", bytes: new ArrayBuffer(1) } },
        env,
      ),
    ).rejects.toThrow(/not implemented \(#285\)/);
    expect(sendReplyMock).not.toHaveBeenCalled();
  });
});

describe("deliverCommandResult (#268)", () => {
  test("builds the reply, sends it, and completes the record", async () => {
    await writeRecord(env, "k", { status: "processing", receivedAt: 1 });
    const ok = await deliverCommandResult(env, "k", "123456789012345", { body: "pong" });
    expect(ok).toBe(true);
    expect(sendReplyMock).toHaveBeenCalledWith("123456789012345", ["pong"], env);
    expect((await readRecord(env, "k"))?.status).toBe("completed");
  });

  test("a send failure returns false and leaves the record not completed", async () => {
    await writeRecord(env, "k", { status: "processing", receivedAt: 1 });
    sendReplyMock.mockRejectedValueOnce(new Error("IPC 503"));
    const ok = await deliverCommandResult(env, "k", "123456789012345", { body: "pong" });
    expect(ok).toBe(false);
    expect((await readRecord(env, "k"))?.status).toBe("processing");
  });

  test("a second call after a sent reply does not send again (reply checkpoint)", async () => {
    await deliverCommandResult(env, "k", "123456789012345", { body: "pong" });
    await deliverCommandResult(env, "k", "123456789012345", { body: "pong" });
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });
});
```

Also add this pinning test to the `media_event diagnostic` describe block in `tests/app.test.ts` (it covers the seam "nothing in the webhook route assumes a small request body"; it passes before and after this task):

```ts
test("seam (#268): a 1 MB-class V4 media body is read whole and accepted", async () => {
  const bigB64 = "QUJD".repeat(350_000); // 1,400,000 Base64 chars = 1,050,000 bytes
  const event = { ...mediaFixture.Events[0], mediaBytes: bigB64 };
  const res = await postIpc(
    { ...mediaFixture, Events: [event] },
    { bearer: env.GARMIN_INBOUND_TOKEN },
  );
  expect(res.status).toBe(200);
  const media = loggedLines(consoleLog).find((l) => l.event === "media_event");
  expect(media?.mediaBytesLength).toBe(1_050_000);
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/delivery.test.ts tests/app.test.ts`
Expected: `tests/delivery.test.ts` FAILS — modules not found; the new `app.test.ts` test PASSES (pinning test).

- [ ] **Step 3: Write the implementation**

`src/adapters/outbound/deliver.ts`:

```ts
import type { Env } from "../../env.js";
import { sendReply } from "./garmin-ipc-inbound.js";

/** A media attachment for IPC Inbound `/api/Messaging/Media` (#285). */
export interface OutboundMedia {
  mimeType: string;
  bytes: ArrayBuffer;
}

/**
 * Deliver text pages, and later media, to the device (#268 media seam).
 * Pages go to `sendReply` (`/api/Messaging/Message`). The media branch is
 * deliberately unimplemented until the media design (#285) settles encoding.
 */
export async function deliver(
  imei: string,
  payload: { pages: string[]; media?: OutboundMedia },
  env: Env,
): Promise<{ count: number }> {
  if (payload.media !== undefined) {
    // A plain Error on purpose: 16 test files mock garmin-ipc-inbound.js as
    // `{ sendReply }`, so importing IpcInboundError here would read a missing
    // mock export.
    throw new Error("media delivery is not implemented (#285)");
  }
  return sendReply(imei, payload.pages, env);
}
```

`src/core/delivery.ts`:

```ts
import type { Env } from "../env.js";
import { appendCostSuffix } from "../env.js";
import type { CommandResult } from "./types.js";
import { buildReply } from "./reply.js";
import { monthlyTotals } from "./ledger.js";
import { markCompleted, withCheckpoint } from "./idempotency.js";
import { deliver } from "../adapters/outbound/deliver.js";
import { log } from "../adapters/logging/worker-logs.js";

/**
 * Send pre-built pages under the `reply` checkpoint, so a replay after a
 * successful send (but before `markCompleted` reached KV) does not send twice.
 * Returns true on send or cache-hit replay; false on send failure.
 */
export async function sendPagesWithCheckpoint(
  env: Env,
  idemKey: string,
  imei: string,
  pages: string[],
): Promise<boolean> {
  try {
    await withCheckpoint(env, idemKey, "reply", async () => {
      await deliver(imei, { pages }, env);
      return { sentAt: Date.now() };
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "reply_send_failed", level: "error", imei, error: msg });
    return false;
  }
}

/**
 * The reply tail shared by the Garmin webhook and provider callbacks (#268):
 * optional cost suffix, `buildReply`, checkpointed send, `markCompleted` on
 * success. Returns false when the send failed (record left not completed).
 */
export async function deliverCommandResult(
  env: Env,
  idemKey: string,
  imei: string,
  result: CommandResult,
): Promise<boolean> {
  // The cost suffix is opt-in; only read the ledger when the flag is on.
  const costUsdMtd = appendCostSuffix(env) ? (await monthlyTotals(env)).usd_cost : undefined;
  const pages = buildReply({
    body: result.body,
    journalUrl: result.journalUrl,
    links: result.links,
    costUsdMtd,
    env,
  });
  const ok = await sendPagesWithCheckpoint(env, idemKey, imei, pages);
  if (ok) await markCompleted(env, idemKey);
  return ok;
}
```

In `src/app.ts`:

1. Add `import { deliverCommandResult, sendPagesWithCheckpoint } from "./core/delivery.js";`.
2. Delete the whole `trySendReplyWithCheckpoint` function (its JSDoc starts "Wrap the IPC Inbound send in a withCheckpoint…").
3. Replace every remaining call `trySendReplyWithCheckpoint(` with `sendPagesWithCheckpoint(` (three sites: `parse_usage`, `parse_unknown`, the `orchestrate_error` branch).
4. Replace the tail of `handleEvent`, from the comment "The cost suffix is opt-in…" to the end of the function, with:

```ts
  await deliverCommandResult(env, key, event.imei, result);
}
```

5. Remove imports that are now unused (`sendReply`, `buildReply` if no longer referenced, `monthlyTotals`, `appendCostSuffix`). Let `pnpm typecheck` (`noUnusedLocals`) and `pnpm lint` tell you which.

- [ ] **Step 4: Run the full suite and confirm no behaviour changed**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: every existing test still PASSES, plus the five new ones.

- [ ] **Step 5: Commit**

```bash
pnpm format src/adapters/outbound/deliver.ts src/core/delivery.ts src/app.ts tests/delivery.test.ts
git add src/adapters/outbound/deliver.ts src/core/delivery.ts src/app.ts tests/delivery.test.ts tests/app.test.ts
git commit -m "refactor(reply): shared deliverCommandResult and a deliver() media seam (#268)"
```

---

### Task 5: `startPostImg` and `finishPostImg`

**Files:**

- Modify: `src/core/types.ts` (add `DeferredResult`, `OrchestrateResult`)
- Modify: `src/core/orchestrator.ts` (`OrchestratorContext.origin`, `isDeferred`)
- Modify: `src/core/commands/postimg.ts` (add the two functions; `handlePostImg` stays until Task 7)
- Test: `tests/postimg-async.test.ts`

**Interfaces:**

- Consumes: `createPrediction`, `fetchOutput`, `ImageGenError`, `ReplicatePrediction` (Task 2); `writeJob`, `PostImgJob` (Task 3); existing `generateNarrative`, `buildImagePrompt`, `localTimeOfDay`, `reverseGeocode`, `currentWeatherDetail`, `publishPost`, `publishPostWithImage`, `recordTransaction`, `recordImageTransaction`, `appendEvent`, `withCheckpoint`, `markFailed`, `checkBudget`.
- Produces:
  - `src/core/types.ts`: `export interface DeferredResult { deferred: true }` and `export type OrchestrateResult = CommandResult | DeferredResult;`
  - `src/core/orchestrator.ts`: `OrchestratorContext.origin?: string` (the Worker's public origin, e.g. `https://trailscribe.x.workers.dev`); `export function isDeferred(r: OrchestrateResult): r is DeferredResult`
  - `startPostImg(cmd: PostImgCommand, ctx: OrchestratorContext): Promise<OrchestrateResult>`
  - `finishPostImg(args: { env: Env; idemKey: string; job: PostImgJob; prediction: Pick<ReplicatePrediction, "id" | "status" | "output" | "error"> }): Promise<CommandResult>`
  - `FALLBACK_SUFFIX = " (no image — retry !postimg)"` (module constant, used by both)

- [ ] **Step 1: Write the failing tests**

`tests/postimg-async.test.ts` (reuses the fetch-routing style of `tests/p2-18-postimg.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { finishPostImg, startPostImg } from "../src/core/commands/postimg.js";
import { readJob, writeJob, type PostImgJob } from "../src/core/jobs.js";
import { monthlyTotals } from "../src/core/ledger.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

const LAT = 37.1682;
const LON = -118.5891;
const KEY = "idem-key-1";
const ORIGIN = "https://w.test";
const originalFetch = globalThis.fetch;

let env: Env;
let calls: Array<{ url: string; init?: RequestInit }>;

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
const NARRATIVE = {
  id: "c",
  choices: [
    {
      message: {
        role: "assistant",
        content: JSON.stringify({
          title: "Sabrina Sunset",
          haiku: "a\nb\nc",
          body: "Light fading.",
        }),
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
};

/** Route fetches; `replicateCreate` and `download` let a test choose failures. */
function routeFetch(opts: { replicateCreate?: () => Response; download?: () => Response } = {}) {
  calls = [];
  globalThis.fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init });
    if (u.includes("nominatim"))
      return json({ address: { locality: "Lake Sabrina", state: "California" } });
    if (u.includes("api.open-meteo.com"))
      return json({ current: { temperature_2m: 42, weather_code: 0 } });
    if (u.includes("/chat/completions")) return json(NARRATIVE);
    if (u.includes("api.replicate.com") && u.endsWith("/predictions")) {
      return opts.replicateCreate
        ? opts.replicateCreate()
        : json({ id: "pred-1", status: "starting" }, 201);
    }
    if (u.includes("replicate.delivery")) {
      return opts.download
        ? opts.download()
        : new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 200,
            headers: { "content-type": "image/webp" },
          });
    }
    if (u.includes("api.github.com/repos/") && u.includes("?ref="))
      return new Response("nf", { status: 404 });
    if (u.includes("api.github.com/repos/")) {
      return json({
        content: { sha: "s", path: "_posts/x.md", html_url: "x" },
        commit: { sha: "c" },
      });
    }
    if (u.includes("api.github.com/graphql")) {
      const q = (JSON.parse((init?.body as string) ?? "{}") as { query: string }).query;
      if (q.includes("createCommitOnBranch")) {
        return json({
          data: { createCommitOnBranch: { commit: { oid: "o", url: "https://github.com/x" } } },
        });
      }
      return json({ data: { repository: { ref: { target: { oid: "head" } } } } });
    }
    throw new Error(`unmatched fetch: ${u}`);
  }) as unknown as typeof fetch;
}

const ctx = (over: Partial<Parameters<typeof startPostImg>[1]> = {}) => ({
  env,
  imei: "123456789012345",
  lat: LAT,
  lon: LON,
  idemKey: KEY,
  timeStamp: 1700000000000,
  origin: ORIGIN,
  ...over,
});
const createCalls = () => calls.filter((c) => c.url.includes("api.replicate.com"));
const commits = () =>
  calls.filter(
    (c) => c.url.includes("graphql") && String(c.init?.body).includes("createCommitOnBranch"),
  );
const contentsPuts = () =>
  calls.filter((c) => c.url.includes("api.github.com/repos/") && c.init?.method === "PUT");

const JOB: PostImgJob = {
  kind: "postimg",
  imei: "123456789012345",
  createdAt: 1,
  predictionId: "pred-1",
  caption: "sunset",
  narrative: { title: "Sabrina Sunset", haiku: "a\nb\nc", body: "Light fading." },
  lat: LAT,
  lon: LON,
  placeName: "Lake Sabrina, California",
  weather: "42°F",
};

beforeEach(() => {
  env = makeTestEnv();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("startPostImg (#268)", () => {
  test("creates the prediction with the webhook, writes the job, defers, and publishes nothing", async () => {
    routeFetch();
    const r = await startPostImg({ type: "postimg", caption: "sunset" }, ctx());
    expect(r).toEqual({ deferred: true });

    const body = JSON.parse(createCalls()[0].init!.body as string);
    expect(body.webhook).toBe(`${ORIGIN}/replicate/callback?key=${KEY}`);
    expect(body.webhook_events_filter).toEqual(["completed"]);
    expect((createCalls()[0].init!.headers as Record<string, string>).Prefer).toBeUndefined();

    const job = await readJob(env, KEY);
    expect(job).toMatchObject({
      kind: "postimg",
      predictionId: "pred-1",
      imei: "123456789012345",
      caption: "sunset",
    });
    expect(job?.narrative.title).toBe("Sabrina Sunset");
    expect(commits()).toHaveLength(0);
    expect(contentsPuts()).toHaveLength(0);
    expect((await monthlyTotals(env)).by_command["postimg"].requests).toBe(1);
  });

  test("a failed create publishes text-only now with the fallback reply, and writes no job", async () => {
    routeFetch({ replicateCreate: () => new Response("upstream", { status: 502 }) });
    const r = await startPostImg({ type: "postimg", caption: "sunset" }, ctx());
    expect(r).toMatchObject({ body: "Posted: Sabrina Sunset (no image — retry !postimg)" });
    expect(contentsPuts()).toHaveLength(1);
    expect(await readJob(env, KEY)).toBeUndefined();
  });

  test("a failed job write publishes text-only now with the fallback reply", async () => {
    routeFetch();
    const realPut = env.TS_IDEMPOTENCY.put;
    vi.spyOn(env.TS_IDEMPOTENCY, "put").mockImplementation(async function (
      this: KVNamespace,
      key: string,
      value: string,
      opts?: KVNamespacePutOptions,
    ) {
      if (key.startsWith("job:")) throw new Error("KV 429");
      return realPut.call(this, key, value, opts);
    } as KVNamespace["put"]);
    const r = await startPostImg({ type: "postimg", caption: "sunset" }, ctx());
    expect(r).toMatchObject({ body: "Posted: Sabrina Sunset (no image — retry !postimg)" });
    expect(contentsPuts()).toHaveLength(1);
  });

  test("no origin falls back to text-only rather than creating an unreachable webhook", async () => {
    routeFetch();
    const r = await startPostImg(
      { type: "postimg", caption: "sunset" },
      ctx({ origin: undefined }),
    );
    expect(r).toMatchObject({ body: "Posted: Sabrina Sunset (no image — retry !postimg)" });
    expect(createCalls()).toHaveLength(0);
  });

  test("no GPS fix and no caption still refuses before any spend", async () => {
    routeFetch();
    const r = await startPostImg({ type: "postimg" }, ctx({ lat: undefined, lon: undefined }));
    expect(r).toEqual({ body: "Need GPS fix or a caption — try again outdoors." });
    expect(calls).toHaveLength(0);
  });
});

describe("finishPostImg (#268)", () => {
  beforeEach(async () => {
    await writeJob(env, KEY, JOB);
  });

  test("succeeded: one atomic commit with the image, image ledger, success body", async () => {
    routeFetch();
    const r = await finishPostImg({
      env,
      idemKey: KEY,
      job: JOB,
      prediction: {
        id: "pred-1",
        status: "succeeded",
        output: "https://replicate.delivery/a.webp",
      },
    });
    expect(r.body).toBe("Posted: Sabrina Sunset");
    expect(r.journalUrl).toMatch(/^https:\/\/brockamer\.github\.io\/trailscribe-journal\//);
    expect(commits()).toHaveLength(1);
    expect((await monthlyTotals(env)).image_requests).toBe(1);
  });

  test("Review Focus 3: failed, canceled and aborted each give text-only and the fallback body", async () => {
    for (const status of ["failed", "canceled", "aborted"]) {
      env = makeTestEnv();
      routeFetch();
      const r = await finishPostImg({
        env,
        idemKey: KEY,
        job: JOB,
        prediction: { id: "pred-1", status, error: "x" },
      });
      expect(r.body).toBe("Posted: Sabrina Sunset (no image — retry !postimg)");
      expect(contentsPuts()).toHaveLength(1);
      expect(commits()).toHaveLength(0);
    }
  });

  test("a failed download gives text-only and the fallback body", async () => {
    routeFetch({ download: () => new Response("gone", { status: 404 }) });
    const r = await finishPostImg({
      env,
      idemKey: KEY,
      job: JOB,
      prediction: {
        id: "pred-1",
        status: "succeeded",
        output: "https://replicate.delivery/a.webp",
      },
    });
    expect(r.body).toBe("Posted: Sabrina Sunset (no image — retry !postimg)");
  });

  test("running twice commits once and records the image once (checkpoints)", async () => {
    routeFetch();
    const p = { id: "pred-1", status: "succeeded", output: "https://replicate.delivery/a.webp" };
    await finishPostImg({ env, idemKey: KEY, job: JOB, prediction: p });
    await finishPostImg({ env, idemKey: KEY, job: JOB, prediction: p });
    expect(commits()).toHaveLength(1);
    expect((await monthlyTotals(env)).image_requests).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/postimg-async.test.ts`
Expected: FAIL — `startPostImg` / `finishPostImg` are not exported.

- [ ] **Step 3: Add the result types and the context field**

`src/core/types.ts`, after `CommandResult`:

```ts
/** Returned by a command that finishes later, from a provider callback (#268). */
export interface DeferredResult {
  deferred: true;
}

/** What `orchestrate` returns: a reply to send now, or a deferral. */
export type OrchestrateResult = CommandResult | DeferredResult;
```

`src/core/orchestrator.ts`: add to `OrchestratorContext`:

```ts
  /**
   * The Worker's public origin (scheme + host), taken from the incoming
   * request URL. `!postimg` builds its callback URL from it (#268).
   */
  origin?: string;
```

and add, below the interface:

```ts
/** True when a command deferred its reply to a provider callback (#268). */
export function isDeferred(r: OrchestrateResult): r is DeferredResult {
  return (r as DeferredResult).deferred === true;
}
```

with `import type { ParsedCommand, CommandResult, OrchestrateResult, DeferredResult } from "./types.js";` (keep `orchestrate` returning `Promise<CommandResult>` until Task 7).

- [ ] **Step 4: Write `startPostImg` and `finishPostImg`**

In `src/core/commands/postimg.ts`, add these imports:

```ts
import {
  createPrediction,
  fetchOutput,
  type ReplicatePrediction,
} from "../../adapters/ai/replicate.js";
import { writeJob, type PostImgJob } from "../jobs.js";
import type { Env } from "../../env.js";
import type { OrchestrateResult } from "../types.js";
```

and add below `handlePostImg` (which stays for now):

```ts
const FALLBACK_SUFFIX = " (no image — retry !postimg)";

/**
 * `!postimg` first half (#268, spec §5.1). Runs in the Garmin request:
 * refusals, enrichment, narrative, text ledger, then a prediction created with
 * a completion webhook and ONE job-record write. Returns `{ deferred: true }`
 * so the webhook answers Garmin without a reply; `finishPostImg` sends it.
 * Any failure before the job is safely recorded publishes text-only now, so
 * this request never ends in silence.
 */
export async function startPostImg(
  cmd: PostImgCommand,
  ctx: OrchestratorContext,
): Promise<OrchestrateResult> {
  const { env, imei, lat, lon, idemKey } = ctx;

  const hasCaption = cmd.caption !== undefined && cmd.caption.trim().length > 0;
  if (!hasCaption && (lat === undefined || lon === undefined)) {
    log({ event: "postimg_no_signal", level: "info", imei });
    return { body: "Need GPS fix or a caption — try again outdoors." };
  }

  const budget = await checkBudget(env, ESTIMATED_POST_TOKENS);
  if (!budget.allowed) {
    log({ event: "postimg_budget_rejected", level: "warn", imei, remaining: budget.remaining });
    return { body: BUDGET_REJECTION_MESSAGE };
  }

  let placeName: string | undefined;
  let weather: string | undefined;
  let civil: CivilTimeInfo | undefined;
  let weatherCode: number | undefined;
  if (lat !== undefined && lon !== undefined) {
    const [placeR, wxR] = await Promise.allSettled([
      reverseGeocode(lat, lon, env),
      currentWeatherDetail(lat, lon, env),
    ]);
    if (placeR.status === "fulfilled") placeName = placeR.value;
    if (wxR.status === "fulfilled") {
      weather = wxR.value.text;
      weatherCode = wxR.value.code;
      civil = wxR.value.civil;
    }
  }

  const localTime =
    ctx.timeStamp !== undefined && lon !== undefined
      ? localTimeOfDay(ctx.timeStamp, lon, civil)
      : undefined;

  let narrative: Awaited<ReturnType<typeof generateNarrative>>;
  try {
    narrative = await withCheckpoint(env, idemKey, "narrative", () =>
      generateNarrative({
        note: cmd.caption,
        lat,
        lon,
        placeName,
        weather,
        localTime: localTime?.text,
        isNight: localTime?.isNight,
        clockKnown: localTime?.clockKnown,
        env,
      }),
    );
  } catch (err) {
    return failPipeline(env, idemKey, "narrative", err, imei);
  }

  // Text ledger before anything that can fail (#213 reasoning).
  try {
    await withCheckpoint(env, idemKey, "ledger_text", async () => {
      await recordTransaction({ command: "postimg", usage: narrative.usage, env });
      return null;
    });
  } catch (err) {
    log({ event: "postimg_ledger_text_failed", level: "warn", imei, error: errMsg(err) });
  }

  const job: Omit<PostImgJob, "predictionId" | "createdAt"> = {
    kind: "postimg",
    imei,
    caption: cmd.caption,
    narrative: { title: narrative.title, haiku: narrative.haiku, body: narrative.body },
    lat,
    lon,
    placeName,
    weather,
  };
  const textOnly = () => publishTextOnly(env, idemKey, job);

  const narrativeSubject = hasCaption
    ? undefined
    : [narrative.title, narrative.body].filter((x) => x && x.trim().length > 0).join(": ");
  if (!hasCaption && (narrativeSubject ?? "").trim().length === 0) return textOnly();
  if (ctx.origin === undefined) {
    log({ event: "postimg_no_origin", level: "error", imei, key: idemKey });
    return textOnly();
  }

  const imagePrompt = buildImagePrompt({
    caption: cmd.caption,
    narrativeSubject,
    place: placeName,
    weatherCode,
    altitudeM: ctx.altitude,
    localTime: localTime?.text,
    isNight: localTime?.isNight,
  });

  let predictionId: string;
  try {
    const created = await createPrediction({
      prompt: imagePrompt,
      resolution: "2 MP",
      webhookUrl: `${ctx.origin}/replicate/callback?key=${encodeURIComponent(idemKey)}`,
      env,
    });
    predictionId = created.id;
  } catch (err) {
    log({
      event: "image_gen_failed",
      level: "error",
      imei,
      stage: "create",
      error: errMsg(err),
      providerResponse: err instanceof ImageGenError ? err.providerResponse : undefined,
    });
    return textOnly();
  }

  try {
    await writeJob(env, idemKey, { ...job, predictionId, createdAt: Date.now() });
  } catch (err) {
    // The prediction is paid for but its callback could not find the job.
    // Publish text-only now; the callback later sees a completed record.
    log({
      event: "postimg_job_write_failed",
      level: "error",
      imei,
      key: idemKey,
      predictionId,
      error: errMsg(err),
    });
    return textOnly();
  }

  log({ event: "postimg_deferred", level: "info", imei, key: idemKey, predictionId });
  return { deferred: true };
}

/**
 * `!postimg` second half (#268, spec §5.2). Runs in the Replicate callback:
 * download the image (or fall back to text-only), image ledger, one commit,
 * context append. Returns the reply body for `deliverCommandResult`.
 */
export async function finishPostImg(args: {
  env: Env;
  idemKey: string;
  job: PostImgJob;
  prediction: Pick<ReplicatePrediction, "id" | "status" | "output" | "error">;
}): Promise<CommandResult> {
  const { env, idemKey, job, prediction } = args;

  let image: Awaited<ReturnType<typeof fetchOutput>> | undefined;
  if (prediction.status === "succeeded") {
    try {
      image = await fetchOutput(prediction, env);
    } catch (err) {
      log({
        event: "image_gen_failed",
        level: "error",
        imei: job.imei,
        stage: "download",
        predictionId: prediction.id,
        error: errMsg(err),
      });
    }
  } else {
    log({
      event: "image_gen_failed",
      level: "error",
      imei: job.imei,
      stage: "render",
      predictionId: prediction.id,
      status: prediction.status,
      error: prediction.error ?? undefined,
    });
  }

  if (image === undefined) return publishTextOnly(env, idemKey, job);

  const paid = image;
  try {
    await withCheckpoint(env, idemKey, "ledger_image", async () => {
      await recordImageTransaction({ command: "postimg", usdCost: paid.costUsd, env });
      return null;
    });
  } catch (err) {
    log({
      event: "postimg_ledger_image_failed",
      level: "warn",
      imei: job.imei,
      error: errMsg(err),
    });
  }

  let published: { url: string };
  try {
    published = await withCheckpoint(env, idemKey, "publish", () =>
      publishPostWithImage({
        title: job.narrative.title,
        haiku: job.narrative.haiku,
        body: job.narrative.body,
        lat: job.lat,
        lon: job.lon,
        placeName: job.placeName,
        weather: job.weather,
        env,
        image: {
          bytes: paid.bytes,
          mimeType: paid.mimeType,
          pathTemplate: env.JOURNAL_IMAGE_PATH_TEMPLATE,
        },
      }),
    );
  } catch (err) {
    return failPipeline(env, idemKey, "publish", err, job.imei);
  }
  await appendPostImgContext(env, job);
  return { body: `Posted: ${job.narrative.title}`, journalUrl: published.url };
}

/** Text-only commit plus the fallback reply; shared by both halves. */
async function publishTextOnly(
  env: Env,
  idemKey: string,
  job: Omit<PostImgJob, "predictionId" | "createdAt">,
): Promise<CommandResult> {
  let published: { url: string };
  try {
    published = await withCheckpoint(env, idemKey, "publish", () =>
      publishPost({
        title: job.narrative.title,
        haiku: job.narrative.haiku,
        body: job.narrative.body,
        lat: job.lat,
        lon: job.lon,
        placeName: job.placeName,
        weather: job.weather,
        env,
      }),
    );
  } catch (err) {
    return failPipeline(env, idemKey, "publish", err, job.imei);
  }
  await appendPostImgContext(env, job);
  return { body: `Posted: ${job.narrative.title}${FALLBACK_SUFFIX}`, journalUrl: published.url };
}

async function appendPostImgContext(
  env: Env,
  job: Pick<PostImgJob, "imei" | "lat" | "lon" | "caption">,
): Promise<void> {
  try {
    await appendEvent(
      job.imei,
      {
        timestamp: Date.now(),
        lat: job.lat,
        lon: job.lon,
        command_type: "postimg",
        free_text: job.caption ?? "",
      },
      env,
    );
  } catch (err) {
    log({
      event: "postimg_context_append_failed",
      level: "warn",
      imei: job.imei,
      error: errMsg(err),
    });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

Note: `publishPostWithImage`'s `image.bytes` checkpoint result is not stored — only the `publish` op's return (`url`, `path`, `sha`) is checkpointed, as today.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/postimg-async.test.ts && pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS, and the existing suite unchanged (nothing calls the new functions yet).

- [ ] **Step 6: Commit**

```bash
pnpm format src/core/types.ts src/core/orchestrator.ts src/core/commands/postimg.ts tests/postimg-async.test.ts
git add src/core/types.ts src/core/orchestrator.ts src/core/commands/postimg.ts tests/postimg-async.test.ts
git commit -m "feat(postimg): startPostImg defers to a Replicate webhook; finishPostImg completes the post (#268)"
```

---

### Task 6: The callback route

**Files:**

- Create: `src/replicate-callback.ts`
- Create: `tests/helpers/exec-ctx.ts`
- Modify: `src/app.ts` (mount `POST /replicate/callback`)
- Test: `tests/replicate-callback.test.ts`

**Interfaces:**

- Consumes: `verifyReplicateWebhook` (Task 1); `isTerminalStatus`, `ReplicatePrediction` (Task 2); `readJob`, `markFinishStarted`, `finishInProgress`, `deleteJob` (Task 3); `deliverCommandResult` (Task 4); `finishPostImg` (Task 5); `readRecord`, `markFailed`.
- Produces:
  - `handleReplicateCallback(request: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">, opts?: { now?: () => number }): Promise<Response>`
  - Test helper `makeExecCtx(): { ctx: ExecutionContext; drain(): Promise<void>; count(): number }`

- [ ] **Step 1: Write the test helper**

`tests/helpers/exec-ctx.ts`:

```ts
/** Fake ExecutionContext that collects `waitUntil` promises so tests can await them. */
export function makeExecCtx(): {
  ctx: ExecutionContext;
  drain: () => Promise<void>;
  count: () => number;
} {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      tasks.push(p);
    },
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    drain: async () => {
      await Promise.all(tasks);
    },
    count: () => tasks.length,
  };
}
```

- [ ] **Step 2: Write the failing tests**

`tests/replicate-callback.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeApp } from "../src/app.js";
import { readJob, writeJob, type PostImgJob } from "../src/core/jobs.js";
import { readRecord, writeRecord } from "../src/core/idempotency.js";
import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";
import { makeTestEnv } from "./helpers/env.js";
import { makeExecCtx } from "./helpers/exec-ctx.js";
import { seedWebhookSecret, signReplicateBody } from "./helpers/replicate-signing.js";
import type { Env } from "../src/env.js";

vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", async (orig) => ({
  ...(await orig<typeof import("../src/adapters/outbound/garmin-ipc-inbound.js")>()),
  sendReply: vi.fn().mockResolvedValue({ count: 1 }),
}));
const sendReplyMock = vi.mocked(sendReply);

const KEY = "idem-key-1";
const originalFetch = globalThis.fetch;
let env: Env;
let app: ReturnType<typeof makeApp>;
let calls: string[];
let commitCount: number;
let contentsPutCount: number;

const JOB: PostImgJob = {
  kind: "postimg",
  imei: "123456789012345",
  createdAt: 1,
  predictionId: "pred-1",
  caption: "sunset",
  narrative: { title: "Sabrina Sunset", haiku: "a\nb\nc", body: "Light fading." },
  lat: 37.1682,
  lon: -118.5891,
  placeName: "Lake Sabrina, California",
  weather: "42°F",
};
const SUCCEEDED = {
  id: "pred-1",
  status: "succeeded",
  output: "https://replicate.delivery/a.webp",
};

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function routeFetch(opts: { contentsFails?: boolean } = {}) {
  calls = [];
  commitCount = 0;
  contentsPutCount = 0;
  globalThis.fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push(u);
    if (u.includes("replicate.delivery")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "image/webp" },
      });
    }
    if (u.includes("api.github.com/repos/") && u.includes("?ref="))
      return new Response("nf", { status: 404 });
    if (u.includes("api.github.com/repos/")) {
      contentsPutCount += 1;
      if (opts.contentsFails) return new Response("denied", { status: 403 });
      return json({
        content: { sha: "s", path: "_posts/x.md", html_url: "x" },
        commit: { sha: "c" },
      });
    }
    if (u.includes("api.github.com/graphql")) {
      const q = (JSON.parse((init?.body as string) ?? "{}") as { query: string }).query;
      if (q.includes("createCommitOnBranch")) {
        commitCount += 1;
        return json({
          data: { createCommitOnBranch: { commit: { oid: "o", url: "https://github.com/x" } } },
        });
      }
      return json({ data: { repository: { ref: { target: { oid: "head" } } } } });
    }
    throw new Error(`unmatched fetch: ${u}`);
  }) as unknown as typeof fetch;
}

async function callback(
  body: unknown,
  opts: { key?: string | null; headers?: Record<string, string> } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const key = opts.key === undefined ? KEY : opts.key;
  const path = key === null ? "/replicate/callback" : `/replicate/callback?key=${key}`;
  const exec = makeExecCtx();
  const res = await app.request(
    path,
    { method: "POST", headers: opts.headers ?? signReplicateBody(raw), body: raw },
    env,
    exec.ctx,
  );
  await exec.drain();
  return { res, exec };
}

beforeEach(async () => {
  env = makeTestEnv();
  app = makeApp();
  await seedWebhookSecret(env);
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue({ count: 1 });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  routeFetch();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function seedJob() {
  await writeRecord(env, KEY, { status: "processing", receivedAt: 1 });
  await writeJob(env, KEY, JOB);
}

describe("POST /replicate/callback — signature", () => {
  test("no signature headers → 401, no work", async () => {
    await seedJob();
    const { res, exec } = await callback(SUCCEEDED, {
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
    expect(exec.count()).toBe(0);
  });

  test("a bad signature → 401", async () => {
    await seedJob();
    const headers = signReplicateBody(JSON.stringify(SUCCEEDED));
    const { res } = await callback({ ...SUCCEEDED, status: "failed" }, { headers });
    expect(res.status).toBe(401);
  });

  test("secret unavailable → 503 so Replicate retries", async () => {
    await env.TS_CACHE.delete("replicate:webhook-secret");
    globalThis.fetch = vi.fn(
      async () => new Response("down", { status: 500 }),
    ) as unknown as typeof fetch;
    const { res } = await callback(SUCCEEDED);
    expect(res.status).toBe(503);
  });
});

describe("POST /replicate/callback — decisions (spec §8)", () => {
  test("no key → 200 ignored", async () => {
    const { res, exec } = await callback(SUCCEEDED, { key: null });
    expect(res.status).toBe(200);
    expect(exec.count()).toBe(0);
  });

  test("Review Focus 4: a signed non-JSON body → 200 ignored, not a 500", async () => {
    await seedJob();
    const { res, exec } = await callback("not json at all");
    expect(res.status).toBe(200);
    expect(exec.count()).toBe(0);
  });

  test("a non-terminal status → 200 ignored", async () => {
    await seedJob();
    const { res, exec } = await callback({ id: "pred-1", status: "processing" });
    expect(res.status).toBe(200);
    expect(exec.count()).toBe(0);
  });

  test("a completed or failed record → 200 duplicate, no work", async () => {
    for (const status of ["completed", "failed"] as const) {
      await writeRecord(env, KEY, { status, receivedAt: 1 });
      await writeJob(env, KEY, JOB);
      const { res, exec } = await callback(SUCCEEDED);
      expect(res.status).toBe(200);
      expect(exec.count()).toBe(0);
    }
    expect(sendReplyMock).not.toHaveBeenCalled();
  });

  test("no job record and the record not finished → 503 (KV may not show it yet)", async () => {
    await writeRecord(env, KEY, { status: "processing", receivedAt: 1 });
    const { res } = await callback(SUCCEEDED);
    expect(res.status).toBe(503);
  });

  test("Review Focus 1: a valid callback for another job's key → 200, no publish, no SMS", async () => {
    await seedJob();
    const { res, exec } = await callback({ ...SUCCEEDED, id: "pred-OTHER" });
    expect(res.status).toBe(200);
    expect(exec.count()).toBe(0);
    expect(commitCount).toBe(0);
    expect(sendReplyMock).not.toHaveBeenCalled();
  });

  test("a finish started under 2 minutes ago → 200 duplicate (concurrent delivery)", async () => {
    await writeRecord(env, KEY, { status: "processing", receivedAt: 1 });
    await writeJob(env, KEY, { ...JOB, finishStartedAt: Date.now() - 30_000 });
    const { res, exec } = await callback(SUCCEEDED);
    expect(res.status).toBe(200);
    expect(exec.count()).toBe(0);
  });
});

describe("POST /replicate/callback — finish", () => {
  test("succeeded: 200, one commit, the success SMS, record completed, job deleted", async () => {
    await seedJob();
    const { res, exec } = await callback(SUCCEEDED);
    expect(res.status).toBe(200);
    expect(exec.count()).toBe(1);
    expect(commitCount).toBe(1);
    const [imei, pages] = sendReplyMock.mock.calls[0];
    expect(imei).toBe("123456789012345");
    expect(pages[0]).toMatch(/^Posted: Sabrina Sunset\nhttps:\/\/\S+\.html \(live in ~1 min\)$/);
    expect((await readRecord(env, KEY))?.status).toBe("completed");
    expect(await readJob(env, KEY)).toBeUndefined();
  });

  test("the same callback twice → one commit, one SMS", async () => {
    await seedJob();
    await callback(SUCCEEDED);
    const second = await callback(SUCCEEDED);
    expect(second.res.status).toBe(200);
    expect(commitCount).toBe(1);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });

  test("failed render: text-only post and the fallback SMS", async () => {
    await seedJob();
    await callback({ id: "pred-1", status: "failed", error: "NSFW" });
    expect(contentsPutCount).toBe(1);
    expect(commitCount).toBe(0);
    expect(sendReplyMock.mock.calls[0][1][0]).toContain(
      "Posted: Sabrina Sunset (no image — retry !postimg)",
    );
  });

  test("publish failure: the error SMS is sent and the job is deleted", async () => {
    routeFetch({ contentsFails: true });
    await seedJob();
    await callback({ id: "pred-1", status: "failed" });
    expect(sendReplyMock.mock.calls[0][1][0]).toMatch(/^Error: /);
    expect(await readJob(env, KEY)).toBeUndefined();
  });

  test("Review Focus 5: a failed SMS send ends the record failed and deletes the job; a later duplicate stops with 200", async () => {
    await seedJob();
    sendReplyMock.mockRejectedValueOnce(new Error("IPC 503"));
    await callback(SUCCEEDED);
    expect((await readRecord(env, KEY))?.status).toBe("failed");
    expect(await readJob(env, KEY)).toBeUndefined();
    const again = await callback(SUCCEEDED);
    expect(again.res.status).toBe(200);
    expect(commitCount).toBe(1);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `pnpm vitest run tests/replicate-callback.test.ts`
Expected: FAIL — the route returns 404.

- [ ] **Step 4: Write the route logic**

`src/replicate-callback.ts`:

```ts
import type { Env } from "./env.js";
import { verifyReplicateWebhook } from "./adapters/ai/replicate-webhook.js";
import { isTerminalStatus, type ReplicatePrediction } from "./adapters/ai/replicate.js";
import { deleteJob, finishInProgress, markFinishStarted, readJob, type Job } from "./core/jobs.js";
import { markFailed, readRecord } from "./core/idempotency.js";
import { deliverCommandResult } from "./core/delivery.js";
import { finishPostImg } from "./core/commands/postimg.js";
import { log } from "./adapters/logging/worker-logs.js";

/**
 * `POST /replicate/callback?key=<idemKey>` (#268, spec §5.2 and §8).
 *
 * Replicate retries the terminal webhook on any 4xx/5xx for about a minute,
 * so the answer is the control: 503 = "try again" (state not visible yet),
 * 200 = "stop" (done, duplicate, or not ours), 401 = bad signature. The
 * finish runs after the 200, inside `waitUntil` (30 s), because Replicate
 * wants an answer within a few seconds and the finish takes about 6 s.
 */
export async function handleReplicateCallback(
  request: Request,
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  opts: { now?: () => number } = {},
): Promise<Response> {
  const now = opts.now ?? Date.now;
  const rawBody = await request.text();

  const verdict = await verifyReplicateWebhook(request.headers, rawBody, env, { now });
  if (!verdict.ok) {
    log({ event: "replicate_signature_failed", level: "warn", reason: verdict.reason });
    return verdict.reason === "secret_unavailable"
      ? new Response("retry", { status: 503 })
      : new Response("unauthorized", { status: 401 });
  }

  const key = new URL(request.url).searchParams.get("key");
  const prediction = parsePrediction(rawBody);
  log({
    event: "replicate_signature_ok",
    level: "info",
    key,
    predictionId: prediction?.id ?? null,
  });
  log({
    event: "replicate_callback",
    level: "info",
    key,
    predictionId: prediction?.id ?? null,
    status: prediction?.status ?? null,
    predictTime: prediction?.metrics?.predict_time ?? null,
    rawBodySample: rawBody.slice(0, 2048),
  });

  if (key === null || key.length === 0) return ignored("no_key", key);
  if (prediction === undefined) return ignored("bad_body", key);
  if (!isTerminalStatus(prediction.status)) return ignored("not_terminal", key);

  const record = await readRecord(env, key);
  if (record?.status === "completed" || record?.status === "failed") {
    log({ event: "replicate_callback_duplicate", level: "info", key, predictionId: prediction.id });
    return new Response("ok", { status: 200 });
  }

  const job = await readJob(env, key);
  if (job === undefined) {
    log({
      event: "replicate_callback_job_missing",
      level: "warn",
      key,
      predictionId: prediction.id,
    });
    return new Response("retry", { status: 503 });
  }
  if (job.predictionId !== prediction.id) return ignored("prediction_mismatch", key);
  if (finishInProgress(job, now())) {
    log({
      event: "replicate_callback_duplicate",
      level: "info",
      key,
      predictionId: prediction.id,
      concurrent: true,
    });
    return new Response("ok", { status: 200 });
  }

  await markFinishStarted(env, key, job, now());
  ctx.waitUntil(runFinish(env, key, job, prediction));
  return new Response("ok", { status: 200 });
}

/** Finish, reply, and leave the record terminal and the job deleted — always. */
async function runFinish(
  env: Env,
  key: string,
  job: Job,
  prediction: ReplicatePrediction,
): Promise<void> {
  const started = Date.now();
  try {
    const result = await finishPostImg({ env, idemKey: key, job, prediction });
    const sent = await deliverCommandResult(env, key, job.imei, result);
    if (!sent) await markFailed(env, key, "reply: IPC Inbound send failed");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "postimg_finish_error", level: "error", key, imei: job.imei, error: msg });
    await markFailed(env, key, `finish: ${msg}`);
  } finally {
    await deleteJob(env, key);
    log({
      event: "postimg_finish_ms",
      level: "info",
      key,
      imei: job.imei,
      ms: Date.now() - started,
    });
  }
}

function parsePrediction(raw: string): ReplicatePrediction | undefined {
  try {
    const p = JSON.parse(raw) as Partial<ReplicatePrediction>;
    if (p && typeof p.id === "string" && typeof p.status === "string")
      return p as ReplicatePrediction;
  } catch {
    // not JSON
  }
  return undefined;
}

function ignored(reason: string, key: string | null): Response {
  log({ event: "replicate_callback_ignored", level: "info", reason, key });
  return new Response("ok", { status: 200 });
}
```

In `src/app.ts`, add `import { handleReplicateCallback } from "./replicate-callback.js";` and, inside `makeApp()` after the `/garmin/ipc` route:

```ts
/**
 * Replicate completion callback (#268). Authenticated by Replicate's
 * signature, not by the Garmin token. An invalid env answers 503 so
 * Replicate retries rather than losing the job.
 */
app.post("/replicate/callback", async (c) => {
  const envCheck = checkEnv(c.env);
  if (!envCheck.ok) {
    logEnvInvalid("/replicate/callback", envCheck.problems);
    return c.text("env invalid", 503);
  }
  return handleReplicateCallback(c.req.raw, c.env, c.executionCtx);
});
```

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm vitest run tests/replicate-callback.test.ts && pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format src/replicate-callback.ts src/app.ts tests/replicate-callback.test.ts tests/helpers/exec-ctx.ts
git add src/replicate-callback.ts src/app.ts tests/replicate-callback.test.ts tests/helpers/exec-ctx.ts
git commit -m "feat(callback): POST /replicate/callback verifies, matches and finishes !postimg (#268)"
```

---

### Task 7: Wire `!postimg` to the async path and remove the old code

**Files:**

- Modify: `src/core/orchestrator.ts` (`case "postimg"` → `startPostImg`; return type)
- Modify: `src/app.ts` (`origin`, deferred handling, lease)
- Modify: `src/core/commands/postimg.ts` (delete `handlePostImg`, `IMAGE_POLL_BUDGET_MS`, the base64 helpers, unused imports)
- Modify: `src/adapters/ai/replicate.ts` (delete `generateImage`, `fetchPrediction`, `GenerateImageArgs`, `GenerateImageResult`, the poll constants)
- Modify: `src/core/idempotency.ts` (remove `"image"` from `OpName`)
- Delete: `src/core/image-pending.ts`, `tests/image-pending.test.ts`
- Modify: `tests/replicate.test.ts` (delete the `generateImage` describe blocks)
- Modify: `tests/p2-18-postimg.test.ts` (end-to-end through the callback)

**Interfaces:**

- Consumes: everything from Tasks 1–6.
- Produces: `orchestrate(command, ctx): Promise<OrchestrateResult>`; `handleEvent(incoming, env, allow, origin)`.

- [ ] **Step 1: Rewrite the end-to-end tests first**

In `tests/p2-18-postimg.test.ts`:

1. Add imports: `import { makeExecCtx } from "./helpers/exec-ctx.js";` and `import { seedWebhookSecret, signReplicateBody } from "./helpers/replicate-signing.js";`. In `beforeEach`, add `await seedWebhookSecret(env);` (make the callback `async`).
2. In every fetch router, change the Replicate create response from `{ id, status: "succeeded", output }` to `jsonResponse({ id: "<same id>", status: "starting" }, 201)`, and record the create body: `lastCreateBody = init?.body as string;` (declare `let lastCreateBody: string | undefined;` at module scope and reset it in `beforeEach`).
3. Add this helper below `postIpc`:

```ts
/** Play Replicate's completion callback for the last created prediction. */
async function completePrediction(
  id: string,
  status = "succeeded",
  output = "https://replicate.delivery/output/img-123.webp",
): Promise<Response> {
  const webhook = (JSON.parse(lastCreateBody ?? "{}") as { webhook: string }).webhook;
  const url = new URL(webhook);
  const raw = JSON.stringify({ id, status, output });
  const exec = makeExecCtx();
  const res = await app.request(
    `${url.pathname}${url.search}`,
    { method: "POST", headers: signReplicateBody(raw), body: raw },
    env,
    exec.ctx,
  );
  await exec.drain();
  return res;
}
```

4. Happy path test: after `await postIpc(...)`, assert `expect(sendReplyMock).not.toHaveBeenCalled();`, then `await completePrediction("pred_123");`, then keep every existing assertion (reply text, two additions in one commit, slugs, ledger).
5. Fallback test (create returns 502): unchanged — the SMS is sent from request 1.
6. Replace the whole `describe("P2-18 !postimg — idempotency replay", …)` block with:

```ts
describe("P2-18 !postimg — idempotency across re-delivery and duplicate callbacks", () => {
  let imagePredictions: number;
  let commitMutations: number;

  beforeEach(() => {
    imagePredictions = 0;
    commitMutations = 0;
    fetchSpy = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("nominatim")) {
        return jsonResponse({ address: { locality: "Lake Sabrina", state: "California" } });
      }
      if (u.includes("api.open-meteo.com")) {
        return jsonResponse({ current: { temperature_2m: 42, weather_code: 0 } });
      }
      if (u.includes("openrouter.ai") || u.includes("/chat/completions")) {
        return jsonResponse(narrativeResponse());
      }
      if (u.includes("api.replicate.com") && u.endsWith("predictions")) {
        imagePredictions += 1;
        lastCreateBody = init?.body as string;
        return jsonResponse({ id: `pred_${imagePredictions}`, status: "starting" }, 201);
      }
      if (u.includes("replicate.delivery/output")) return imageResponse();
      if (u.includes("api.github.com/repos/") && u.includes("?ref=")) {
        return new Response("not found", { status: 404 });
      }
      if (u.includes("api.github.com/graphql")) {
        const reqBody = JSON.parse((init?.body as string) ?? "{}") as { query: string };
        if (reqBody.query.includes("createCommitOnBranch")) {
          commitMutations += 1;
          return jsonResponse({
            data: {
              createCommitOnBranch: {
                commit: { oid: "abc", url: "https://github.com/x/y/commit/abc" },
              },
            },
          });
        }
        return jsonResponse({ data: { repository: { ref: { target: { oid: "headoid" } } } } });
      }
      throw new Error(`unmatched fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  });

  test("a Garmin re-delivery creates no second prediction; a duplicate callback no second post or SMS", async () => {
    const ev = envelope("!postimg replay test", { ts: 4242, gps: { lat: LAT, lon: LON } });
    await postIpc(ev);
    await postIpc(ev);
    expect(imagePredictions).toBe(1);
    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('"concurrent_replay_skipped"'))).toBe(true);

    await completePrediction("pred_1");
    await completePrediction("pred_1");
    expect(commitMutations).toBe(1);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    expect((await monthlyTotals(env)).image_requests).toBe(1);
  });

  test("Garmin is answered without a reply while the image renders", async () => {
    const res = await postIpc(envelope("!postimg quick answer", { gps: { lat: LAT, lon: LON } }));
    expect(res.status).toBe(200);
    expect(sendReplyMock).not.toHaveBeenCalled();
    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('"orchestrate_deferred"'))).toBe(true);
  });
});
```

7. "a caption still works with no GPS fix": after `postIpc`, add `await completePrediction("pred_x", "succeeded", "https://replicate.delivery/output/img-x.webp");` before the reply assertions.
8. The time-of-day tests read `seen.image` from the create body; no change beyond the create response status.

Run: `pnpm vitest run tests/p2-18-postimg.test.ts`
Expected: FAIL — request 1 still runs the old polling `handlePostImg` and sends the reply immediately.

- [ ] **Step 2: Switch the orchestrator**

`src/core/orchestrator.ts`: change the import to `import { startPostImg } from "./commands/postimg.js";`, the signature to `export async function orchestrate(command: ParsedCommand, ctx: OrchestratorContext): Promise<OrchestrateResult>`, and the case to `case "postimg": return startPostImg(command, ctx);`.

- [ ] **Step 3: Update `app.ts`**

1. In the `/garmin/ipc` route: `const origin = new URL(c.req.url).origin;` before the loop, and `await handleEvent(event, c.env, allow, origin);`.
2. `async function handleEvent(incoming: GarminEvent, env: Env, allow: Set<string>, origin: string): Promise<void> {`.
3. Replace the lease block (the comment "Concurrency lease (#235 review)…" and `if (await imageGenerationInFlight(env, key)) {`) with:

```ts
  // Lease (#268): a job record means a paid prediction is outstanding for
  // this event; a re-delivery must never buy a second one. See src/core/jobs.ts.
  if (await jobBlocksRedelivery(env, key)) {
```

keeping the `concurrent_replay_skipped` log and `return` inside. 4. Replace `import { imageGenerationInFlight } from "./core/image-pending.js";` with `import { jobBlocksRedelivery } from "./core/jobs.js";` and add `isDeferred` to the orchestrator import. 5. Pass `origin` in the `orchestrate(...)` context object, change `let result: CommandResult;` to `let result: OrchestrateResult;` (import the type), and after the `orchestrate_ok` log add:

```ts
if (isDeferred(result)) {
  // The reply comes from the provider callback (#268); no markCompleted here.
  log({ event: "orchestrate_deferred", level: "info", imei: event.imei, cmd: command.type, key });
  return;
}
```

- [ ] **Step 4: Delete the old code**

1. `src/core/commands/postimg.ts`: delete `handlePostImg`, `IMAGE_POLL_BUDGET_MS`, `arrayBufferToBase64`, `base64ToArrayBuffer`, and the imports of `generateImage`, `readPendingPrediction`, `writePendingPrediction`, `clearPendingPrediction`. Update the module JSDoc pipeline list to the two halves.
2. `src/adapters/ai/replicate.ts`: delete `generateImage`, `fetchPrediction`, `GenerateImageArgs`, `GenerateImageResult`, `DEFAULT_POLL_BUDGET_MS`, `POLL_INITIAL_MS`, `POLL_MAX_MS`, `POLL_BACKOFF`, and the long POLL-MODE JSDoc. Keep `ImageGenError` (its `timedOut` field may go: delete it and its constructor option if nothing references it).
3. `git rm src/core/image-pending.ts tests/image-pending.test.ts`.
4. `tests/replicate.test.ts`: delete the `generateImage — happy path`, `generateImage — failure paths`, `generateImage — poll-mode (#235)` describe blocks and `generateImage` from the import; keep the `ImageGenError — shape` block if it still compiles.
5. `src/core/idempotency.ts`: remove `| "image"` from `OpName`.

Run: `grep -rn "generateImage\|image-pending\|imageGenerationInFlight\|IMAGE_LEASE_MS\|imgpend" src tests`
Expected: no output.

- [ ] **Step 5: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
pnpm format src tests
git add -A src tests
git commit -m "feat(postimg): answer Garmin first and finish from the Replicate callback; retire polling and the 180 s lease (#268)"
```

---

### Task 8: Documentation

**Files:**

- Modify: `docs/PRD.md`
- Modify: `AGENTS.md`
- Modify: `docs/architecture.md`

No tests; the gate is `pnpm format:check` and a read-through against the spec.

- [ ] **Step 1: PRD**

1. The KV table row for `TS_IDEMPOTENCY` (line ~152): replace "in-flight image marker" with "job record for provider-callback completion (#268)" and `` `imgpend:<key>` `` with `` `job:<key>` ``. In the `TS_CACHE` row (or a sentence below the table, if the row does not list keys), add `` `replicate:webhook-secret` `` (Replicate signing secret, no TTL).
2. Wherever the PRD lists the Worker routes (search `/garmin/ipc`), add `POST /replicate/callback` — "Replicate completion callback; authenticated by Replicate's Standard-Webhooks signature, not by the Garmin token".
3. Add decision **D12** at the end of §8:

> **D12. Job completion by provider webhook (#268, 2026-10-13).** A command whose provider work outlasts Garmin's ~71 s re-delivery window answers Garmin first and finishes from the provider's signed completion callback. First user: `!postimg` (Replicate). The Garmin request writes one KV job record (`job:<key>` in `TS_IDEMPOTENCY`, 48 h) after the provider job exists; the callback route `POST /replicate/callback` verifies the signature, matches the prediction id, answers 200 and finishes inside `waitUntil`. No new secret: the signing secret is fetched with `IMAGE_API_KEY` and cached in `TS_CACHE`. A callback that never succeeds is logged and the operator resends; no sweep. No Durable Object, Queue or cron. Spec: `docs/superpowers/specs/2026-10-13-async-postimg-replicate-webhook-design.md`.

4. Update the `**Updated:**` header line at the top: prepend "2026-10-13 (§8 D12 added — job completion by provider webhook; `POST /replicate/callback`; KV `job:<key>` replaces `imgpend:<key>`, #268)." and move the current entry to "Previous:".

- [ ] **Step 2: AGENTS.md architecture tree**

In the `src/` tree: replace the `image-pending.ts` line with `jobs.ts                     # provider-callback job record (job:<key>); existence is the re-delivery lease (#268)`; add `delivery.ts                 # shared reply tail: buildReply + checkpointed send + markCompleted` under `core/`; add `replicate-callback.ts         # POST /replicate/callback: verify, match, finish !postimg (#268)` next to `app.ts`; add `ai/replicate-webhook.ts     # Replicate signature check + cached signing secret` and `outbound/deliver.ts         # deliver(): text pages now, media later (#285)` under `adapters/`. Update the `app.ts` comment to list `POST /replicate/callback`.

- [ ] **Step 3: docs/architecture.md**

Add a section "Async completion (`!postimg`, #268)" with the two-request sequence (copy the numbered lists of spec §5.1 and §5.2 in short form), the §8 answer table, and the §10 operator-visible table. Link the spec.

- [ ] **Step 4: Format and commit**

```bash
pnpm format docs/PRD.md AGENTS.md docs/architecture.md
pnpm format:check
git add docs/PRD.md AGENTS.md docs/architecture.md
git commit -m "docs: PRD D12, callback route and job record; architecture tree (#268)"
```

---

### Task 9: Staging check and the recorded fixture

**Run this task in the main session with the operator present — never in a subagent.** It reads `~/.secrets`, uses the operator's `gh` credentials to edit the journal repository, sends a real SMS to the operator's inReach, and may need a judgment call (Step 3). Under subagent-driven execution, the controller runs Task 9 itself after the Task 8 review.

Operator decisions already given: staging deploys are pre-approved; the staging test publishes to the public journal and sends a real SMS; the test post is deleted afterwards. Never print a secret: read secrets into variables and test with `${VAR:+set}`.

**Files:**

- Create: `tests/fixtures/replicate/callback-succeeded.json`
- Modify: `tests/replicate-callback.test.ts` (one test)

- [ ] **Step 1: Deploy to staging**

```bash
pnpm deploy:staging --dry-run && pnpm deploy:staging
STAGING_URL=$(grep '^STAGING_URL=' .env.replay | cut -d= -f2-)
curl -s "$STAGING_URL/health"
```

Expected: `"env_ok":true`.

- [ ] **Step 2: Send one `!postimg` to staging**

```bash
TOKEN=$(grep '^GARMIN_INBOUND_TOKEN=' .env.replay | cut -d= -f2-)
IMEI=<the operator's allowlisted device IMEI — confirm it with the operator; never commit it>
NOW=$(date +%s%3N)
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" -X POST "$STAGING_URL/garmin/ipc" \
  -H "content-type: application/json" -H "x-outbound-auth-token: $TOKEN" \
  -d "{\"Version\":\"4.0\",\"Events\":[{\"imei\":\"$IMEI\",\"messageCode\":3,\"freeText\":\"!postimg async callback test\",\"timeStamp\":$NOW,\"point\":{\"latitude\":37.168,\"longitude\":-118.589,\"altitude\":2800,\"gpsFix\":2}}]}"
```

The test fixtures carry the placeholder IMEI `123456789012345`, and `.env.replay` holds only `STAGING_URL` and `GARMIN_INBOUND_TOKEN` (`scripts/replay-test.sh` takes the real IMEI from a fixture the operator edits by hand). The IMEI must be the real device's and on staging's `IMEI_ALLOWLIST`; `imei_not_allowed` in the logs means the wrong value. Expected: `200` in under 15 s.

- [ ] **Step 3: Read the evidence from Workers Logs**

Wait 90 s (render plus the ~30 s ingestion lag), then query the observability API (service `trailscribe-staging`; recipe in memory `trailscribe-workers-logs-api`) for `source.event` in: `orchestrate_deferred`, `postimg_deferred`, `replicate_signature_ok`, `replicate_callback`, `postimg_finish_ms`, `reply_sent`, `replicate_signature_failed`, `replicate_callback_job_missing`. Record: the `/garmin/ipc` request `$workers.wallTimeMs`; the presence of `replicate_signature_ok` (this settles spec §4: the decoded key is right, and the query string survived because the callback found its job); `postimg_finish_ms`; the `reply_sent` text.

If `replicate_signature_failed` with `mismatch` appears instead: the key is used raw, not decoded. Stop, change `matches()` in `replicate-webhook.ts` to use `new TextEncoder().encode(secret.slice(6))`, replace the vector test with a raw-key note, and re-run from Step 1.

- [ ] **Step 4: Save the fixture**

Take `rawBodySample` from the `replicate_callback` line. If it is shorter than 2048 characters it is the full body: save it, pretty-printed, as `tests/fixtures/replicate/callback-succeeded.json`, replacing any personal content in `input.prompt` with neutral text. If it was cut at 2048, rebuild the body from the logged fields (`id`, `status`, `output`, `metrics.predict_time`) plus the documented prediction shape, and say so in the commit message.

- [ ] **Step 5: Test a duplicate against staging**

```bash
DEV_TOKEN=$(bash -c 'source ~/.secrets && printf %s "$REPLICATE_TRAILSCRIBE_DEV"')
SECRET=$(curl -s -H "Authorization: Bearer $DEV_TOKEN" https://api.replicate.com/v1/webhooks/default/secret | jq -r .key)
echo "secret ${SECRET:+set}"
```

Then, with `PRED_ID`, `PRED_OUTPUT` and `CB_KEY` set from the `replicate_callback` log line:

```bash
BODY="{\"id\":\"$PRED_ID\",\"status\":\"succeeded\",\"output\":\"$PRED_OUTPUT\"}"
HDRS=$(SECRET="$SECRET" BODY="$BODY" node -e '
const c = require("crypto");
const id = "msg_dup_" + Date.now(), ts = String(Math.floor(Date.now() / 1000));
const key = Buffer.from(process.env.SECRET.replace(/^whsec_/, ""), "base64");
const sig = c.createHmac("sha256", key).update(`${id}.${ts}.${process.env.BODY}`).digest("base64");
process.stdout.write(`webhook-id: ${id}\nwebhook-timestamp: ${ts}\nwebhook-signature: v1,${sig}`);')
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$STAGING_URL/replicate/callback?key=$CB_KEY" \
  -H "content-type: application/json" \
  -H "$(sed -n 1p <<<"$HDRS")" -H "$(sed -n 2p <<<"$HDRS")" -H "$(sed -n 3p <<<"$HDRS")" \
  -d "$BODY"
unset SECRET DEV_TOKEN
```

Confirm `200` and a `replicate_callback_duplicate` line, with no second `reply_sent` and no second journal commit. The signature header is printed into `$HDRS` only, never to the terminal. If `REPLICATE_TRAILSCRIBE_DEV` is not staging's `IMAGE_API_KEY` (the duplicate gets 401), skip this step and note it; the route test already covers duplicates.

- [ ] **Step 6: Delete the test post**

From the `reply_sent` text, take the journal URL; find the post and image paths in the journal repository named by staging's `GITHUB_JOURNAL_REPO` (ask the operator if it is not `brockamer/trailscribe-journal`). Clone it shallowly into the scratchpad, `git rm` both files, commit `chore: remove #268 staging test post`, and push (run `unset GH_TOKEN` first so the operator's own credentials are used).

- [ ] **Step 7: Add the recorded-fixture test**

Append to `tests/replicate-callback.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("POST /replicate/callback — recorded staging callback (#268)", () => {
  test("the real Replicate body, re-signed with the test secret, verifies and finishes", async () => {
    const recorded = JSON.parse(
      readFileSync(join(__dirname, "fixtures/replicate/callback-succeeded.json"), "utf8"),
    ) as { id: string; status: string; output: unknown };
    await writeRecord(env, KEY, { status: "processing", receivedAt: 1 });
    await writeJob(env, KEY, { ...JOB, predictionId: recorded.id });
    const { res } = await callback(recorded);
    expect(res.status).toBe(200);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    expect(commitCount + contentsPutCount).toBeGreaterThanOrEqual(1);
  });
});
```

(Move the two `node:` imports to the top of the file.) Run `pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`, then commit:

```bash
git add tests/fixtures/replicate/callback-succeeded.json tests/replicate-callback.test.ts
git commit -m "test(callback): recorded staging callback, re-signed with the test secret (#268)"
```

- [ ] **Step 7b: Post the evidence on #268**

A comment with: Garmin answer time, `postimg_finish_ms`, signature result (decoded key confirmed), query string preserved, duplicate result, test post deleted.

- [ ] **Step 8: Open PR 2 and stop for approval**

Push `feat/268-async-postimg`, open a PR titled `feat(postimg): answer Garmin first and finish from a Replicate webhook (#268)` with `Refs #268` (not `Closes`: the last criteria are device runs), the staging evidence, and the PRD D12 text for sign-off. Wait for CI green. **Ask the operator before merging**: the merge deploys production, and D12 needs their sign-off.

After merge: `curl` production `/health` (`env_ok: true`). The three device runs (spec §12.3) close #268 in a later session.
