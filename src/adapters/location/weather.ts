import type { Env } from "../../env.js";

/**
 * Short current-weather summary for (lat, lon) via Open-Meteo, cached under
 * `wx:<lat:2,lon:2>` with 1h TTL.
 * Stub in Phase 0 — real implementation in Phase 1.
 */
export async function currentWeather(_lat: number, _lon: number, _env: Env): Promise<string> {
  throw new Error("currentWeather: not implemented in Phase 0 — Phase 1 target");
}
