import { describe, test, expect } from "vitest";
import { haversineKm } from "../src/core/track-metrics.js";

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
