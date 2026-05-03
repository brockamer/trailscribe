import type { KmlPing } from "../adapters/location/mapshare.js";

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two lat/lon points in kilometers, using the
 * Haversine formula. Sufficient accuracy for trail-distance work — within
 * ~0.5% of geodesic methods over the < 1000 km ranges we care about.
 */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

/** Cumulative Haversine distance across all consecutive ping pairs. */
export function totalDistanceKm(pings: KmlPing[]): number {
  if (pings.length < 2) return 0;
  let km = 0;
  for (let i = 1; i < pings.length; i++) {
    km += haversineKm(
      pings[i - 1].lat,
      pings[i - 1].lon,
      pings[i].lat,
      pings[i].lon,
    );
  }
  return km;
}
