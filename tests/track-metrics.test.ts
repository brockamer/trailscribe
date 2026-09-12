import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  haversineKm,
  totalDistanceKm,
  elevationProfile,
  paceStats,
  routeShape,
  activityHint,
  computeMetrics,
} from "../src/core/track-metrics.js";
import { parsePings } from "../src/adapters/location/mapshare.js";
import type { KmlPing } from "../src/adapters/location/mapshare.js";

function makePing(secOffset: number, alt: number): KmlPing {
  return {
    t: secOffset * 1000,
    lat: 34.0,
    lon: -118.0,
    alt,
    velocityKmh: 0,
    courseDeg: 0,
    validFix: true,
  };
}

const FIXTURE_KML = readFileSync(
  resolve(__dirname, "fixtures/mapshare/pch-2026-05-02.kml"),
  "utf8",
);

describe("haversineKm", () => {
  test("zero distance for identical points", () => {
    expect(haversineKm(34.0, -118.0, 34.0, -118.0)).toBe(0);
  });

  test("~111 km for one degree of latitude difference", () => {
    const km = haversineKm(34.0, -118.0, 35.0, -118.0);
    expect(km).toBeGreaterThan(110);
    expect(km).toBeLessThan(112);
  });

  test("known PCH-fixture leg: ping 1 to ping 2 ~ 0.16 km", () => {
    const km = haversineKm(34.026825, -118.760255, 34.02644, -118.76182);
    expect(km).toBeGreaterThan(0.13);
    expect(km).toBeLessThan(0.18);
  });
});

describe("totalDistanceKm", () => {
  test("zero pings returns 0", () => {
    expect(totalDistanceKm([])).toBe(0);
  });

  test("one ping returns 0", () => {
    const pings = parsePings(FIXTURE_KML);
    expect(totalDistanceKm([pings[0]])).toBe(0);
  });

  test("PCH fixture totals roughly 1-4 km", () => {
    const pings = parsePings(FIXTURE_KML);
    const km = totalDistanceKm(pings);
    expect(km).toBeGreaterThan(1.0);
    expect(km).toBeLessThan(4.0);
  });
});

describe("elevationProfile", () => {
  test("zero-pings input returns all zeros", () => {
    expect(elevationProfile([])).toEqual({
      gainM: 0,
      lossM: 0,
      minM: 0,
      maxM: 0,
    });
  });

  test("monotonic-up sequence: positive gain, zero loss", () => {
    const pings = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110].map((alt, i) => makePing(i, alt));
    const profile = elevationProfile(pings);
    expect(profile.gainM).toBeGreaterThan(50);
    expect(profile.lossM).toBe(0);
    expect(profile.maxM).toBeGreaterThan(90);
    expect(profile.minM).toBeLessThan(30);
  });

  test("smoothing rejects single-point spikes", () => {
    const pings = [10, 10, 100, 10, 10].map((alt, i) => makePing(i, alt));
    const profile = elevationProfile(pings);
    expect(profile.gainM).toBeLessThan(5);
  });

  test("PCH fixture: trail starts ~30m, drops to beach ~0m, returns ~30m", () => {
    const pings = parsePings(FIXTURE_KML);
    const profile = elevationProfile(pings);
    expect(profile.maxM).toBeGreaterThan(25);
    expect(profile.minM).toBeLessThan(5);
    expect(profile.gainM).toBeGreaterThan(20);
    expect(profile.gainM).toBeLessThan(80);
  });
});

describe("paceStats", () => {
  test("empty input returns zeros", () => {
    expect(paceStats([])).toEqual({ avgKmh: 0, p50Kmh: 0, p95Kmh: 0 });
  });

  test("uniform speed: avg/p50/p95 all equal that speed", () => {
    const pings = [10, 10, 10, 10].map((v, i) => ({
      ...makePing(i, 0),
      velocityKmh: v,
    }));
    const stats = paceStats(pings);
    expect(stats.avgKmh).toBe(10);
    expect(stats.p50Kmh).toBe(10);
    expect(stats.p95Kmh).toBe(10);
  });

  test("PCH fixture: p95 reflects the running segments (>=10 km/h)", () => {
    const pings = parsePings(FIXTURE_KML);
    const stats = paceStats(pings);
    expect(stats.p95Kmh).toBeGreaterThan(10);
    expect(stats.avgKmh).toBeGreaterThan(0);
    expect(stats.avgKmh).toBeLessThan(stats.p95Kmh);
  });
});

describe("routeShape", () => {
  test("empty or single-ping returns 'point-to-point'", () => {
    expect(routeShape([])).toBe("point-to-point");
    expect(routeShape([makePing(0, 0)])).toBe("point-to-point");
  });

  test("start and end nearly coincident, midpoint far: 'out-and-back'", () => {
    const pings: KmlPing[] = [
      { ...makePing(0, 0), lat: 0, lon: 0 },
      { ...makePing(1, 0), lat: 0, lon: 0.01 },
      { ...makePing(2, 0), lat: 0, lon: 0.02 },
      { ...makePing(3, 0), lat: 0, lon: 0.01 },
      { ...makePing(4, 0), lat: 0, lon: 0.0001 },
    ];
    const shape = routeShape(pings);
    expect(["out-and-back", "loop"]).toContain(shape);
  });

  test("point-to-point: start and end far apart", () => {
    const pings: KmlPing[] = [
      { ...makePing(0, 0), lat: 0, lon: 0 },
      { ...makePing(1, 0), lat: 0, lon: 0.5 },
      { ...makePing(2, 0), lat: 0, lon: 1.0 },
    ];
    expect(routeShape(pings)).toBe("point-to-point");
  });

  test("PCH fixture closes (start ~ end) — short out-and-back classifies as loop", () => {
    const pings = parsePings(FIXTURE_KML);
    expect(["out-and-back", "loop"]).toContain(routeShape(pings));
  });
});

describe("activityHint", () => {
  test("empty input returns 'mixed'", () => {
    expect(activityHint([])).toBe("mixed");
  });

  test("walking pace dominant: 'walk'", () => {
    const pings = Array.from({ length: 20 }, (_, i) => ({
      ...makePing(i, 0),
      velocityKmh: 4,
    }));
    expect(activityHint(pings)).toBe("walk");
  });

  test("hiking pace dominant: 'hike'", () => {
    const pings = Array.from({ length: 20 }, (_, i) => ({
      ...makePing(i, 0),
      velocityKmh: 7,
    }));
    expect(activityHint(pings)).toBe("hike");
  });

  test("running pace dominant: 'run'", () => {
    const pings = Array.from({ length: 20 }, (_, i) => ({
      ...makePing(i, 0),
      velocityKmh: 11,
    }));
    expect(activityHint(pings)).toBe("run");
  });

  test("cycling pace: 'bike'", () => {
    const pings = Array.from({ length: 20 }, (_, i) => ({
      ...makePing(i, 0),
      velocityKmh: 22,
    }));
    expect(activityHint(pings)).toBe("bike");
  });

  test("PCH fixture (run + walk mix): 'mixed', 'run', or 'walk'", () => {
    const pings = parsePings(FIXTURE_KML);
    expect(["mixed", "run", "walk"]).toContain(activityHint(pings));
  });
});

describe("computeMetrics", () => {
  test("PCH fixture produces a populated TrackMetrics object", () => {
    const pings = parsePings(FIXTURE_KML);
    const metrics = computeMetrics(pings);

    expect(metrics.pingCount).toBe(14);
    expect(metrics.startedAt).toBe(Date.parse("2026-05-02T15:51:30Z"));
    expect(metrics.closedAt).toBe(Date.parse("2026-05-02T16:24:30Z"));
    expect(metrics.durationSeconds).toBeGreaterThan(1900);
    expect(metrics.durationSeconds).toBeLessThan(2100);
    expect(metrics.distanceKm).toBeGreaterThan(1.0);
    expect(metrics.distanceKm).toBeLessThan(4.0);
    expect(["out-and-back", "loop"]).toContain(metrics.routeShape);
    expect(metrics.activityHint).toBeDefined();
    expect(metrics.elevation.maxM).toBeGreaterThan(25);
    expect(metrics.pace.p95Kmh).toBeGreaterThan(0);
  });

  test("empty input returns a zeroed TrackMetrics", () => {
    const m = computeMetrics([]);
    expect(m.pingCount).toBe(0);
    expect(m.distanceKm).toBe(0);
    expect(m.durationSeconds).toBe(0);
  });
});
