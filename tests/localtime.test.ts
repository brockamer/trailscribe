import { describe, expect, test } from "vitest";

import { approximateLocalTime } from "../src/core/localtime.js";

describe("approximateLocalTime — mean solar time from longitude", () => {
  test("the 2026-09-15 Malibu bare !postimg (#240): 05:17Z at 120°W is 21:17 — night", () => {
    const r = approximateLocalTime(Date.UTC(2026, 8, 16, 5, 17), -120);
    expect(r).toEqual({ text: "21:17 — night", isNight: true });
  });

  test("midday is not night", () => {
    const r = approximateLocalTime(Date.UTC(2026, 8, 15, 12, 0), 0);
    expect(r).toEqual({ text: "12:00 — midday", isNight: false });
  });

  test("band edges: 04:59 night, 05:00 early morning, 19:59 evening, 20:00 night", () => {
    expect(approximateLocalTime(Date.UTC(2026, 0, 1, 4, 59), 0).text).toBe("04:59 — night");
    expect(approximateLocalTime(Date.UTC(2026, 0, 1, 5, 0), 0).text).toBe("05:00 — early morning");
    expect(approximateLocalTime(Date.UTC(2026, 0, 1, 19, 59), 0).text).toBe("19:59 — evening");
    expect(approximateLocalTime(Date.UTC(2026, 0, 1, 20, 0), 0).text).toBe("20:00 — night");
  });
});
