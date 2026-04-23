import type { Env } from "../env.js";

/**
 * Build a Google Maps link for the given coordinates.
 * `env.GOOGLE_MAPS_BASE` typically ends in `?api=1&query=` so we append `lat,lon`.
 */
export function buildGoogleMapsLink(lat: number, lon: number, env: Env): string {
  const base = env.GOOGLE_MAPS_BASE || "https://www.google.com/maps/search/?api=1&query=";
  return `${base}${lat},${lon}`;
}

/**
 * Build a Garmin MapShare link. Returns empty string when MAPSHARE_BASE is unset.
 */
export function buildMapShareLink(lat: number, lon: number, env: Env): string {
  if (!env.MAPSHARE_BASE) return "";
  return `${env.MAPSHARE_BASE}?d=${lat},${lon}`;
}
