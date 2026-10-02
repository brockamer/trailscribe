import { describe, expect, test } from "vitest";

import { localTimeOfDay } from "../src/core/localtime.js";

describe("localTimeOfDay — civil time when the UTC offset is known (#274)", () => {
  test("the 2026-10-02 Malibu bare !postimg: 10:28Z at UTC−7 (PDT) is 03:28 — night", () => {
    // Device timeStamp 1790936886000. Mean solar time said 02:33 — an hour early.
    const r = localTimeOfDay(1790936886000, -118.76, {
      utcOffsetSeconds: -25200,
      sunrise: "06:50",
      sunset: "18:37",
    });
    expect(r).toEqual({ text: "03:28 — night", isNight: true, clockKnown: true });
  });

  test("offset 0 is a real offset (Reykjavik), not a missing one", () => {
    const r = localTimeOfDay(Date.UTC(2026, 9, 2, 14, 5), -21.94, { utcOffsetSeconds: 0 });
    expect(r).toEqual({ text: "14:05 — afternoon", isNight: false, clockKnown: true });
  });

  test("sunrise/sunset decide night: 18:45 after an 18:37 sunset is night", () => {
    const r = localTimeOfDay(Date.UTC(2026, 9, 3, 1, 45), -118.76, {
      utcOffsetSeconds: -25200,
      sunrise: "06:50",
      sunset: "18:37",
    });
    expect(r).toEqual({ text: "18:45 — night", isNight: true, clockKnown: true });
  });

  test("sunrise/sunset decide day: 06:55 after a 06:50 sunrise is not night", () => {
    const r = localTimeOfDay(Date.UTC(2026, 9, 2, 13, 55), -118.76, {
      utcOffsetSeconds: -25200,
      sunrise: "06:50",
      sunset: "18:37",
    });
    expect(r).toEqual({ text: "06:55 — early morning", isNight: false, clockKnown: true });
  });

  test("the sun overrides the night band: 22:30 in a Reykjavik June with sunset 23:58 is evening", () => {
    const r = localTimeOfDay(Date.UTC(2026, 5, 20, 22, 30), -21.94, {
      utcOffsetSeconds: 0,
      sunrise: "02:55",
      sunset: "23:58",
    });
    expect(r).toEqual({ text: "22:30 — evening", isNight: false, clockKnown: true });
  });

  test("without sunrise/sunset the clock bands decide night", () => {
    const r = localTimeOfDay(Date.UTC(2026, 9, 2, 10, 28), -118.76, { utcOffsetSeconds: -25200 });
    expect(r).toEqual({ text: "03:28 — night", isNight: true, clockKnown: true });
  });

  test("band edges: 04:59 night, 05:00 early morning, 19:59 evening, 20:00 night", () => {
    const at = (h: number, m: number) =>
      localTimeOfDay(Date.UTC(2026, 0, 1, h, m), 0, { utcOffsetSeconds: 0 }).text;
    expect(at(4, 59)).toBe("04:59 — night");
    expect(at(5, 0)).toBe("05:00 — early morning");
    expect(at(19, 59)).toBe("19:59 — evening");
    expect(at(20, 0)).toBe("20:00 — night");
  });
});

describe("localTimeOfDay — period only when no offset is known (#274)", () => {
  test("mean solar time picks the period; no clock time is given", () => {
    // 05:17Z at 120°W is 21:17 mean solar — night (the #240 Malibu case).
    const r = localTimeOfDay(Date.UTC(2026, 8, 16, 5, 17), -120);
    expect(r).toEqual({ text: "night", isNight: true, clockKnown: false });
  });

  test("midday is not night", () => {
    const r = localTimeOfDay(Date.UTC(2026, 8, 15, 12, 0), 0);
    expect(r).toEqual({ text: "midday", isNight: false, clockKnown: false });
  });
});
