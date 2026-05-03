import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  haversineKm,
  totalDistanceKm,
  elevationProfile,
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
    const km = haversineKm(
      34.026825,
      -118.760255,
      34.02644,
      -118.76182,
    );
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
    const pings = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110].map(
      (alt, i) => makePing(i, alt),
    );
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
