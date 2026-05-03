import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  haversineKm,
  totalDistanceKm,
} from "../src/core/track-metrics.js";
import { parsePings } from "../src/adapters/location/mapshare.js";

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
