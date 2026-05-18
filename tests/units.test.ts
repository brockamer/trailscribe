import { describe, expect, test } from "vitest";

import { formatHaiku, kmhToMph, kmToMi, mToFt } from "../src/core/units.js";

describe("units — metric → imperial conversions", () => {
  test("kmToMi: 1 km is ~0.621371 mi", () => {
    expect(kmToMi(1)).toBeCloseTo(0.621371, 6);
  });

  test("kmToMi: 611.984 km (Pinal→Redlands fixture) ≈ 380.27 mi", () => {
    expect(kmToMi(611.984)).toBeCloseTo(380.27, 2);
  });

  test("kmToMi: 0 → 0", () => {
    expect(kmToMi(0)).toBe(0);
  });

  test("mToFt: 1 m is ~3.28084 ft", () => {
    expect(mToFt(1)).toBeCloseTo(3.28084, 5);
  });

  test("mToFt: 2336.35 m (Pinal→Redlands fixture) ≈ 7665 ft", () => {
    expect(Math.round(mToFt(2336.35))).toBe(7665);
  });

  test("kmhToMph: 100 km/h ≈ 62.14 mph", () => {
    expect(kmhToMph(100)).toBeCloseTo(62.1371, 4);
  });
});

describe("formatHaiku — single-string → CommonMark soft-break-separated lines", () => {
  test("three-line haiku gets two-trailing-spaces between lines", () => {
    expect(formatHaiku("First line\nSecond line\nThird line")).toBe(
      "First line  \nSecond line  \nThird line",
    );
  });

  test("preserves leading/trailing whitespace within each line", () => {
    expect(formatHaiku("a\n b \nc")).toBe("a  \n b   \nc");
  });

  test("single line (degenerate) returns unchanged", () => {
    expect(formatHaiku("just one")).toBe("just one");
  });

  test("empty string returns empty", () => {
    expect(formatHaiku("")).toBe("");
  });

  test("does not append two spaces to the final line (would be a trailing-whitespace lint issue in some configs)", () => {
    const out = formatHaiku("a\nb\nc");
    expect(out.endsWith("c")).toBe(true);
    expect(out.endsWith("  ")).toBe(false);
  });
});
