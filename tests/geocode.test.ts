import { describe, test, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { reverseGeocode } from "../src/adapters/location/geocode.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;
let fetchSpy: MockInstance<typeof fetch>;
let logSpy: MockInstance<(...args: unknown[]) => void>;
let errSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  env = makeTestEnv();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function loggedEvents(): Array<Record<string, unknown>> {
  const lines: string[] = [];
  for (const c of logSpy.mock.calls) lines.push(String(c[0]));
  for (const c of errSpy.mock.calls) lines.push(String(c[0]));
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("reverseGeocode — cache", () => {
  test("cache hit: returns stored value, no fetch issued", async () => {
    await env.TS_CACHE.put("geo:37.1682:-118.5891", "Palisade Glacier, CA");

    const result = await reverseGeocode(37.1682, -118.5891, env);
    expect(result).toBe("Palisade Glacier, CA");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("cache miss: fetches Nominatim, caches result with 24h TTL, returns short name", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        display_name: "Palisade Glacier, Inyo County, California, United States",
        address: {
          peak: "Palisade Glacier",
          county: "Inyo County",
          state: "California",
        },
      }),
    );
    const putSpy = vi.spyOn(env.TS_CACHE, "put");

    const result = await reverseGeocode(37.1682, -118.5891, env);
    expect(result).toContain("Palisade Glacier");
    expect(result).toContain("California");
    expect(result.length).toBeLessThanOrEqual(60);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(
      /^https:\/\/nominatim\.openstreetmap\.org\/reverse\?format=jsonv2&lat=37\.1682&lon=-118\.5891$/,
    );
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/trailscribe/i);

    expect(putSpy).toHaveBeenCalledTimes(1);
    const [cacheKey, , opts] = putSpy.mock.calls[0];
    expect(String(cacheKey)).toBe("geo:37.1682:-118.5891");
    expect((opts as { expirationTtl?: number } | undefined)?.expirationTtl).toBe(86400);
  });

  test("cache key rounds lat/lon to 4 decimals (~11m grid) so nearby positions share cache", async () => {
    await env.TS_CACHE.put("geo:37.1682:-118.5891", "Palisade Glacier, CA");

    // Same 4-decimal cell, sub-meter offset
    const result = await reverseGeocode(37.16819, -118.58912, env);
    expect(result).toBe("Palisade Glacier, CA");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("reverseGeocode — short-name strategy", () => {
  test("prefers locality > town > village > county when no peak", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        display_name: "very long full name",
        address: { town: "Bishop", state: "California", county: "Inyo County" },
      }),
    );
    const result = await reverseGeocode(37.36, -118.4, env);
    expect(result).toContain("Bishop");
    expect(result).toContain("California");
  });
});

describe("reverseGeocode — error fallback", () => {
  test("Nominatim 5xx → return 'unknown location' (does not throw)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(503, { error: "down" }));
    const result = await reverseGeocode(37.1682, -118.5891, env);
    expect(result).toBe("unknown location");

    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("geocode_failed");
  });

  test("network error → return 'unknown location'", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("network"));
    const result = await reverseGeocode(37.1682, -118.5891, env);
    expect(result).toBe("unknown location");
  });

  test("404 (no address found) → return 'unknown location'", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(404, { error: "not found" }));
    const result = await reverseGeocode(0.0001, 0.0001, env);
    expect(result).toBe("unknown location");
  });
});
