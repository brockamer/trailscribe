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
