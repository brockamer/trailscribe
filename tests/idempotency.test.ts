import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyRecordSchema,
  markCompleted,
  markFailed,
  readRecord,
  withCheckpoint,
  writeRecord,
} from "../src/core/idempotency.js";
import type { Env } from "../src/env.js";
import { kvSize, makeTestEnv } from "./helpers/env.js";

const KEY = "abc123";
const KV_KEY = `idem:${KEY}`;

let env: Env;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  env = makeTestEnv();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("readRecord — zod validation on read", () => {
  test("returns null when key is absent", async () => {
    expect(await readRecord(env, KEY)).toBeNull();
  });

  test("parses a valid record", async () => {
    await writeRecord(env, KEY, { status: "received", receivedAt: 1700000000 });
    const rec = await readRecord(env, KEY);
    expect(rec).toEqual({ status: "received", receivedAt: 1700000000 });
  });

  test("returns null and logs warn when stored shape is invalid", async () => {
    // Bypass writeRecord to plant a stale-shape record (status missing).
    await env.TS_IDEMPOTENCY.put(KV_KEY, JSON.stringify({ receivedAt: 1, foo: "bar" }));

    const rec = await readRecord(env, KEY);
    expect(rec).toBeNull();

    const warned = errSpy.mock.calls
      .map((c) => JSON.parse(String(c[0])) as { event: string })
      .some((e) => e.event === "idempotency_record_invalid");
    expect(warned).toBe(true);
  });
});

describe("writeRecord — TTL", () => {
  test("writes with the 48h expirationTtl", async () => {
    const putSpy = vi.spyOn(env.TS_IDEMPOTENCY, "put");
    await writeRecord(env, KEY, { status: "received", receivedAt: 1 });

    const opts = putSpy.mock.calls[0][2] as { expirationTtl?: number } | undefined;
    expect(opts?.expirationTtl).toBe(IDEMPOTENCY_TTL_SECONDS);
  });
});

describe("withCheckpoint — first-call vs replay", () => {
  test("first call invokes fn, stores result, appends to completedOps", async () => {
    const fn = vi.fn(async () => ({ url: "https://example.com/post/1" }));

    const result = await withCheckpoint(env, KEY, "publish", fn);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ url: "https://example.com/post/1" });

    const rec = await readRecord(env, KEY);
    expect(rec?.completedOps).toEqual(["publish"]);
    expect(rec?.opResults).toEqual({ publish: { url: "https://example.com/post/1" } });
    expect(rec?.status).toBe("processing");
  });

  test("replay returns cached result without invoking fn", async () => {
    const fn = vi.fn(async () => ({ url: "first" }));

    const first = await withCheckpoint(env, KEY, "publish", fn);
    expect(first).toEqual({ url: "first" });
    expect(fn).toHaveBeenCalledTimes(1);

    // A second call (replay) — fn should NOT be invoked again.
    const replayFn = vi.fn(async () => ({ url: "second" }));
    const replay = await withCheckpoint(env, KEY, "publish", replayFn);

    expect(replayFn).not.toHaveBeenCalled();
    expect(replay).toEqual({ url: "first" });

    // Only one entry in KV and only one completedOp.
    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(1);
    const rec = await readRecord(env, KEY);
    expect(rec?.completedOps).toEqual(["publish"]);
  });

  test("when fn throws, completedOps is NOT updated and the error propagates", async () => {
    const boom = new Error("OpenRouter 502");
    const fn = vi.fn(async () => {
      throw boom;
    });

    await expect(withCheckpoint(env, KEY, "narrative", fn)).rejects.toBe(boom);

    const rec = await readRecord(env, KEY);
    expect(rec?.completedOps ?? []).toEqual([]);
    expect(rec?.opResults ?? {}).toEqual({});
  });

  test("multiple ops accumulate independently in completedOps and opResults", async () => {
    await withCheckpoint(env, KEY, "narrative", async () => ({ title: "T", haiku: "H", body: "B" }));
    await withCheckpoint(env, KEY, "publish", async () => ({ url: "U" }));

    const rec = await readRecord(env, KEY);
    expect(rec?.completedOps).toEqual(["narrative", "publish"]);
    expect(rec?.opResults).toEqual({
      narrative: { title: "T", haiku: "H", body: "B" },
      publish: { url: "U" },
    });
  });

  test("non-JSON-serializable return value throws a clear error", async () => {
    // Map values become {} after JSON round-trip — flag at first call.
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(
      withCheckpoint(env, KEY, "narrative", async () => circular),
    ).rejects.toThrow(/non-JSON-serializable/);

    // Record was not corrupted by the failed op.
    const rec = await readRecord(env, KEY);
    expect(rec?.completedOps ?? []).toEqual([]);
  });

  test("fn returning undefined throws (use null for 'no result')", async () => {
    await expect(
      withCheckpoint(env, KEY, "reply", async () => undefined),
    ).rejects.toThrow(/undefined/);
  });

  test("preserves completedAt when called after markCompleted (idempotent terminal state)", async () => {
    // A completed record has terminal status — withCheckpoint on a new op
    // should not regress it back to "processing".
    await withCheckpoint(env, KEY, "narrative", async () => ({ ok: true }));
    await markCompleted(env, KEY);

    const before = await readRecord(env, KEY);
    expect(before?.status).toBe("completed");

    // A subsequent (rare, post-completion) checkpoint call must not flip status.
    await withCheckpoint(env, KEY, "publish", async () => ({ also: true }));
    const after = await readRecord(env, KEY);
    expect(after?.status).toBe("completed");
    expect(after?.completedOps).toEqual(["narrative", "publish"]);
  });
});

describe("withCheckpoint — JSON round-trip semantics", () => {
  test("Date returns survive as ISO strings (cached value matches what replay sees)", async () => {
    const fn = vi.fn(async () => ({ when: new Date("2026-04-25T00:00:00Z") }));
    const result = await withCheckpoint(env, KEY, "narrative", fn);

    // After round-trip, Date becomes a string. Caller code receiving the
    // first-call return gets the same shape replay would see.
    const when = (result as unknown as { when: unknown }).when;
    expect(typeof when).toBe("string");
    expect(when).toBe("2026-04-25T00:00:00.000Z");
  });
});

describe("markFailed", () => {
  test("sets status='failed', failedAt, error; preserves completedOps", async () => {
    await withCheckpoint(env, KEY, "narrative", async () => ({ ok: true }));
    await markFailed(env, KEY, "Resend 503");

    const rec = await readRecord(env, KEY);
    expect(rec?.status).toBe("failed");
    expect(typeof rec?.failedAt).toBe("number");
    expect(rec?.error).toBe("Resend 503");
    expect(rec?.completedOps).toEqual(["narrative"]);
  });

  test("safe to call when no record exists yet", async () => {
    await markFailed(env, KEY, "early-fail");
    const rec = await readRecord(env, KEY);
    expect(rec?.status).toBe("failed");
    expect(rec?.error).toBe("early-fail");
  });
});

describe("acceptance-criteria #8 — !post pipeline replay scenario", () => {
  test("succeeds at narrative + publish, fails at reply; replay re-runs only reply", async () => {
    const narrativeFn = vi.fn(async () => ({ title: "Lake basin", haiku: "...", body: "..." }));
    const publishFn = vi.fn(async () => ({ url: "https://blog/post/1" }));

    let replyAttempt = 0;
    const replyFn = vi.fn(async () => {
      replyAttempt += 1;
      if (replyAttempt === 1) throw new Error("Garmin 503");
      return { sentAt: 99 };
    });

    // Run 1 — narrative + publish succeed; reply throws.
    await withCheckpoint(env, KEY, "narrative", narrativeFn);
    await withCheckpoint(env, KEY, "publish", publishFn);
    await expect(withCheckpoint(env, KEY, "reply", replyFn)).rejects.toThrow(/Garmin 503/);

    expect(narrativeFn).toHaveBeenCalledTimes(1);
    expect(publishFn).toHaveBeenCalledTimes(1);
    expect(replyFn).toHaveBeenCalledTimes(1);

    let rec = await readRecord(env, KEY);
    expect(rec?.completedOps).toEqual(["narrative", "publish"]);

    // Run 2 (replay) — same key, same ops in same order.
    await withCheckpoint(env, KEY, "narrative", narrativeFn);
    await withCheckpoint(env, KEY, "publish", publishFn);
    await withCheckpoint(env, KEY, "reply", replyFn);

    // narrative + publish must NOT be re-invoked — total still 1 each.
    expect(narrativeFn).toHaveBeenCalledTimes(1);
    expect(publishFn).toHaveBeenCalledTimes(1);
    // reply was retried — total is now 2.
    expect(replyFn).toHaveBeenCalledTimes(2);

    rec = await readRecord(env, KEY);
    expect(rec?.completedOps).toEqual(["narrative", "publish", "reply"]);
    expect(rec?.opResults?.reply).toEqual({ sentAt: 99 });
  });
});

describe("IdempotencyRecordSchema — type safety smoke", () => {
  test("accepts a fully-populated record", () => {
    const ok = IdempotencyRecordSchema.safeParse({
      status: "completed",
      receivedAt: 1,
      completedAt: 2,
      completedOps: ["narrative", "publish", "reply"],
      opResults: { narrative: {}, publish: {}, reply: {} },
    });
    expect(ok.success).toBe(true);
  });

  test("rejects unknown status", () => {
    const bad = IdempotencyRecordSchema.safeParse({ status: "weird", receivedAt: 1 });
    expect(bad.success).toBe(false);
  });
});
