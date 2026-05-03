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

export interface ElevationProfile {
  gainM: number;
  lossM: number;
  minM: number;
  maxM: number;
}

/**
 * Elevation aggregates over a smoothed altitude series.
 *
 * Handheld GPS altitude is noisy (10-15 m even with a fix). Without smoothing,
 * a single bad sample can inflate gain by 50+ meters. We apply a 5-point
 * median filter before differencing.
 */
export function elevationProfile(pings: KmlPing[]): ElevationProfile {
  if (pings.length === 0) return { gainM: 0, lossM: 0, minM: 0, maxM: 0 };
  const smoothed = medianSmooth(
    pings.map((p) => p.alt),
    5,
  );

  let gainM = 0;
  let lossM = 0;
  let minM = smoothed[0];
  let maxM = smoothed[0];
  for (let i = 1; i < smoothed.length; i++) {
    const delta = smoothed[i] - smoothed[i - 1];
    if (delta > 0) gainM += delta;
    else lossM += -delta;
    if (smoothed[i] < minM) minM = smoothed[i];
    if (smoothed[i] > maxM) maxM = smoothed[i];
  }
  return { gainM, lossM, minM, maxM };
}

function medianSmooth(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    const lo = Math.max(0, i - half);
    const hi = Math.min(values.length, i + half + 1);
    const slice = values.slice(lo, hi).sort((a, b) => a - b);
    return slice[Math.floor(slice.length / 2)];
  });
}
