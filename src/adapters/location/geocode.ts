import type { Env } from "../../env.js";
import { log } from "../logging/worker-logs.js";

const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/reverse";
const USER_AGENT = "trailscribe (https://github.com/brockamer/trailscribe)";
const CACHE_TTL_SECONDS = 86400;
const MAX_NAME_LENGTH = 60;
const FALLBACK = "unknown location";

interface NominatimAddress {
  peak?: string;
  locality?: string;
  town?: string;
  village?: string;
  city?: string;
  county?: string;
  state?: string;
}

interface NominatimResponse {
  display_name?: string;
  address?: NominatimAddress;
}

/**
 * Reverse-geocode `(lat, lon)` to a short human-readable place name suitable
 * for embedding in a 320-char SMS reply. KV-cached at the rounded
 * 4-decimal-degree (~11m) grid for 24 hours so repeat positions don't re-hit
 * Nominatim, which has a 1-req/sec polite-use policy.
 *
 * Caller responsibility: never invoke when lat/lon are absent or both zero
 * (orchestrator strips them in P1-01).
 *
 * Errors are non-fatal — Nominatim downtime returns `"unknown location"`
 * instead of throwing, since geocoding is enrichment, not core functionality.
 */
export async function reverseGeocode(lat: number, lon: number, env: Env): Promise<string> {
  const key = `geo:${lat.toFixed(4)}:${lon.toFixed(4)}`;
  const cached = await env.TS_CACHE.get(key);
  if (cached !== null) return cached;

  const url = `${NOMINATIM_BASE}?format=jsonv2&lat=${lat}&lon=${lon}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  } catch (e) {
    log({
      event: "geocode_failed",
      level: "warn",
      reason: "network",
      error: e instanceof Error ? e.message : String(e),
    });
    return FALLBACK;
  }

  if (!res.ok) {
    log({ event: "geocode_failed", level: "warn", reason: "http", status: res.status });
    return FALLBACK;
  }

  let data: NominatimResponse;
  try {
    data = (await res.json()) as NominatimResponse;
  } catch {
    log({ event: "geocode_failed", level: "warn", reason: "bad_json" });
    return FALLBACK;
  }

  const name = shortenName(data);
  await env.TS_CACHE.put(key, name, { expirationTtl: CACHE_TTL_SECONDS });
  return name;
}

function shortenName(data: NominatimResponse): string {
  const a = data.address ?? {};
  const place = a.peak ?? a.locality ?? a.town ?? a.village ?? a.city ?? a.county;
  const parts = [place, a.state].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return FALLBACK;
  const joined = parts.join(", ");
  return joined.length > MAX_NAME_LENGTH ? joined.slice(0, MAX_NAME_LENGTH) : joined;
}
