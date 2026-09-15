import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import {
  readPendingPrediction,
  writePendingPrediction,
  clearPendingPrediction,
  imageGenerationInFlight,
  IMAGE_LEASE_MS,
} from "../src/core/image-pending.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;

beforeEach(() => {
  env = makeTestEnv();
});

afterEach(() => {
  vi.useRealTimers();
});

const KEY = "abc123";

describe("pending-prediction marker — resume (#235)", () => {
  test("round-trips the prediction id and poll URL", async () => {
    await writePendingPrediction(env, KEY, {
      predictionId: "pred-1",
      getUrl: "https://api.replicate.com/v1/predictions/pred-1",
    });

    const got = await readPendingPrediction(env, KEY);
    expect(got?.predictionId).toBe("pred-1");
    expect(got?.getUrl).toBe("https://api.replicate.com/v1/predictions/pred-1");
    expect(typeof got?.startedAt).toBe("number");
  });

  test("absent key reads as undefined, not a throw", async () => {
    expect(await readPendingPrediction(env, "never-written")).toBeUndefined();
  });

  test("clearing removes it", async () => {
    await writePendingPrediction(env, KEY, { predictionId: "p", getUrl: "https://x/p" });
    await clearPendingPrediction(env, KEY);
    expect(await readPendingPrediction(env, KEY)).toBeUndefined();
  });

  test("a corrupt marker is ignored rather than failing the command", async () => {
    await env.TS_IDEMPOTENCY.put(`imgpend:${KEY}`, "{not json");
    expect(await readPendingPrediction(env, KEY)).toBeUndefined();
  });

  test("a marker missing required fields is ignored", async () => {
    await env.TS_IDEMPOTENCY.put(`imgpend:${KEY}`, JSON.stringify({ predictionId: "p" }));
    expect(await readPendingPrediction(env, KEY)).toBeUndefined();
  });

  test("stored under the full 48h idempotency TTL, not a shorter one", async () => {
    // A marker that expires before the idempotency record it belongs to would
    // let a late Garmin retry (the 12h tier) buy a second image.
    const putSpy = vi.spyOn(env.TS_IDEMPOTENCY, "put");
    await writePendingPrediction(env, KEY, { predictionId: "p", getUrl: "https://x/p" });
    const opts = putSpy.mock.calls[0][2] as { expirationTtl?: number };
    expect(opts.expirationTtl).toBe(60 * 60 * 48);
  });
});

describe("concurrency lease — imageGenerationInFlight (#235 review)", () => {
  test("false when no generation was ever started", async () => {
    expect(await imageGenerationInFlight(env, KEY)).toBe(false);
  });

  test("true immediately after a generation starts — this is what blocks the Garmin retry", async () => {
    await writePendingPrediction(env, KEY, { predictionId: "p", getUrl: "https://x/p" });
    expect(await imageGenerationInFlight(env, KEY)).toBe(true);
  });

  test("false once the lease has aged out, so a genuinely dead invocation is retried", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:00:00Z"));
    await writePendingPrediction(env, KEY, { predictionId: "p", getUrl: "https://x/p" });
    expect(await imageGenerationInFlight(env, KEY)).toBe(true);

    vi.setSystemTime(new Date(Date.now() + IMAGE_LEASE_MS + 1_000));
    expect(await imageGenerationInFlight(env, KEY)).toBe(false);
  });

  test("the lease outlives the image poll budget — otherwise a retry could still race a live poll", async () => {
    // postimg's IMAGE_POLL_BUDGET_MS is 150s; the lease must exceed it.
    expect(IMAGE_LEASE_MS).toBeGreaterThan(150_000);
  });

  test("a cleared marker ends the lease at once", async () => {
    await writePendingPrediction(env, KEY, { predictionId: "p", getUrl: "https://x/p" });
    await clearPendingPrediction(env, KEY);
    expect(await imageGenerationInFlight(env, KEY)).toBe(false);
  });

  test("a legacy marker with no startedAt is treated as expired, never as a permanent lease", async () => {
    await env.TS_IDEMPOTENCY.put(
      `imgpend:${KEY}`,
      JSON.stringify({ predictionId: "p", getUrl: "https://x/p" }),
    );
    expect(await imageGenerationInFlight(env, KEY)).toBe(false);
  });
});
