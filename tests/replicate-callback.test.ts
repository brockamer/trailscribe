import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from "vitest";
import { makeApp } from "../src/app.js";
import { readJob, writeJob, type PostImgJob } from "../src/core/jobs.js";
import { readRecord, writeRecord } from "../src/core/idempotency.js";
import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";
import { makeTestEnv } from "./helpers/env.js";
import { makeExecCtx } from "./helpers/exec-ctx.js";
import {
  seedWebhookSecret,
  signReplicateBody,
  TEST_WEBHOOK_SECRET,
} from "./helpers/replicate-signing.js";
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
let logSpy: MockInstance<(...args: unknown[]) => void>;
let errSpy: MockInstance<(...args: unknown[]) => void>;

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
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  routeFetch();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Every structured log line written so far (console.log and console.error), parsed. */
function loggedLines(): Array<Record<string, unknown>> {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map(
    (c) => JSON.parse(String(c[0])) as Record<string, unknown>,
  );
}

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

  test("a malformed env → 503 so Replicate retries, env_invalid logged, nothing runs", async () => {
    env = makeTestEnv({ IMEI_ALLOWLIST: "12345678901234" });
    await seedWebhookSecret(env);
    await seedJob();
    const { res, exec } = await callback(SUCCEEDED);
    expect(res.status).toBe(503);
    expect(exec.count()).toBe(0);
    expect(sendReplyMock).not.toHaveBeenCalled();
    expect(await readJob(env, KEY)).toBeDefined();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain('"env_invalid"');
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

  test.each([
    ["an empty object", "{}"],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["no status", JSON.stringify({ id: "pred-1" })],
    ["no id", JSON.stringify({ status: "succeeded" })],
    ["a non-string id", JSON.stringify({ id: 7, status: "succeeded" })],
  ])("Review Focus 4: a signed body with %s → 200 ignored, not a 500", async (_name, raw) => {
    await seedJob();
    const { res, exec } = await callback(raw);
    expect(res.status).toBe(200);
    expect(exec.count()).toBe(0);
    expect(sendReplyMock).not.toHaveBeenCalled();
    expect(await readJob(env, KEY)).toBeDefined();
  });

  test("an empty key parameter → 200 ignored", async () => {
    await seedJob();
    const { res, exec } = await callback(SUCCEEDED, { key: "" });
    expect(res.status).toBe(200);
    expect(exec.count()).toBe(0);
  });

  test("a non-terminal status → 200 ignored", async () => {
    await seedJob();
    const { res, exec } = await callback({ id: "pred-1", status: "processing" });
    expect(res.status).toBe(200);
    expect(exec.count()).toBe(0);
  });

  /** The `replicate_callback_ignored` line for one reason. */
  const ignoredLine = (reason: string) =>
    loggedLines().find((l) => l.event === "replicate_callback_ignored" && l.reason === reason);

  test("ignored log level: no_key and bad_body (a broken contract) are warn", async () => {
    await seedJob();
    await callback(SUCCEEDED, { key: null });
    await callback("not json at all");
    expect(ignoredLine("no_key")).toMatchObject({ level: "warn" });
    expect(ignoredLine("bad_body")).toMatchObject({ level: "warn", key: KEY });
  });

  test("ignored log level: not_terminal and prediction_mismatch stay info", async () => {
    await seedJob();
    await callback({ id: "pred-1", status: "processing" });
    await callback({ ...SUCCEEDED, id: "pred-OTHER" });
    expect(ignoredLine("not_terminal")).toMatchObject({ level: "info" });
    expect(ignoredLine("prediction_mismatch")).toMatchObject({ level: "info" });
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
    // The log shows both ids, so an operator can tell which prediction the
    // job holds and which one the callback carried.
    const ignored = loggedLines().find(
      (l) => l.event === "replicate_callback_ignored" && l.reason === "prediction_mismatch",
    );
    expect(ignored).toMatchObject({
      key: KEY,
      predictionId: "pred-OTHER",
      jobPredictionId: "pred-1",
    });
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
  // Replicate retries only after a non-2xx answer, and our answer to the
  // first delivery was 200, so this path is reached only by a rare duplicate
  // delivery of the same webhook. A finish that started over 2 minutes ago is
  // treated as cancelled (the 30 s waitUntil window is long past), so that
  // delivery finishes the job instead of being dropped as a concurrent one.
  test("a finish started over 2 minutes ago is treated as lost: a duplicate delivery finishes it", async () => {
    await writeRecord(env, KEY, { status: "processing", receivedAt: 1 });
    await writeJob(env, KEY, { ...JOB, finishStartedAt: Date.now() - 180_000 });
    const { res, exec } = await callback(SUCCEEDED);
    expect(res.status).toBe(200);
    expect(exec.count()).toBe(1);
    expect(commitCount).toBe(1);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });

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
    // No second finish: no waitUntil, no second SMS attempt. commitCount alone
    // cannot show this, because the publish checkpoint is cached.
    expect(again.exec.count()).toBe(0);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    expect(commitCount).toBe(1);
  });

  test("F1: a KV write outage during the finish: the catch-path markFailed fails too, yet the waitUntil promise resolves, the job is deleted and a warn is logged", async () => {
    await seedJob();
    // Every write to an `idem:` key rejects, as in a KV write outage that
    // starts after the callback marked the finish started (the `job:` write
    // before it succeeded). Two real failures follow from that one outage:
    //  1. in finishPostImg the publish checkpoint's record write rejects, so
    //     failPipeline calls markFailed, whose write rejects: the finish throws;
    //  2. runFinish's catch calls markFailed, whose write rejects again.
    const realPut = env.TS_IDEMPOTENCY.put.bind(env.TS_IDEMPOTENCY);
    const putSpy = vi
      .spyOn(env.TS_IDEMPOTENCY, "put")
      .mockImplementation(async (...args: Parameters<KVNamespace["put"]>) => {
        if (args[0].startsWith("idem:")) throw new Error("KV PUT 503");
        return realPut(...args);
      });

    // callback() awaits the drained waitUntil promises, so a rejection there
    // fails this test at this line.
    const { res, exec } = await callback(SUCCEEDED);

    expect(res.status).toBe(200);
    expect(exec.count()).toBe(1);
    expect(putSpy.mock.calls.filter(([k]) => String(k).startsWith("idem:")).length).toBeGreaterThan(
      1,
    );
    expect(await readJob(env, KEY)).toBeUndefined();
    const lines = loggedLines();
    expect(lines.find((l) => l.event === "postimg_finish_error")).toMatchObject({
      level: "error",
      key: KEY,
    });
    expect(lines.find((l) => l.event === "postimg_finish_mark_failed_error")).toMatchObject({
      level: "warn",
      key: KEY,
      error: "KV PUT 503",
    });
    expect(lines.find((l) => l.event === "postimg_finish_ms")).toMatchObject({ key: KEY });
  });
});

describe("POST /replicate/callback — logging", () => {
  test("F4: a full successful callback never logs the signature or the signing secret", async () => {
    await seedJob();
    const raw = JSON.stringify(SUCCEEDED);
    const headers = signReplicateBody(raw);
    const signature = headers["webhook-signature"].replace(/^v1,/, "");
    expect(signature.length).toBeGreaterThan(20);

    const { res } = await callback(SUCCEEDED, { headers });
    expect(res.status).toBe(200);

    // Guard against a vacuous pass: the route did log, and the finish ran.
    const events = loggedLines().map((l) => l.event);
    expect(events).toContain("replicate_signature_ok");
    expect(events).toContain("postimg_finish_ms");

    const everything = [...logSpy.mock.calls, ...errSpy.mock.calls]
      .map((c) => c.map(String).join(" "))
      .join("\n");
    expect(everything).not.toContain(signature);
    expect(everything).not.toContain(headers["webhook-signature"]);
    expect(everything).not.toContain(TEST_WEBHOOK_SECRET);
    expect(everything).not.toContain(TEST_WEBHOOK_SECRET.replace(/^whsec_/, ""));
  });
});

describe("POST /replicate/callback — recorded staging callback (#268)", () => {
  test("the real Replicate body shape, re-signed with the test secret, verifies and finishes once", async () => {
    // Recorded on staging 2026-10-14; see the fixture's _comment for what is real.
    const recorded = JSON.parse(
      readFileSync(join(__dirname, "fixtures/replicate/callback-succeeded.json"), "utf8"),
    ) as { id: string; status: string; output: string };
    await writeRecord(env, KEY, { status: "processing", receivedAt: 1 });
    await writeJob(env, KEY, { ...JOB, predictionId: recorded.id });

    const { res, exec } = await callback(recorded);

    expect(res.status).toBe(200);
    expect(exec.count()).toBe(1);
    expect(commitCount).toBe(1);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    expect((await readRecord(env, KEY))?.status).toBe("completed");
    expect(await readJob(env, KEY)).toBeUndefined();
  });
});
