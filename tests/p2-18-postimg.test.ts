/**
 * P2-18 — End-to-end integration tests for !postimg pipeline.
 *
 * Asserts:
 *   - Happy path: enrich → narrative → image-gen → atomic GraphQL commit →
 *     reply with journal URL. Single GraphQL mutation includes both the
 *     markdown post and the image binary.
 *   - Image-gen failure: falls back to text-only Contents API commit; reply
 *     notes the fallback; no image ledger entry.
 *   - Replay: image-gen called once across two webhook retries; commit happens
 *     once; ledger image entry recorded once.
 *   - !cost breakout: with image_usd_cost > 0, the !cost reply formats both
 *     axes.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeApp } from "../src/app.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";
import { monthlyTotals, recordTransaction, recordImageTransaction } from "../src/core/ledger.js";

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

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv({
    LLM_INPUT_COST_PER_1K: "0.003",
    LLM_OUTPUT_COST_PER_1K: "0.015",
  });
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
        return jsonResponse({
          id: "pred_123",
          status: "succeeded",
          output: "https://replicate.delivery/output/img-123.webp",
        });
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

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toMatch(/^Posted: Sabrina Sunset · /);
    expect(messages[0]).not.toContain("image gen failed");

    // The createCommit mutation carries TWO additions in a single request.
    const commitCall = fetchCalls.find(
      (c) => c.url.includes("api.github.com/graphql") &&
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
    expect(paths.some((p) => p.startsWith("_images/") && p.endsWith(".webp"))).toBe(true);
    // Markdown and image share the same slug + date — atomic-commit guarantee.
    const mdPath = paths.find((p) => p.endsWith(".md"))!;
    const imgPath = paths.find((p) => p.endsWith(".webp"))!;
    const slugFromMd = mdPath.replace(/^_posts\//, "").replace(/\.md$/, "");
    const slugFromImg = imgPath.replace(/^_images\//, "").replace(/\.webp$/, "");
    expect(slugFromMd).toBe(slugFromImg);

    // Ledger captured both axes.
    const snap = await monthlyTotals(env);
    expect(snap.by_command["postimg"].requests).toBe(1);
    expect(snap.image_requests).toBe(1);
    expect(snap.image_usd_cost).toBeCloseTo(0.003, 5);
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
    expect(messages[0]).toContain("image gen failed; text-only");

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    // No GraphQL mutation in the fallback path.
    expect(calls.some((u) => u.includes("api.github.com/graphql"))).toBe(false);

    const snap = await monthlyTotals(env);
    expect(snap.image_requests ?? 0).toBe(0);
  });
});

describe("P2-18 !postimg — idempotency replay", () => {
  test("image-gen and commit each run exactly once across two retries", async () => {
    let imagePredictions = 0;
    let commitMutations = 0;
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
        return jsonResponse({
          id: `pred_${imagePredictions}`,
          status: "succeeded",
          output: "https://replicate.delivery/output/img.webp",
        });
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

    const ev = envelope("!postimg replay test", { ts: 4242, gps: { lat: LAT, lon: LON } });
    await postIpc(ev);
    await postIpc(ev);

    expect(imagePredictions).toBe(1);
    expect(commitMutations).toBe(1);

    const snap = await monthlyTotals(env);
    expect(snap.image_requests).toBe(1);
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
    expect(messages[0]).toMatch(
      /^1 req · 1\.5k tok · \$0\.25 \+ \$0\.03 img \(since \d{4}-\d{2}-01\)$/,
    );
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
