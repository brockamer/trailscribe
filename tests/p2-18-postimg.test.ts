/**
 * P2-18 — End-to-end integration tests for !postimg pipeline.
 *
 * The pipeline is split in two (#268): the Garmin request creates a Replicate
 * prediction and answers without a reply; the signed Replicate callback
 * finishes the post and sends it. `completePrediction()` plays that callback.
 *
 * Asserts:
 *   - Happy path: enrich → narrative → create prediction → (callback) image
 *     download → atomic GraphQL commit → reply with journal URL. Single
 *     GraphQL mutation includes both the markdown post and the image binary.
 *   - Image-gen failure: a failed create falls back to a text-only Contents
 *     API commit in the Garmin request; reply notes the fallback; no image
 *     ledger entry.
 *   - Re-delivery and duplicates: a Garmin re-delivery creates no second
 *     prediction; a duplicate callback commits once, sends one SMS and records
 *     one image ledger entry.
 *   - !cost breakout: with image_usd_cost > 0, the !cost reply formats both
 *     axes.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeApp } from "../src/app.js";
import { kvKeys, makeTestEnv } from "./helpers/env.js";
import { makeExecCtx } from "./helpers/exec-ctx.js";
import { seedWebhookSecret, signReplicateBody } from "./helpers/replicate-signing.js";
import type { Env } from "../src/env.js";
import { monthlyTotals, recordTransaction, recordImageTransaction } from "../src/core/ledger.js";
import { BUDGET_REJECTION_MESSAGE } from "../src/core/budget.js";

import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";

vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", () => ({
  sendReply: vi.fn().mockResolvedValue({ count: 1 }),
}));

const sendReplyMock = vi.mocked(sendReply);

let app: ReturnType<typeof makeApp>;
let env: Env;
let fetchSpy: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
/** Body of the most recent Replicate create call; carries the webhook URL (#268). */
let lastCreateBody: string | undefined;

const LAT = 37.1682;
const LON = -118.5891;

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function imageResponse(): Response {
  // Tiny 1x1 PNG-ish bytes.
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return new Response(bytes, {
    status: 200,
    headers: { "content-type": "image/webp" },
  });
}

function narrativeResponse() {
  return {
    id: "chatcmpl-test",
    choices: [
      {
        message: {
          role: "assistant",
          content: JSON.stringify({
            title: "Sabrina Sunset",
            haiku: "alpenglow on stone\nthin air, an unspoken vow\ngranite holds the night",
            body: "Light fading on the eastern Sierra. Camp set, water filtered.",
          }),
        },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 80, total_tokens: 180 },
  };
}

function envelope(
  freeText: string,
  opts: { ts?: number; gps?: { lat: number; lon: number } } = {},
) {
  const point = opts.gps
    ? { latitude: opts.gps.lat, longitude: opts.gps.lon, altitude: 1000, gpsFix: 2 }
    : { latitude: 0, longitude: 0, altitude: 0, gpsFix: 0 };
  return {
    Version: "2.0",
    Events: [
      {
        imei: "123456789012345",
        messageCode: 3,
        freeText,
        timeStamp: opts.ts ?? 1700000000000,
        point,
      },
    ],
  };
}

async function postIpc(body: unknown): Promise<Response> {
  return app.request(
    "/garmin/ipc",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-outbound-auth-token": env.GARMIN_INBOUND_TOKEN,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

/** Every structured log line written so far (console.log and console.error), parsed. */
function loggedLines(): Array<Record<string, unknown>> {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map(
    (c) => JSON.parse(String(c[0])) as Record<string, unknown>,
  );
}

/** The idempotency key the webhook URL of the last create call carries. */
function webhookKey(): string | null {
  const webhook = (JSON.parse(lastCreateBody ?? "{}") as { webhook: string }).webhook;
  return new URL(webhook).searchParams.get("key");
}

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

beforeEach(async () => {
  lastCreateBody = undefined;
  app = makeApp();
  env = makeTestEnv({
    LLM_INPUT_COST_PER_1K: "0.003",
    LLM_OUTPUT_COST_PER_1K: "0.015",
  });
  await seedWebhookSecret(env);
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue({ count: 1 });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("P2-18 !postimg — happy path", () => {
  test("atomic GraphQL commit: markdown + image in a single mutation", async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    fetchSpy = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      fetchCalls.push({ url: u, init });
      if (u.includes("nominatim")) {
        return jsonResponse({ address: { locality: "Lake Sabrina", state: "California" } });
      }
      if (u.includes("api.open-meteo.com")) {
        return jsonResponse({
          current: { temperature_2m: 42, wind_speed_10m: 8, weather_code: 0 },
        });
      }
      if (u.includes("openrouter.ai") || u.includes("/chat/completions")) {
        return jsonResponse(narrativeResponse());
      }
      if (u.includes("api.replicate.com") && u.endsWith("predictions")) {
        lastCreateBody = init?.body as string;
        return jsonResponse({ id: "pred_123", status: "starting" }, 201);
      }
      if (u.includes("replicate.delivery/output")) {
        return imageResponse();
      }
      // findFreePath probes Contents API for slug collision; 404 = free.
      if (u.includes("api.github.com/repos/") && u.includes("?ref=")) {
        return new Response("not found", { status: 404 });
      }
      if (u.includes("api.github.com/graphql")) {
        // Body distinguishes the branch-oid query from the createCommit mutation.
        const reqBody = JSON.parse((init?.body as string) ?? "{}") as {
          query: string;
          variables?: unknown;
        };
        if (reqBody.query.includes("createCommitOnBranch")) {
          return jsonResponse({
            data: {
              createCommitOnBranch: {
                commit: { oid: "abc123commit", url: "https://github.com/x/y/commit/abc" },
              },
            },
          });
        }
        return jsonResponse({
          data: { repository: { ref: { target: { oid: "deadbeefoid" } } } },
        });
      }
      throw new Error(`unmatched fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!postimg sunset at sabrina", { gps: { lat: LAT, lon: LON } }));
    // Garmin is answered first; the reply comes from the Replicate callback.
    expect(sendReplyMock).not.toHaveBeenCalled();
    await completePrediction("pred_123");

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toMatch(/^Posted: Sabrina Sunset\nhttps:\/\/\S+\.html \(live in ~1 min\)$/);
    expect(messages[0]).not.toContain("image gen failed");

    // The createCommit mutation carries TWO additions in a single request.
    const commitCall = fetchCalls.find(
      (c) =>
        c.url.includes("api.github.com/graphql") &&
        typeof c.init?.body === "string" &&
        c.init.body.includes("createCommitOnBranch"),
    );
    expect(commitCall).toBeDefined();
    const commitBody = JSON.parse(commitCall!.init!.body as string) as {
      variables: { input: { fileChanges: { additions: Array<{ path: string }> } } };
    };
    const additions = commitBody.variables.input.fileChanges.additions;
    expect(additions).toHaveLength(2);
    const paths = additions.map((a) => a.path);
    expect(paths.some((p) => p.startsWith("_posts/") && p.endsWith(".md"))).toBe(true);
    expect(paths.some((p) => p.startsWith("assets/images/") && p.endsWith(".webp"))).toBe(true);
    // Markdown and image share the same slug + date — atomic-commit guarantee.
    const mdPath = paths.find((p) => p.endsWith(".md"))!;
    const imgPath = paths.find((p) => p.endsWith(".webp"))!;
    const slugFromMd = mdPath.replace(/^_posts\//, "").replace(/\.md$/, "");
    const slugFromImg = imgPath.replace(/^assets\/images\//, "").replace(/\.webp$/, "");
    expect(slugFromMd).toBe(slugFromImg);

    // Ledger captured both axes.
    const snap = await monthlyTotals(env);
    expect(snap.by_command["postimg"].requests).toBe(1);
    expect(snap.image_requests).toBe(1);
    expect(snap.image_usd_cost).toBeCloseTo(0.003, 5);
  });

  test("lost-callback markers: postimg_deferred and postimg_finish_ms carry the same idempotency key", async () => {
    globalThis.fetch = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("nominatim")) {
        return jsonResponse({ address: { locality: "Lake Sabrina", state: "California" } });
      }
      if (u.includes("api.open-meteo.com")) {
        return jsonResponse({ current: { temperature_2m: 42, weather_code: 0 } });
      }
      if (u.includes("/chat/completions")) return jsonResponse(narrativeResponse());
      if (u.includes("api.replicate.com") && u.endsWith("predictions")) {
        lastCreateBody = init?.body as string;
        return jsonResponse({ id: "pred_123", status: "starting" }, 201);
      }
      if (u.includes("replicate.delivery/output")) return imageResponse();
      if (u.includes("api.github.com/repos/") && u.includes("?ref=")) {
        return new Response("not found", { status: 404 });
      }
      if (u.includes("api.github.com/graphql")) {
        const q = (JSON.parse((init?.body as string) ?? "{}") as { query: string }).query;
        return q.includes("createCommitOnBranch")
          ? jsonResponse({
              data: { createCommitOnBranch: { commit: { oid: "o", url: "https://github.com/x" } } },
            })
          : jsonResponse({ data: { repository: { ref: { target: { oid: "head" } } } } });
      }
      throw new Error(`unmatched fetch: ${u}`);
    }) as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!postimg markers", { gps: { lat: LAT, lon: LON } }));
    await completePrediction("pred_123");

    // The key in the webhook URL is the idempotency key: its `idem:` record exists.
    const key = webhookKey();
    expect(key).toBeTruthy();
    expect(kvKeys(env.TS_IDEMPOTENCY)).toContain(`idem:${key}`);

    const lines = loggedLines();
    expect(lines.find((l) => l.event === "postimg_deferred")).toMatchObject({
      key,
      predictionId: "pred_123",
    });
    expect(lines.find((l) => l.event === "postimg_finish_ms")).toMatchObject({ key });
  });
});

describe("P2-18 !postimg — budget gate (spec §12.1)", () => {
  test("daily token budget exhausted: the refusal, no Replicate create, no job record", async () => {
    env.DAILY_TOKEN_BUDGET = "100";
    const today = new Date().toISOString().slice(0, 10);
    await env.TS_LEDGER.put(
      `ledger:${today}`,
      JSON.stringify({
        period: today,
        requests: 1,
        prompt_tokens: 9999,
        completion_tokens: 0,
        usd_cost: 0,
        by_command: {},
        last_update_ms: 0,
      }),
    );
    fetchSpy = vi.fn(async (url: URL | RequestInfo) => {
      throw new Error(`no network call expected, got: ${String(url)}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!postimg anything", { gps: { lat: LAT, lon: LON } }));

    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    expect(sendReplyMock.mock.calls[0][1][0]).toBe(BUDGET_REJECTION_MESSAGE);
    expect(fetchSpy).not.toHaveBeenCalled(); // so no Replicate create either
    expect(kvKeys(env.TS_IDEMPOTENCY).filter((k) => k.startsWith("job:"))).toEqual([]);
    expect((await monthlyTotals(env)).image_requests ?? 0).toBe(0);
  });
});

describe("P2-18 !postimg — image-gen failure fallback", () => {
  test("falls back to text-only Contents API commit; reply notes the fallback", async () => {
    fetchSpy = vi.fn(async (url: URL | RequestInfo) => {
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
        return new Response("upstream timeout", { status: 502 });
      }
      // Contents API path (text-only fallback).
      if (u.includes("api.github.com/repos/")) {
        if (u.includes("?ref=")) {
          return new Response("not found", { status: 404 }); // findFreePath
        }
        return jsonResponse({
          content: { sha: "fileSha", path: "_posts/x.md", html_url: "x" },
          commit: { sha: "commitSha" },
        });
      }
      throw new Error(`unmatched fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!postimg fallback test", { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    // #235: the old wording ("image gen failed; text-only") reported a failure
    // without telling the operator what to do about it, from a device with no
    // other feedback channel.
    expect(messages[0]).toContain("no image — retry !postimg");

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    // No GraphQL mutation in the fallback path.
    expect(calls.some((u) => u.includes("api.github.com/graphql"))).toBe(false);

    const snap = await monthlyTotals(env);
    expect(snap.image_requests ?? 0).toBe(0);
  });
});

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
      // findFreePath probes Contents API for slug collision; 404 = free.
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

    expect((await completePrediction("pred_1")).status).toBe(200);
    expect((await completePrediction("pred_1")).status).toBe(200);
    expect(commitMutations).toBe(1);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    expect((await monthlyTotals(env)).image_requests).toBe(1);
  });

  test("the lease holds at any age (spec §9): a back-dated job still skips a re-delivery with no second create", async () => {
    const ev = envelope("!postimg old job", { ts: 4343, gps: { lat: LAT, lon: LON } });
    await postIpc(ev);
    expect(imagePredictions).toBe(1);

    // Back-date the job a day: far older than the retired 180 s window.
    const jobKey = kvKeys(env.TS_IDEMPOTENCY).find((k) => k.startsWith("job:"))!;
    const job = JSON.parse((await env.TS_IDEMPOTENCY.get(jobKey))!) as { createdAt: number };
    job.createdAt = Date.now() - 24 * 3600 * 1000;
    await env.TS_IDEMPOTENCY.put(jobKey, JSON.stringify(job));

    logSpy.mockClear();
    await postIpc(ev);
    expect(imagePredictions).toBe(1);
    const skipped = loggedLines().filter((l) => l.event === "concurrent_replay_skipped");
    expect(skipped).toHaveLength(1);
    expect(jobKey).toBe(`job:${skipped[0].key}`);
  });

  test("Garmin is answered without a reply while the image renders", async () => {
    const res = await postIpc(envelope("!postimg quick answer", { gps: { lat: LAT, lon: LON } }));
    expect(res.status).toBe(200);
    expect(sendReplyMock).not.toHaveBeenCalled();
    const logs = logSpy.mock.calls.map((c) => String(c[0]));
    expect(logs.some((l) => l.includes('"orchestrate_deferred"'))).toBe(true);
  });
});

describe("P2-18 — !cost breakout", () => {
  test("image entries present → !cost reply includes image axis", async () => {
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
      env: makeTestEnv({
        ...env,
        LLM_INPUT_COST_PER_1K: "0.10",
        LLM_OUTPUT_COST_PER_1K: "0.30",
      }),
    });
    Object.assign(env, { LLM_INPUT_COST_PER_1K: "0.10", LLM_OUTPUT_COST_PER_1K: "0.30" });
    await recordImageTransaction({ command: "postimg", usdCost: 0.03, env });

    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch for !cost");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!cost"));

    const [, messages] = sendReplyMock.mock.calls[0];
    // Two-line render (#173): summary then per-command breakdown.
    const [summary, breakdown] = messages[0].split("\n");
    expect(summary).toMatch(
      /^1 req · 1\.5k tok · \$0\.25 \+ \$0\.03 img \(since \d{4}-\d{2}-01\)$/,
    );
    // recordImageTransaction doesn't touch by_command, so only the post entry
    // appears in the breakdown.
    expect(breakdown).toBe("post $0.25");
  });

  test("no image entries → !cost reply preserves Phase 1 format", async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch for !cost");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!cost"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toMatch(/^0 req · 0\.0k tok · \$0\.00 \(since \d{4}-\d{2}-01\)$/);
  });
});

describe("P2-18 !postimg — bare, no caption (#150)", () => {
  test("no GPS fix and no caption: refuses before any LLM or image spend", async () => {
    // The guard exists because a bare !postimg without a fix has no signal at
    // all — nothing to describe and nothing to ground a scene in. At ~$0.10 an
    // image, refusing beats buying a picture of nothing.
    fetchSpy = vi.fn(async (url: URL | RequestInfo) => {
      throw new Error(`no network call expected, got: ${String(url)}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!postimg"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toContain("Need GPS fix or a caption");
    expect(fetchSpy).not.toHaveBeenCalled();

    // Nothing billed.
    const snap = await monthlyTotals(env);
    expect(snap.by_command["postimg"]?.requests ?? 0).toBe(0);
    expect(snap.image_requests ?? 0).toBe(0);
  });

  test("a caption still works with no GPS fix — the caption carries it", async () => {
    fetchSpy = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("openrouter.ai") || u.includes("/chat/completions")) {
        return jsonResponse(narrativeResponse());
      }
      if (u.includes("api.replicate.com") && u.endsWith("predictions")) {
        lastCreateBody = init?.body as string;
        return jsonResponse({ id: "pred_x", status: "starting" }, 201);
      }
      if (u.includes("replicate.delivery/output")) return imageResponse();
      if (u.includes("api.github.com/graphql")) {
        const reqBody = JSON.parse((init?.body as string) ?? "{}") as { query: string };
        if (reqBody.query.includes("createCommitOnBranch")) {
          return jsonResponse({
            data: {
              createCommitOnBranch: {
                commit: { oid: "abc123commit", url: "https://github.com/x/y/commit/abc" },
              },
            },
          });
        }
        return jsonResponse({
          data: { repository: { ref: { target: { oid: "deadbeefoid" } } } },
        });
      }
      if (u.includes("api.github.com/repos")) {
        // GET = "does this path already exist?" -> 404 (new post). PUT = create.
        const method = (init?.method ?? "GET").toUpperCase();
        return method === "GET"
          ? jsonResponse({ message: "Not Found" }, 404)
          : jsonResponse({ content: { html_url: "https://example.test/post" } }, 201);
      }
      throw new Error(`unmatched fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!postimg fog over the ridge"));
    await completePrediction("pred_x", "succeeded", "https://replicate.delivery/output/img-x.webp");

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).not.toContain("Need GPS fix");
    expect(messages[0]).toMatch(/^Posted: /);
  });
});

const MALIBU_PDT = JSON.parse(
  readFileSync(join(__dirname, "fixtures/open-meteo/malibu-pdt-2026-10-02.json"), "utf8"),
) as unknown;

describe("P2-18 !postimg — narrative and image share one time of day (#240)", () => {
  async function runBarePostimg(
    weatherBody: unknown,
    gps: { lat: number; lon: number },
    ts: number,
  ): Promise<{ narrativeUser: string; image: string }> {
    const seen: { narrative?: string; image?: string } = {};
    fetchSpy = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("nominatim")) {
        return jsonResponse({ address: { locality: "Malibu", state: "California" } });
      }
      if (u.includes("api.open-meteo.com")) {
        return jsonResponse(weatherBody);
      }
      if (u.includes("openrouter.ai") || u.includes("/chat/completions")) {
        seen.narrative = init?.body as string;
        return jsonResponse(narrativeResponse());
      }
      if (u.includes("api.replicate.com") && u.endsWith("predictions")) {
        seen.image = init?.body as string;
        lastCreateBody = seen.image;
        return jsonResponse({ id: "pred_t", status: "starting" }, 201);
      }
      if (u.includes("replicate.delivery/output")) return imageResponse();
      if (u.includes("api.github.com/repos/") && u.includes("?ref=")) {
        return new Response("not found", { status: 404 });
      }
      if (u.includes("api.github.com/graphql")) {
        const reqBody = JSON.parse((init?.body as string) ?? "{}") as { query: string };
        if (reqBody.query.includes("createCommitOnBranch")) {
          return jsonResponse({
            data: {
              createCommitOnBranch: {
                commit: { oid: "abc123commit", url: "https://github.com/x/y/commit/abc" },
              },
            },
          });
        }
        return jsonResponse({
          data: { repository: { ref: { target: { oid: "deadbeefoid" } } } },
        });
      }
      throw new Error(`unmatched fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!postimg", { gps, ts }));

    expect(seen.narrative).toBeDefined();
    expect(seen.image).toBeDefined();
    const narrativeUser =
      (
        JSON.parse(seen.narrative!) as { messages: Array<{ role: string; content: string }> }
      ).messages.find((m) => m.role === "user")?.content ?? "";
    return { narrativeUser, image: seen.image! };
  }

  test("the 2026-10-02 Malibu case: both prompts carry the device's civil clock time (#274)", async () => {
    // Device timeStamp 1790936886000 = 10:28:06Z = 03:28 PDT. Mean solar time said 02:33.
    const { narrativeUser, image } = await runBarePostimg(
      MALIBU_PDT,
      { lat: 34.026, lon: -118.76 },
      1790936886000,
    );
    expect(narrativeUser).toMatch(/^Local time: 03:28 — night$/m);
    expect(image).toContain("Local time: 03:28 — night;");
  });

  test("no UTC offset from the weather call: both prompts get the period only, no clock time (#274)", async () => {
    // 05:17Z at 120°W is 21:17 mean solar time — night.
    const { narrativeUser, image } = await runBarePostimg(
      { current: { temperature_2m: 19, wind_speed_10m: 6, weather_code: 0 } },
      { lat: 34.03, lon: -120 },
      Date.UTC(2026, 8, 16, 5, 17),
    );
    expect(narrativeUser).toMatch(/^Local time: night \(clock time unknown/m);
    expect(narrativeUser).not.toMatch(/\d{2}:\d{2}/);
    expect(image).toContain("Local time: night;");
  });
});
