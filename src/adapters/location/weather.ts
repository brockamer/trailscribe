import type { Env } from "../../env.js";
import { log } from "../logging/worker-logs.js";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_SECONDS = 3600;
const FALLBACK = "weather unavailable";

interface OpenMeteoResponse {
  current?: {
    temperature_2m?: number;
    wind_speed_10m?: number;
    wind_direction_10m?: number;
    weather_code?: number;
  };
}

/**
 * Short current-weather string for `(lat, lon)` via Open-Meteo. Returns ≤30
 * characters like `"42°F, 8mph, clear"`. KV-cached at the 2-decimal-degree
 * (~1km) grid for 1 hour — weather doesn't change second-by-second, and
 * tight clustering of repeat positions never re-fetches.
 *
 * Imperial units (PRD personas span US/Iceland/Patagonia; default imperial,
 * future preference toggle). WMO weather_code is mapped via a compact lookup
 * to a single short label.
 *
 * Errors non-fatal — Open-Meteo downtime returns `"weather unavailable"`
 * rather than throwing.
 *
 * Caller responsibility: never invoke when lat/lon are absent (orchestrator
 * strips them in P1-01).
 */
export async function currentWeather(lat: number, lon: number, env: Env): Promise<string> {
  return (await currentWeatherDetail(lat, lon, env)).text;
}

/**
 * Weather with the raw WMO code preserved alongside the display string.
 *
 * `!postimg` needs the code, not the label: the image prompt renders light
 * quality ("crisp, well-defined shadows") rather than data ("74°F, 8mph"),
 * and regex-parsing the display string back into a code is exactly the kind
 * of round-trip that rots (#235). `code` is undefined when the upstream call
 * failed or when a pre-#235 cache entry is read back.
 */
export interface WeatherDetail {
  text: string;
  code?: number;
}

export async function currentWeatherDetail(
  lat: number,
  lon: number,
  env: Env,
): Promise<WeatherDetail> {
  // Versioned key (#235 review). The value shape changed from a bare display
  // string to JSON. Sharing one key across both shapes is not rollback-safe:
  // pre-#235 code reading a v2 entry would hand raw JSON straight to the
  // device as the weather string. Old code reads `wx:` and never sees these,
  // so a rollback misses cleanly and re-fetches.
  const key = `wx:v2:${lat.toFixed(2)}:${lon.toFixed(2)}`;
  const cached = await env.TS_CACHE.get(key);
  if (cached !== null) return parseCached(cached);

  const url =
    `${OPEN_METEO_BASE}?latitude=${lat}&longitude=${lon}` +
    `&current=temperature_2m,wind_speed_10m,weather_code` +
    `&temperature_unit=fahrenheit&wind_speed_unit=mph`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    log({
      event: "weather_failed",
      level: "warn",
      reason: "network",
      error: e instanceof Error ? e.message : String(e),
    });
    return { text: FALLBACK };
  }

  if (!res.ok) {
    log({ event: "weather_failed", level: "warn", reason: "http", status: res.status });
    return { text: FALLBACK };
  }

  let data: OpenMeteoResponse;
  try {
    data = (await res.json()) as OpenMeteoResponse;
  } catch {
    log({ event: "weather_failed", level: "warn", reason: "bad_json" });
    return { text: FALLBACK };
  }

  const formatted = formatWeather(data);
  if (formatted === FALLBACK) {
    log({ event: "weather_failed", level: "warn", reason: "missing_fields" });
    return { text: FALLBACK };
  }
  const detail: WeatherDetail = { text: formatted, code: data.current?.weather_code };
  await env.TS_CACHE.put(key, JSON.stringify(detail), { expirationTtl: CACHE_TTL_SECONDS });
  return detail;
}

/**
 * Read a cache entry written by either shape.
 *
 * Before #235 this cache held a bare display string; those entries live for
 * up to an hour after deploy, so a naive `JSON.parse` would throw on every
 * one of them. Anything that isn't a well-formed detail object is treated as
 * legacy text with no code.
 */
function parseCached(raw: string): WeatherDetail {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as WeatherDetail).text === "string"
    ) {
      const d = parsed as WeatherDetail;
      return { text: d.text, code: typeof d.code === "number" ? d.code : undefined };
    }
  } catch {
    // legacy bare-string entry — fall through
  }
  return { text: raw };
}

function formatWeather(data: OpenMeteoResponse): string {
  const c = data.current;
  if (!c || c.temperature_2m === undefined || c.weather_code === undefined) {
    return FALLBACK;
  }
  const temp = `${Math.round(c.temperature_2m)}°F`;
  const wind = c.wind_speed_10m !== undefined ? `${Math.round(c.wind_speed_10m)}mph` : "";
  const label = wmoLabel(c.weather_code);
  return [temp, wind, label].filter(Boolean).join(", ");
}

/**
 * Compact WMO weather-code → label table per Open-Meteo docs.
 * https://open-meteo.com/en/docs §Weather Variable Documentation
 */
function wmoLabel(code: number): string {
  if (code === 0) return "clear";
  if (code >= 1 && code <= 3) return "partly cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code >= 95 && code <= 99) return "thunderstorm";
  return "unknown";
}
