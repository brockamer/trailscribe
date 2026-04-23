import type { Env } from "../../env.js";

/**
 * Reverse-geocode (lat, lon) to a human-readable place string via Nominatim,
 * cached in `env.TS_CACHE` under `geo:<lat:4,lon:4>` with 24h TTL.
 * Stub in Phase 0 — real implementation in Phase 1.
 */
export async function reverseGeocode(_lat: number, _lon: number, _env: Env): Promise<string> {
  throw new Error("reverseGeocode: not implemented in Phase 0 — Phase 1 target");
}
