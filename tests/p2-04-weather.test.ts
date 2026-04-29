/**
 * P2-04 — End-to-end integration tests for !weather pipeline.
 *
 * Asserts:
 *   - Happy path: Open-Meteo current-conditions string surfaces in the reply.
 *   - No-GPS-fix path: returns the canonical "Need GPS fix" prompt; Open-Meteo
 *     is never hit.
 *   - Cache-hit path: second invocation at the same coords does not re-call
 *     Open-Meteo (adapter caches at the 2-decimal-degree grid for 1h).
 *   - Adapter-failure path: Open-Meteo 500 collapses to "weather unavailable"
 *     in the reply (adapter swallows errors per Phase 1 contract).
 *   - Ledger always records `cmd: 'weather'` at $0.
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

const LAT = 37.1682;
const LON = -118.5891;

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
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

function makeFetchRouter(
  routes: Array<{ match: (url: string) => boolean; respond: () => Response | Promise<Response> }>,
) {
  return vi.fn(async (url: URL | RequestInfo) => {
    const u = typeof url === "string" ? url : url.toString();
    for (const r of routes) {
      if (r.match(u)) return await r.respond();
    }
    throw new Error(`unmatched fetch: ${u}`);
  });
}

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv();
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

describe("P2-04 !weather — happy path with GPS", () => {
  test("calls Open-Meteo; reply contains the formatted current-conditions string", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.open-meteo.com"),
        respond: () =>
          jsonResponse({
            current: { temperature_2m: 42, wind_speed_10m: 8, weather_code: 0 },
          }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!weather", { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["42°F, 8mph, clear"]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0][0])).toContain("api.open-meteo.com");
  });

  test("records a 0-cost ledger transaction tagged cmd=weather", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.open-meteo.com"),
        respond: () =>
          jsonResponse({
            current: { temperature_2m: 50, wind_speed_10m: 12, weather_code: 61 },
          }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!weather", { gps: { lat: LAT, lon: LON } }));

    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(1);
    expect(snap.usd_cost).toBe(0);
    expect(snap.by_command["weather"]).toEqual({ requests: 1, usd_cost: 0 });
  });

  test("cache hit: second call at same coords does not re-fetch Open-Meteo", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.open-meteo.com"),
        respond: () =>
          jsonResponse({
            current: { temperature_2m: 70, wind_speed_10m: 5, weather_code: 1 },
          }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!weather", { ts: 1, gps: { lat: LAT, lon: LON } }));
    await postIpc(envelope("!weather", { ts: 2, gps: { lat: LAT, lon: LON } }));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const first = sendReplyMock.mock.calls[0][1];
    const second = sendReplyMock.mock.calls[1][1];
    expect(first).toEqual(second);
  });
});

describe("P2-04 !weather — no GPS fix", () => {
  test("returns the canonical 'Need GPS fix' prompt; never calls Open-Meteo", async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!weather"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Need GPS fix — try again outdoors."]);
  });

  test("still records a 0-cost ledger transaction (telemetry parity)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("should not have called fetch");
    }) as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!weather"));

    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(1);
    expect(snap.by_command["weather"]).toEqual({ requests: 1, usd_cost: 0 });
  });
});

describe("P2-04 !weather — adapter failure", () => {
  test("Open-Meteo 500 → reply uses 'weather unavailable' fallback", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.open-meteo.com"),
        respond: () => new Response("server error", { status: 500 }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!weather", { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["weather unavailable"]);
  });
});
