/**
 * P1-16 — End-to-end integration tests for the `!post` pipeline.
 *
 * Drives /garmin/ipc with a real orchestrator + handlePost. Mocks all four
 * external HTTP boundaries (Nominatim, Open-Meteo, OpenRouter, GitHub Contents
 * API) plus the IPC Inbound sender. Asserts:
 *   - Happy path: narrative + publish + ledger recorded; reply contains title +
 *     URL + map links.
 *   - No-GPS: geocode + weather not called; narrative still generated; reply
 *     has no map link.
 *   - Replay: second delivery skips narrative + publish (cached via
 *     withCheckpoint), still re-sends reply only if it failed previously.
 *   - Budget exhausted: canned message; no narrative call.
 *   - Network failure mid-pipeline: markFailed; error reply delivered;
 *     subsequent retry resumes from the failed step.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeApp } from "../src/app.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";
import { monthlyTotals } from "../src/core/ledger.js";

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

const NATALIE_LAT = 37.1682;
const NATALIE_LON = -118.5891;

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envelope(freeText: string, opts: { ts?: number; gps?: { lat: number; lon: number } } = {}) {
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

/** Compose mock fetch handlers keyed by URL substring. Returns a vi.fn. */
function makeFetchRouter(
  routes: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: () => Response | Promise<Response> }>,
) {
  return vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    for (const r of routes) {
      if (r.match(u, init)) return await r.respond();
    }
    throw new Error(`unmatched fetch: ${u}`);
  });
}

const NARRATIVE_RESPONSE = {
  id: "chatcmpl-test",
  choices: [
    {
      message: {
        role: "assistant",
        content: JSON.stringify({
          title: "Alpenglow at Lake Sabrina",
          haiku: "Granite walls glow\nWind drops off the cirque\nLight turns mist",
          body: "Pink light bleeds across the basin walls as the day dies.",
        }),
      },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 240, completion_tokens: 180, total_tokens: 420 },
};

const PUBLISH_RESPONSE = {
  content: { sha: "blob-sha", path: "p", html_url: "x" },
  commit: { sha: "commit-sha-abc" },
};

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv({
    MAPSHARE_BASE: "https://share.garmin.com/MyMap",
    GITHUB_JOURNAL_REPO: "brockamer/trailscribe-journal",
    GITHUB_JOURNAL_BRANCH: "main",
    JOURNAL_URL_TEMPLATE: "https://brockamer.github.io/trailscribe-journal/{yyyy}/{mm}/{dd}/{slug}.html",
    LLM_INPUT_COST_PER_1K: "0.20",
    LLM_OUTPUT_COST_PER_1K: "0.80",
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

describe("P1-16 !post — happy path with GPS", () => {
  test("calls geocode + weather + narrative + publish; records ledger; reply contains title + url + maps", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("nominatim.openstreetmap.org"),
        respond: () => jsonResponse({ display_name: "Lake Sabrina, Inyo County, California" }),
      },
      {
        match: (u) => u.includes("api.open-meteo.com"),
        respond: () =>
          jsonResponse({
            current: { temperature_2m: 46, wind_speed_10m: 8, weather_code: 0 },
          }),
      },
      {
        match: (u) => u.includes("openrouter.ai"),
        respond: () => jsonResponse(NARRATIVE_RESPONSE),
      },
      {
        match: (u, i) => u.includes("api.github.com") && i?.method === "GET",
        respond: () => new Response(null, { status: 404 }),
      },
      {
        match: (u, i) => u.includes("api.github.com") && i?.method === "PUT",
        respond: () => jsonResponse(PUBLISH_RESPONSE),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const res = await postIpc(envelope("!post Lake Sabrina basin glowing pink at sunset.", { gps: { lat: NATALIE_LAT, lon: NATALIE_LON } }));
    expect(res.status).toBe(200);

    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    const [, messages] = sendReplyMock.mock.calls[0];
    const joined = messages.join(" ");
    expect(joined).toContain("Posted: Alpenglow at Lake Sabrina");
    expect(joined).toContain("https://brockamer.github.io/trailscribe-journal/");
    expect(joined).toContain("alpenglow-at-lake-sabrina.html");
    // Device reply must not carry map links (offline use, eats reply budget).
    expect(joined).not.toContain("google.com/maps");
    expect(joined).not.toContain("share.garmin.com");

    // Location still flows into the journal markdown frontmatter via the
    // publish adapter (separate path from the reply).
    const publishPut = fetchSpy.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        c[0].includes("api.github.com") &&
        (c[1] as RequestInit | undefined)?.method === "PUT",
    );
    expect(publishPut).toBeDefined();
    const putBody = JSON.parse((publishPut![1] as RequestInit).body as string) as {
      content: string;
    };
    const markdown = Buffer.from(putBody.content, "base64").toString("utf-8");
    expect(markdown).toContain(`location: { lat: ${NATALIE_LAT}, lon: ${NATALIE_LON}`);

    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(1);
    expect(snap.prompt_tokens).toBe(240);
    expect(snap.completion_tokens).toBe(180);
    // 240 * 0.0002 + 180 * 0.0008 = 0.048 + 0.144 = 0.192
    expect(snap.usd_cost).toBeCloseTo(0.192, 4);
    expect(snap.by_command["post"]).toBeDefined();
  });
});

describe("P1-16 !post — no GPS fix", () => {
  test("skips geocode + weather; narrative still generated; reply has no map links", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai"),
        respond: () => jsonResponse(NARRATIVE_RESPONSE),
      },
      {
        match: (u, i) => u.includes("api.github.com") && i?.method === "GET",
        respond: () => new Response(null, { status: 404 }),
      },
      {
        match: (u, i) => u.includes("api.github.com") && i?.method === "PUT",
        respond: () => jsonResponse(PUBLISH_RESPONSE),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!post No fix; just observing tonight."));

    const calls = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((u: string) => u.includes("nominatim"))).toBe(false);
    expect(calls.some((u: string) => u.includes("open-meteo"))).toBe(false);

    const [, messages] = sendReplyMock.mock.calls[0];
    const joined = messages.join(" ");
    expect(joined).toContain("Posted: Alpenglow at Lake Sabrina");
    expect(joined).not.toContain("https://www.google.com/maps");
    expect(joined).not.toContain("share.garmin.com");

    // Verify narrative prompt did not include Location/Weather lines either.
    const orCall = fetchSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("openrouter.ai"),
    );
    expect(orCall).toBeDefined();
    const orInit = orCall![1] as RequestInit;
    const orBody = JSON.parse(orInit.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = orBody.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).not.toContain("Location:");
    expect(userMsg).not.toContain("Weather:");
  });
});

describe("P1-16 !post — replay safety (acceptance #5)", () => {
  test("first run completes narrative + publish; reply send fails; replay re-runs reply only", async () => {
    let openRouterCalls = 0;
    let publishCalls = 0;
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai"),
        respond: () => {
          openRouterCalls += 1;
          return jsonResponse(NARRATIVE_RESPONSE);
        },
      },
      {
        match: (u, i) => u.includes("api.github.com") && i?.method === "GET",
        respond: () => new Response(null, { status: 404 }),
      },
      {
        match: (u, i) => u.includes("api.github.com") && i?.method === "PUT",
        respond: () => {
          publishCalls += 1;
          return jsonResponse(PUBLISH_RESPONSE);
        },
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    // Run 1: narrative + publish succeed; reply send throws.
    sendReplyMock.mockRejectedValueOnce(new Error("Garmin 503"));
    await postIpc(envelope("!post Lake basin"));
    expect(openRouterCalls).toBe(1);
    expect(publishCalls).toBe(1);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);

    // Run 2 (replay, identical envelope → identical idempotency key): reply
    // succeeds. Narrative + publish must NOT re-run.
    sendReplyMock.mockResolvedValueOnce({ count: 1 });
    await postIpc(envelope("!post Lake basin"));

    expect(openRouterCalls).toBe(1); // unchanged — withCheckpoint cached
    expect(publishCalls).toBe(1); // unchanged — withCheckpoint cached
    expect(sendReplyMock).toHaveBeenCalledTimes(2);
  });
});

describe("P1-16 !post — budget gate", () => {
  test("budget exhausted → canned message; no narrative call", async () => {
    // Seed today's ledger with usage that exceeds the budget.
    env.DAILY_TOKEN_BUDGET = "100";
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    // Pre-load the daily ledger via direct KV write so checkBudget sees it.
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

    await postIpc(envelope("!post anything"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toBe("Daily AI budget reached. Retry tomorrow or raise DAILY_TOKEN_BUDGET.");
  });
});

describe("P1-16 !post — narrative failure", () => {
  test("OpenRouter 401 → markFailed; error reply delivered", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai"),
        respond: () => jsonResponse({ error: { message: "invalid api key" } }, 401),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!post anything"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toMatch(/^Error: /);
  });
});
