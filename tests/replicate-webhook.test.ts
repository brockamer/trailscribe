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
let errSpy: ReturnType<typeof vi.spyOn>;

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
  // log() writes warn/error lines to console.error; capture them too.
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
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

  test("F2: a zero-length key (secret is exactly whsec_) returns mismatch and does not throw", async () => {
    await seedWebhookSecret(env, "whsec_", atVec());
    const r = await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: atVec });
    expect(r).toEqual({ ok: false, reason: "mismatch" });
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
    // A failed fetch is the path that logs; run it so the assertion below sees a warn line.
    const failing = vi.fn(async () => new Response("boom", { status: 500 }));
    await verifyReplicateWebhook(vecHeaders(), VEC_BODY, makeTestEnv(), {
      now: atVec,
      fetchImpl: failing,
    });
    expect(errSpy).toHaveBeenCalled();
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0])).join("\n");
    expect(logged).not.toContain(TEST_WEBHOOK_SECRET.slice(6));
    expect(logged).not.toContain(VEC_SIG.slice(3));
  });

  test("F1: a malformed 200 from the secret endpoint gives secret_unavailable and logs no secret fragment", async () => {
    // V8's JSON.parse error quotes the input it choked on; the fragment must not reach the log.
    const fragment = TEST_WEBHOOK_SECRET.slice(6, 12);
    const fetchImpl = vi.fn(
      async () => new Response('{"key":' + TEST_WEBHOOK_SECRET.slice(0, 12) + "}", { status: 200 }),
    );
    const r = await verifyReplicateWebhook(vecHeaders(), VEC_BODY, env, { now: atVec, fetchImpl });
    expect(r).toEqual({ ok: false, reason: "secret_unavailable" });
    // The failure is logged (the spy sees a line) but without the response body.
    expect(errSpy).toHaveBeenCalled();
    const logged = [...logSpy.mock.calls, ...errSpy.mock.calls].map((c) => String(c[0])).join("\n");
    expect(logged).toContain("replicate_secret_fetch_failed");
    expect(logged).not.toContain(fragment);
  });

  test("the test signer agrees with the production verifier", async () => {
    await seedWebhookSecret(env);
    const body = '{"id":"p1","status":"succeeded"}';
    const headers = new Headers(signReplicateBody(body));
    expect(await verifyReplicateWebhook(headers, body, env)).toEqual({ ok: true });
  });
});
