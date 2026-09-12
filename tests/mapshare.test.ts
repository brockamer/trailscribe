import { describe, test, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePings, fetchMapShareKml, MapShareError } from "../src/adapters/location/mapshare.js";
import { makeTestEnv } from "./helpers/env.js";

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

describe("fetchMapShareKml", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test("composes the URL from MAPSHARE_BASE + MAPSHARE_KEY + ISO timestamps", async () => {
    const env = makeTestEnv();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<kml/>", { status: 200 }));
    await fetchMapShareKml(
      env,
      Date.parse("2026-05-02T15:00:00Z"),
      Date.parse("2026-05-02T17:00:00Z"),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe(
      "https://share.garmin.com/Feed/Share/trailscribe?d1=2026-05-02T15:00:00.000Z&d2=2026-05-02T17:00:00.000Z",
    );
    // Regression for #177: MAPSHARE_BASE must not include the per-tenant slug.
    // PR #167 set it to "share.garmin.com/trailscribe" which produced
    // ".../trailscribe/Feed/Share/trailscribe" — Garmin returned 404.
    expect(calledUrl).not.toMatch(/\/trailscribe\/Feed\/Share\/trailscribe/);
  });

  test("returns the response body on 200", async () => {
    const env = makeTestEnv();
    const expectedBody = "<kml>payload</kml>";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(expectedBody, { status: 200 }));
    const body = await fetchMapShareKml(env, 0, 1);
    expect(body).toBe(expectedBody);
  });

  test("throws MapShareError on non-200 status", async () => {
    const env = makeTestEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    await expect(fetchMapShareKml(env, 0, 1)).rejects.toBeInstanceOf(MapShareError);
  });

  test("MapShareError exposes status code", async () => {
    const env = makeTestEnv();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("server error", { status: 503 }));
    try {
      await fetchMapShareKml(env, 0, 1);
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MapShareError);
      expect((e as MapShareError).status).toBe(503);
    }
  });

  test("MAPSHARE_PASSWORD empty: no Authorization header sent", async () => {
    const env = makeTestEnv({ MAPSHARE_PASSWORD: "" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<kml/>", { status: 200 }));
    await fetchMapShareKml(env, 0, 1);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBeUndefined();
    expect(headers?.Accept).toBe("application/vnd.google-earth.kml+xml");
  });

  test("MAPSHARE_PASSWORD set: sends Basic Auth with empty user + password (#175)", async () => {
    const env = makeTestEnv({ MAPSHARE_PASSWORD: "headquarters" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("<kml/>", { status: 200 }));
    await fetchMapShareKml(env, 0, 1);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    // Basic <base64(":headquarters")> = Basic OmhlYWRxdWFydGVycw==
    expect(headers.Authorization).toBe(`Basic ${btoa(":headquarters")}`);
  });
});
