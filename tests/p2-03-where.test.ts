/**
 * P2-03 — End-to-end integration tests for !where pipeline.
 *
 * Drives the Worker via app.request(...) with a real orchestrator and a
 * mocked sendReply + mocked Nominatim. Asserts:
 *   - Happy path: place name + Maps link + MapShare link in the device reply.
 *   - No-GPS-fix path: returns the canonical "Need GPS fix" prompt; Nominatim
 *     is never hit.
 *   - Geocode failure path: place collapses to "unknown location" via the
 *     reverseGeocode FALLBACK; raw coords still surface via the Maps URL.
 *   - Ledger always records `cmd: 'where'` with usd_cost: 0 (telemetry parity
 *     with !ping; no-fix invocations count too).
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
const MAPSHARE = "https://share.garmin.com/MyMap";

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
  routes: Array<{
    match: (url: string) => boolean;
    respond: () => Response | Promise<Response>;
  }>,
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
  env = makeTestEnv({ MAPSHARE_BASE: MAPSHARE });
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

describe("P2-03 !where — happy path with GPS", () => {
  test("calls geocode; reply contains place name + Maps link + MapShare link", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("nominatim.openstreetmap.org"),
        respond: () =>
          jsonResponse({
            display_name: "Lake Sabrina, Inyo County, California",
            address: { locality: "Lake Sabrina", state: "California" },
          }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!where", { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    const joined = messages.join(" ");
    expect(joined).toContain("Lake Sabrina, California");
    expect(joined).toContain(`https://www.google.com/maps/search/?api=1&query=${LAT},${LON}`);
    expect(joined).toContain(MAPSHARE);
    expect(joined.length).toBeLessThanOrEqual(320);

    // Hit Nominatim once, no other outbound calls.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("nominatim.openstreetmap.org");
  });

  test("records a 0-cost ledger transaction tagged cmd=where", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("nominatim.openstreetmap.org"),
        respond: () =>
          jsonResponse({
            address: { locality: "Onion Valley", state: "California" },
          }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!where", { gps: { lat: LAT, lon: LON } }));

    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(1);
    expect(snap.usd_cost).toBe(0);
    expect(snap.by_command["where"]).toEqual({ requests: 1, usd_cost: 0 });
  });

  test("MAPSHARE_BASE empty → reply omits the MapShare link, Maps link still present", async () => {
    env = makeTestEnv({ MAPSHARE_BASE: "" });
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("nominatim.openstreetmap.org"),
        respond: () => jsonResponse({ address: { locality: "Lake Sabrina", state: "California" } }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!where", { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    const joined = messages.join(" ");
    expect(joined).toContain("Lake Sabrina, California");
    expect(joined).toContain("google.com/maps");
    expect(joined).not.toContain("share.garmin.com");
  });
});

describe("P2-03 !where — no GPS fix", () => {
  test("returns the canonical 'Need GPS fix' prompt; never calls Nominatim", async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!where")); // gpsFix=0, lat=0, lon=0

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Need GPS fix — try again outdoors."]);
  });

  test("still records a 0-cost ledger transaction (telemetry parity)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("should not have called fetch");
    }) as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!where"));

    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(1);
    expect(snap.by_command["where"]).toEqual({ requests: 1, usd_cost: 0 });
  });
});

describe("P2-03 !where — geocode failure", () => {
  test("Nominatim 500 → reply uses 'unknown location' fallback + raw coords via Maps URL", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("nominatim.openstreetmap.org"),
        respond: () => new Response("server error", { status: 500 }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!where", { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    const joined = messages.join(" ");
    expect(joined).toContain("unknown location");
    // Raw coords still reach the user via the Maps URL — that's the "+ raw coords"
    // half of the acceptance criterion.
    expect(joined).toContain(`${LAT},${LON}`);
  });
});
