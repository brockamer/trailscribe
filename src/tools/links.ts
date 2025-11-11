import { Config } from '../config/env';

/**
 * Build a Google Maps link given latitude and longitude. The base
 * URL may be configured via the environment; defaults to Google Maps
 * search API. Note: the `query` parameter expects `lat,lon`.
 */
export function buildGoogleMapsLink(lat: number, lon: number, config: Config): string {
  const base = config.GOOGLE_MAPS_BASE || 'https://www.google.com/maps/search/?api=1&query=';
  return `${base}${lat},${lon}`;
}

/**
 * Build a Garmin MapShare link given latitude and longitude. The base
 * MapShare URL should be configured via environment. If not set, the
 * function returns an empty string.
 */
export function buildMapShareLink(lat: number, lon: number, config: Config): string {
  const base = config.MAPSHARE_BASE;
  if (!base) return '';
  // Some MapShare implementations allow lat/lon as query params.
  return `${base}?d=${lat},${lon}`;
}