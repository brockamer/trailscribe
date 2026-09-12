import type { KmlPing } from "../adapters/location/mapshare.js";

const EARTH_RADIUS_KM = 6371;

/**
 * Great-circle distance between two lat/lon points in kilometers, using the
 * Haversine formula. Sufficient accuracy for trail-distance work — within
 * ~0.5% of geodesic methods over the < 1000 km ranges we care about.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
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
    km += haversineKm(pings[i - 1].lat, pings[i - 1].lon, pings[i].lat, pings[i].lon);
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

export interface PaceStats {
  avgKmh: number;
  p50Kmh: number;
  p95Kmh: number;
}

/** Speed quantiles using the per-ping velocityKmh that Garmin already populates. */
export function paceStats(pings: KmlPing[]): PaceStats {
  if (pings.length === 0) return { avgKmh: 0, p50Kmh: 0, p95Kmh: 0 };
  const speeds = pings.map((p) => p.velocityKmh).sort((a, b) => a - b);
  const avg = speeds.reduce((s, v) => s + v, 0) / speeds.length;
  return {
    avgKmh: avg,
    p50Kmh: percentile(speeds, 0.5),
    p95Kmh: percentile(speeds, 0.95),
  };
}

function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const idx = q * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

export type RouteShape = "out-and-back" | "loop" | "point-to-point";

/**
 * Heuristic classifier from start/end/midpoint geometry.
 *
 *   start ~ end AND midpoint far from start  -> "out-and-back"
 *   start ~ end (no clear far midpoint)      -> "loop"
 *   start far from end                       -> "point-to-point"
 */
export function routeShape(pings: KmlPing[]): RouteShape {
  if (pings.length < 2) return "point-to-point";
  const start = pings[0];
  const end = pings[pings.length - 1];
  const mid = pings[Math.floor(pings.length / 2)];

  const startEndKm = haversineKm(start.lat, start.lon, end.lat, end.lon);
  const startMidKm = haversineKm(start.lat, start.lon, mid.lat, mid.lon);

  const LOOP_CLOSURE_KM = 0.1;
  const FAR_KM = 1.0;

  if (startEndKm < LOOP_CLOSURE_KM) {
    return startMidKm >= FAR_KM ? "out-and-back" : "loop";
  }
  return "point-to-point";
}

export type ActivityHint = "walk" | "hike" | "run" | "bike" | "drive" | "mixed";

/**
 * Classify activity by the band that holds the most non-zero pings.
 *
 *   walk:  0-5 km/h
 *   hike:  5-9 km/h
 *   run:   9-15 km/h
 *   bike:  15-35 km/h
 *   drive: 35+ km/h
 *
 * Returns "mixed" if no band gets a clear majority (>=40% of moving pings).
 */
export function activityHint(pings: KmlPing[]): ActivityHint {
  if (pings.length === 0) return "mixed";
  const moving = pings.filter((p) => p.velocityKmh > 1);
  if (moving.length === 0) return "mixed";

  const counts: Record<Exclude<ActivityHint, "mixed">, number> = {
    walk: 0,
    hike: 0,
    run: 0,
    bike: 0,
    drive: 0,
  };
  for (const p of moving) {
    if (p.velocityKmh < 5) counts.walk++;
    else if (p.velocityKmh < 9) counts.hike++;
    else if (p.velocityKmh < 15) counts.run++;
    else if (p.velocityKmh < 35) counts.bike++;
    else counts.drive++;
  }

  const sorted = (Object.entries(counts) as Array<[Exclude<ActivityHint, "mixed">, number]>).sort(
    ([, a], [, b]) => b - a,
  );
  const [topName, topCount] = sorted[0];
  if (topCount / moving.length >= 0.4) return topName;
  return "mixed";
}

export interface TrackMetrics {
  pingCount: number;
  startedAt: number;
  closedAt: number;
  durationSeconds: number;
  distanceKm: number;
  pace: PaceStats;
  elevation: ElevationProfile;
  routeShape: RouteShape;
  activityHint: ActivityHint;
}

/** Aggregate every metric the narrative pipeline needs into one record. */
export function computeMetrics(pings: KmlPing[]): TrackMetrics {
  if (pings.length === 0) {
    return {
      pingCount: 0,
      startedAt: 0,
      closedAt: 0,
      durationSeconds: 0,
      distanceKm: 0,
      pace: { avgKmh: 0, p50Kmh: 0, p95Kmh: 0 },
      elevation: { gainM: 0, lossM: 0, minM: 0, maxM: 0 },
      routeShape: "point-to-point",
      activityHint: "mixed",
    };
  }
  const startedAt = pings[0].t;
  const closedAt = pings[pings.length - 1].t;
  return {
    pingCount: pings.length,
    startedAt,
    closedAt,
    durationSeconds: Math.round((closedAt - startedAt) / 1000),
    distanceKm: totalDistanceKm(pings),
    pace: paceStats(pings),
    elevation: elevationProfile(pings),
    routeShape: routeShape(pings),
    activityHint: activityHint(pings),
  };
}
