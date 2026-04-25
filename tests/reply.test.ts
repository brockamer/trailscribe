import { describe, expect, test } from "vitest";

import { buildReply, SMS_MAX } from "../src/core/reply.js";
import type { Env } from "../src/env.js";
import { makeTestEnv } from "./helpers/env.js";

const LAT = 37.1682;
const LON = -118.5891;

function envWith(overrides: Partial<Env> = {}): Env {
  return makeTestEnv({
    GOOGLE_MAPS_BASE: "https://www.google.com/maps/search/?api=1&query=",
    MAPSHARE_BASE: "https://share.garmin.com/MyMap",
    APPEND_COST_SUFFIX: "false",
    ...overrides,
  });
}

describe("buildReply — single page", () => {
  test("short body, no GPS, no cost suffix → 1 page, body verbatim", () => {
    const out = buildReply({ body: "pong", env: envWith() });
    expect(out).toEqual(["pong"]);
  });

  test("body + GPS links fit ≤ 160 → 1 page with both links appended", () => {
    const out = buildReply({ body: "ok", lat: LAT, lon: LON, env: envWith() });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("ok");
    expect(out[0]).toContain("https://www.google.com/maps/search/?api=1&query=37.1682,-118.5891");
    expect(out[0]).toContain("https://share.garmin.com/MyMap?d=37.1682,-118.5891");
    expect(out[0].length).toBeLessThanOrEqual(SMS_MAX);
  });

  test("APPEND_COST_SUFFIX=true with costUsdMtd → suffix appended", () => {
    const out = buildReply({
      body: "pong",
      costUsdMtd: 0.05,
      env: envWith({ APPEND_COST_SUFFIX: "true" }),
    });
    expect(out).toEqual(["pong · $0.05"]);
  });

  test("APPEND_COST_SUFFIX=false but costUsdMtd provided → suffix NOT emitted", () => {
    const out = buildReply({
      body: "pong",
      costUsdMtd: 0.05,
      env: envWith({ APPEND_COST_SUFFIX: "false" }),
    });
    expect(out).toEqual(["pong"]);
  });

  test("APPEND_COST_SUFFIX=true but costUsdMtd undefined → no suffix", () => {
    const out = buildReply({
      body: "pong",
      env: envWith({ APPEND_COST_SUFFIX: "true" }),
    });
    expect(out).toEqual(["pong"]);
  });
});

describe("buildReply — GPS absence", () => {
  test("lat/lon undefined → no map link, NO `?q=0,0` placeholder", () => {
    const out = buildReply({ body: "no fix yet", env: envWith() });
    expect(out).toEqual(["no fix yet"]);
    expect(out[0]).not.toContain("?q=");
    expect(out[0]).not.toContain("?api=1");
    expect(out[0]).not.toContain("share.garmin.com");
  });

  test("only one of lat/lon provided → treated as no GPS", () => {
    // Both fields are optional in the type; this asserts the runtime guard.
    const out = buildReply({ body: "x", lat: LAT, env: envWith() });
    expect(out).toEqual(["x"]);
  });
});

describe("buildReply — MapShare gating", () => {
  test("MAPSHARE_BASE empty → only Google Maps link emitted", () => {
    const out = buildReply({
      body: "ok",
      lat: LAT,
      lon: LON,
      env: envWith({ MAPSHARE_BASE: "" }),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("https://www.google.com/maps");
    expect(out[0]).not.toContain("share.garmin.com");
  });
});

describe("buildReply — two-page paging", () => {
  test("body 200 chars → split into two pages with (1/2)/(2/2) markers", () => {
    const body = "x".repeat(200);
    const out = buildReply({ body, env: envWith() });

    expect(out).toHaveLength(2);
    expect(out[0].endsWith("(1/2)")).toBe(true);
    expect(out[1].endsWith("(2/2)")).toBe(true);
    expect(out[0].length).toBeLessThanOrEqual(SMS_MAX);
    expect(out[1].length).toBeLessThanOrEqual(SMS_MAX);

    // Reassembled body (minus markers) preserves all 200 characters.
    const reassembled = out[0].slice(0, -5) + out[1].slice(0, -5);
    expect(reassembled).toBe(body);
  });

  test("body + GPS links overflow 160 → 2 pages, links on page 2", () => {
    const body = "Lake Sabrina basin, granite walls glowing in alpenglow at sunset.";
    const out = buildReply({ body, lat: LAT, lon: LON, env: envWith() });

    expect(out).toHaveLength(2);
    expect(out[0]).not.toContain("google.com");
    expect(out[1]).toContain("https://www.google.com/maps");
    expect(out[1]).toContain("https://share.garmin.com/MyMap");
    expect(out[0].length).toBeLessThanOrEqual(SMS_MAX);
    expect(out[1].length).toBeLessThanOrEqual(SMS_MAX);
  });

  test("body + GPS + cost suffix → 2 pages, both extras land on last page", () => {
    const body = "Lake Sabrina basin, granite walls glowing in alpenglow at sunset.";
    const out = buildReply({
      body,
      lat: LAT,
      lon: LON,
      costUsdMtd: 0.42,
      env: envWith({ APPEND_COST_SUFFIX: "true" }),
    });

    expect(out).toHaveLength(2);
    expect(out[1]).toContain("google.com");
    expect(out[1]).toContain("· $0.42");
    expect(out[0].length).toBeLessThanOrEqual(SMS_MAX);
    expect(out[1].length).toBeLessThanOrEqual(SMS_MAX);
  });
});

describe("buildReply — overflow handling (body too long, extras preserved)", () => {
  test("very long body with GPS + cost suffix → body truncated, extras + markers preserved", () => {
    const body = "Z".repeat(400);
    const out = buildReply({
      body,
      lat: LAT,
      lon: LON,
      costUsdMtd: 0.99,
      env: envWith({ APPEND_COST_SUFFIX: "true" }),
    });

    expect(out).toHaveLength(2);
    expect(out[0].endsWith("(1/2)")).toBe(true);
    expect(out[1].endsWith("(2/2)")).toBe(true);
    // Extras preserved verbatim on page 2.
    expect(out[1]).toContain("https://www.google.com/maps");
    expect(out[1]).toContain("https://share.garmin.com/MyMap");
    expect(out[1]).toContain("· $0.99");
    expect(out[0].length).toBeLessThanOrEqual(SMS_MAX);
    expect(out[1].length).toBeLessThanOrEqual(SMS_MAX);

    // Body was truncated (we lost some Z's at the tail).
    const reassembledBody = out[0].slice(0, -5) + out[1].slice(0, out[1].lastIndexOf(" "));
    expect(reassembledBody.length).toBeLessThan(400);
    expect(reassembledBody.startsWith("Z")).toBe(true);
  });

  test("body fits page 1 exactly (155 chars) + extras → page 2 has no leading double-space", () => {
    // 155 chars body fills page 1 exactly; remainder is empty so the leading
    // space on the maps tail must be stripped.
    const body = "a".repeat(155);
    const out = buildReply({ body, lat: LAT, lon: LON, env: envWith() });

    expect(out).toHaveLength(2);
    expect(out[0]).toBe("a".repeat(155) + "(1/2)");
    expect(out[1]).not.toMatch(/^\s/);
    expect(out[1].startsWith("https://")).toBe(true);
    expect(out[1].endsWith("(2/2)")).toBe(true);
  });
});

describe("buildReply — assertion guard", () => {
  test("each output page is ≤ 160 across a range of input sizes", () => {
    // Property-style spot-check: body lengths 0..400 step 7, with + without GPS.
    for (let n = 0; n <= 400; n += 7) {
      const body = "b".repeat(n);
      for (const gps of [false, true]) {
        const out = buildReply({
          body,
          lat: gps ? LAT : undefined,
          lon: gps ? LON : undefined,
          env: envWith(),
        });
        for (const page of out) {
          expect(page.length).toBeLessThanOrEqual(SMS_MAX);
        }
      }
    }
  });
});
