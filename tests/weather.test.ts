import { describe, test, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { currentWeather, currentWeatherDetail } from "../src/adapters/location/weather.js";
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
    await env.TS_CACHE.put("wx:v2:37.17:-118.59", "42°F, 8mph W, clear");
    const result = await currentWeather(37.17, -118.59, env);
    expect(result).toBe("42°F, 8mph W, clear");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("cache key rounds to 2 decimals (~1km grid) so nearby positions share", async () => {
    await env.TS_CACHE.put("wx:v2:37.17:-118.59", "42°F, 8mph W, clear");
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
    expect(String(cacheKey)).toBe("wx:v2:37.17:-118.59");
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

// ---------------------------------------------------------------------------
// #235 — the cache value shape changed from a bare display string to JSON so
// the raw WMO code survives for the image prompt. Two hazards come with that:
// a legacy entry must not crash JSON.parse, and a rollback must not surface
// raw JSON to the device.
// ---------------------------------------------------------------------------

describe("currentWeatherDetail — cache shape migration (#235)", () => {
  test("round-trips text and the raw WMO code through the cache", async () => {
    const env = makeTestEnv();
    await env.TS_CACHE.put(
      "wx:v2:37.17:-118.59",
      JSON.stringify({ text: "42°F, 8mph W, clear", code: 0 }),
    );
    const got = await currentWeatherDetail(37.1682, -118.5891, env);
    expect(got.text).toBe("42°F, 8mph W, clear");
    expect(got.code).toBe(0);
  });

  test("a legacy bare-string entry is read as text, not thrown on", async () => {
    const env = makeTestEnv();
    await env.TS_CACHE.put("wx:v2:37.17:-118.59", "42°F, 8mph W, clear");
    const got = await currentWeatherDetail(37.1682, -118.5891, env);
    expect(got.text).toBe("42°F, 8mph W, clear");
    expect(got.code).toBeUndefined();
  });

  test("legacy strings that happen to be valid JSON scalars still read as text", async () => {
    // "null", "42" and "true" all parse successfully but are not detail
    // objects — the shape check, not the try/catch, is what saves these.
    for (const raw of ["null", "42", "true", '"quoted"', ""]) {
      const env = makeTestEnv();
      await env.TS_CACHE.put("wx:v2:37.17:-118.59", raw);
      const got = await currentWeatherDetail(37.1682, -118.5891, env);
      expect(got.text).toBe(raw);
      expect(got.code).toBeUndefined();
    }
  });

  test("the cache key is versioned, so a rollback to pre-#235 code misses cleanly", async () => {
    // Old code reads `wx:<lat>:<lon>`; nothing writes that key any more, so a
    // rollback re-fetches from Open-Meteo instead of handing raw JSON to the
    // device as the weather string.
    const env = makeTestEnv();
    await env.TS_CACHE.put("wx:37.17:-118.59", "stale pre-#235 entry");
    const putSpy = vi.spyOn(env.TS_CACHE, "put");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          current: { temperature_2m: 49, wind_speed_10m: 2, weather_code: 0 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const got = await currentWeatherDetail(37.1682, -118.5891, env);
    expect(got.text).not.toBe("stale pre-#235 entry");
    expect(String(putSpy.mock.calls[0][0])).toBe("wx:v2:37.17:-118.59");
    vi.restoreAllMocks();
  });
});

// #274 — the same Open-Meteo call carries the civil UTC offset (DST-aware) and
// that day's sunrise/sunset, so the narrative can state the operator's clock
// time instead of mean solar time. Responses recorded live 2026-10-02.
const MALIBU_PDT = JSON.parse(
  readFileSync(join(__dirname, "fixtures/open-meteo/malibu-pdt-2026-10-02.json"), "utf8"),
) as unknown;
const REYKJAVIK_UTC = JSON.parse(
  readFileSync(join(__dirname, "fixtures/open-meteo/reykjavik-utc-2026-10-02.json"), "utf8"),
) as unknown;

describe("currentWeatherDetail — civil time (#274)", () => {
  test("asks Open-Meteo for the local timezone and the day's sunrise/sunset", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, MALIBU_PDT));
    await currentWeatherDetail(34.026, -118.76, env);
    const url = String(fetchSpy.mock.calls[0][0]);
    expect(url).toContain("timezone=auto");
    expect(url).toContain("daily=sunrise,sunset");
    expect(url).toContain("forecast_days=1");
  });

  test("DST: America/Los_Angeles in October is UTC−7, with HH:MM sunrise and sunset", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, MALIBU_PDT));
    const got = await currentWeatherDetail(34.026, -118.76, env);
    expect(got.civil).toEqual({ utcOffsetSeconds: -25200, sunrise: "06:50", sunset: "18:37" });
  });

  test("non-DST: Atlantic/Reykjavik is UTC+0 — a zero offset is kept, not dropped", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, REYKJAVIK_UTC));
    const got = await currentWeatherDetail(64.15, -21.94, env);
    expect(got.civil?.utcOffsetSeconds).toBe(0);
    expect(got.civil?.sunrise).toMatch(/^\d{2}:\d{2}$/);
  });

  test("civil time round-trips through the cache", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, MALIBU_PDT));
    const first = await currentWeatherDetail(34.026, -118.76, env);
    const second = await currentWeatherDetail(34.026, -118.76, env);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  test("a cache entry written before #274 has no civil time and reads back without one", async () => {
    await env.TS_CACHE.put(
      "wx:v2:34.03:-118.76",
      JSON.stringify({ text: "62°F, 3mph, clear", code: 0 }),
    );
    const got = await currentWeatherDetail(34.026, -118.76, env);
    expect(got).toEqual({ text: "62°F, 3mph, clear", code: 0 });
    expect(got.civil).toBeUndefined();
  });

  test("a response without utc_offset_seconds yields no civil time", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, { current: { temperature_2m: 62, wind_speed_10m: 3, weather_code: 0 } }),
    );
    const got = await currentWeatherDetail(34.026, -118.76, env);
    expect(got.text).toBe("62°F, 3mph, clear");
    expect(got.civil).toBeUndefined();
  });

  test("weather failure yields no civil time", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("boom", { status: 503 }));
    const got = await currentWeatherDetail(34.026, -118.76, env);
    expect(got.civil).toBeUndefined();
  });
});
