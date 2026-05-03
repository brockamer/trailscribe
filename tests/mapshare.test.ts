import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePings } from "../src/adapters/location/mapshare.js";
import type { KmlPing } from "../src/adapters/location/mapshare.js";

const FIXTURE_PATH = resolve(__dirname, "fixtures/mapshare/pch-2026-05-02.kml");
const fixtureKml = readFileSync(FIXTURE_PATH, "utf8");

describe("parsePings — PCH 2026-05-02 fixture", () => {
  test("extracts exactly 14 individual breadcrumb pings (excludes LineString)", () => {
    const pings = parsePings(fixtureKml);
    expect(pings).toHaveLength(14);
  });

  test("first ping matches the known 15:51:30Z trailhead position", () => {
    const pings = parsePings(fixtureKml);
    const first = pings[0];
    expect(first.t).toBe(Date.parse("2026-05-02T15:51:30Z"));
    expect(first.lat).toBeCloseTo(34.026825, 5);
    expect(first.lon).toBeCloseTo(-118.760255, 5);
    expect(first.alt).toBeCloseTo(30.76, 1);
    expect(first.velocityKmh).toBe(0);
    expect(first.courseDeg).toBe(0);
    expect(first.validFix).toBe(true);
  });

  test("second ping matches the known 15:53:30Z running-W breadcrumb", () => {
    const pings = parsePings(fixtureKml);
    const p2 = pings[1];
    expect(p2.t).toBe(Date.parse("2026-05-02T15:53:30Z"));
    expect(p2.velocityKmh).toBeCloseTo(12.2, 1);
    expect(p2.courseDeg).toBeCloseTo(247.5, 1);
  });

  test("pings are sorted oldest-first by timestamp", () => {
    const pings = parsePings(fixtureKml);
    for (let i = 1; i < pings.length; i++) {
      expect(pings[i].t).toBeGreaterThanOrEqual(pings[i - 1].t);
    }
  });

  test("returns empty array for KML with no Placemarks", () => {
    const empty = `<?xml version="1.0"?><kml><Document></Document></kml>`;
    expect(parsePings(empty)).toEqual([]);
  });

  test("returns empty array for KML with only a LineString Placemark", () => {
    const onlyLine = `<?xml version="1.0"?><kml><Document>
      <Placemark><name>track log</name>
        <LineString><coordinates>0,0,0 1,1,1</coordinates></LineString>
      </Placemark>
    </Document></kml>`;
    expect(parsePings(onlyLine)).toEqual([]);
  });

  test("strips unit suffixes from Elevation, Velocity, Course", () => {
    const pings = parsePings(fixtureKml);
    for (const p of pings) {
      expect(typeof p.alt).toBe("number");
      expect(typeof p.velocityKmh).toBe("number");
      expect(typeof p.courseDeg).toBe("number");
      expect(Number.isFinite(p.alt)).toBe(true);
      expect(Number.isFinite(p.velocityKmh)).toBe(true);
      expect(Number.isFinite(p.courseDeg)).toBe(true);
    }
  });
});
