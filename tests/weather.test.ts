import { describe, test, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { currentWeather } from "../src/adapters/location/weather.js";
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

describe("currentWeather — cache", () => {
  test("cache hit: returns stored value, no fetch", async () => {
    await env.TS_CACHE.put("wx:37.17:-118.59", "42°F, 8mph W, clear");
    const result = await currentWeather(37.17, -118.59, env);
    expect(result).toBe("42°F, 8mph W, clear");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("cache key rounds to 2 decimals (~1km grid) so nearby positions share", async () => {
    await env.TS_CACHE.put("wx:37.17:-118.59", "42°F, 8mph W, clear");
    // Different sub-cell positions, same 2-decimal cell
    const result = await currentWeather(37.171, -118.589, env);
    expect(result).toBe("42°F, 8mph W, clear");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("currentWeather — Open-Meteo fetch", () => {
  test("clear day: returns formatted string ≤30 chars; caches with 1h TTL", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        current: { temperature_2m: 42, wind_speed_10m: 8, weather_code: 0 },
      }),
    );
    const putSpy = vi.spyOn(env.TS_CACHE, "put");

    const result = await currentWeather(37.1682, -118.5891, env);
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toContain("42°F");
    expect(result).toContain("8mph");
    expect(result).toContain("clear");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("https://api.open-meteo.com/v1/forecast");
    expect(url).toContain("latitude=37.1682");
    expect(url).toContain("longitude=-118.5891");
    expect(url).toContain("current=temperature_2m,wind_speed_10m,weather_code");
    expect(url).toContain("temperature_unit=fahrenheit");
    expect(url).toContain("wind_speed_unit=mph");

    expect(putSpy).toHaveBeenCalledTimes(1);
    const [cacheKey, , opts] = putSpy.mock.calls[0];
    expect(String(cacheKey)).toBe("wx:37.17:-118.59");
    expect((opts as { expirationTtl?: number } | undefined)?.expirationTtl).toBe(3600);
  });

  test.each([
    [0, "clear"],
    [2, "partly cloudy"],
    [45, "fog"],
    [53, "drizzle"],
    [63, "rain"],
    [73, "snow"],
    [81, "showers"],
    [95, "thunderstorm"],
  ])("WMO code %i maps to %s", async (code, label) => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        current: { temperature_2m: 50, wind_speed_10m: 0, weather_code: code },
      }),
    );
    const result = await currentWeather(40, -100, env);
    expect(result).toContain(label);
  });
});

describe("currentWeather — error fallback", () => {
  test("5xx → 'weather unavailable'", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(503, {}));
    const result = await currentWeather(40, -100, env);
    expect(result).toBe("weather unavailable");
    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("weather_failed");
  });

  test("network error → 'weather unavailable'", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("network"));
    const result = await currentWeather(40, -100, env);
    expect(result).toBe("weather unavailable");
  });

  test("malformed response (no current.temperature_2m) → fallback", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { current: {} }));
    const result = await currentWeather(40, -100, env);
    expect(result).toBe("weather unavailable");
  });
});
