import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
let errSpy: ReturnType<typeof vi.spyOn>;
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

/** Events that log() wrote to console.error (it sends warn and error there). */
function loggedEvents(): string[] {
  return errSpy.mock.calls.map((c) => (JSON.parse(String(c[0])) as { event: string }).event);
}

beforeEach(() => {
  env = makeTestEnv();
  // log() writes warn/error lines to console.error; keep the run output clean.
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errSpy.mockRestore();
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
    const noPred: Partial<PostImgJob> = { ...JOB };
    delete noPred.predictionId;
    await env.TS_IDEMPOTENCY.put(`job:${KEY}`, JSON.stringify(noPred));
    expect(await readJob(env, KEY)).toBeUndefined();
    expect(loggedEvents()).toEqual(["job_record_unreadable", "job_record_unreadable"]);
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
    expect((await readJob(env, KEY))?.finishStartedAt).toBe(5_000);
    expect(loggedEvents()).toEqual(["job_finish_mark_failed"]);
  });
});
