import { describe, expect, test } from "vitest";

import { buildReply, SMS_MAX } from "../src/core/reply.js";
import type { Env } from "../src/env.js";
import { makeTestEnv } from "./helpers/env.js";

function envWith(overrides: Partial<Env> = {}): Env {
  return makeTestEnv({
    APPEND_COST_SUFFIX: "false",
    ...overrides,
  });
}

describe("buildReply — single page", () => {
  test("short body, no cost suffix → 1 page, body verbatim", () => {
    const out = buildReply({ body: "pong", env: envWith() });
    expect(out).toEqual(["pong"]);
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

describe("buildReply — no map links on device", () => {
  test("never emits Google Maps URL regardless of body content", () => {
    const out = buildReply({
      body: "Lake Sabrina basin, granite walls glowing in alpenglow at sunset.",
      env: envWith(),
    });
    const joined = out.join(" ");
    expect(joined).not.toContain("google.com/maps");
    expect(joined).not.toContain("share.garmin.com");
  });

  test("never emits MapShare URL even when MAPSHARE_BASE is set", () => {
    const out = buildReply({
      body: "ok",
      env: envWith({ MAPSHARE_BASE: "https://share.garmin.com/MyMap" }),
    });
    expect(out.join(" ")).not.toContain("share.garmin.com");
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

  test("body + cost suffix overflow → 2 pages, suffix on last page", () => {
    const body = "Lake Sabrina basin, granite walls glowing in alpenglow at sunset.".repeat(3);
    const out = buildReply({
      body,
      costUsdMtd: 0.42,
      env: envWith({ APPEND_COST_SUFFIX: "true" }),
    });

    expect(out).toHaveLength(2);
    expect(out[1]).toContain("· $0.42");
    expect(out[0]).not.toContain("· $");
    expect(out[0].length).toBeLessThanOrEqual(SMS_MAX);
    expect(out[1].length).toBeLessThanOrEqual(SMS_MAX);
  });
});

describe("buildReply — overflow handling (body too long, suffix preserved)", () => {
  test("very long body with cost suffix → body truncated, suffix + markers preserved", () => {
    const body = "Z".repeat(400);
    const out = buildReply({
      body,
      costUsdMtd: 0.99,
      env: envWith({ APPEND_COST_SUFFIX: "true" }),
    });

    expect(out).toHaveLength(2);
    expect(out[0].endsWith("(1/2)")).toBe(true);
    expect(out[1].endsWith("(2/2)")).toBe(true);
    expect(out[1]).toContain("· $0.99");
    expect(out[0].length).toBeLessThanOrEqual(SMS_MAX);
    expect(out[1].length).toBeLessThanOrEqual(SMS_MAX);
  });
});

describe("buildReply — assertion guard", () => {
  test("each output page is ≤ 160 across a range of input sizes", () => {
    for (let n = 0; n <= 400; n += 7) {
      const body = "b".repeat(n);
      for (const costOn of [false, true]) {
        const out = buildReply({
          body,
          costUsdMtd: costOn ? 0.12 : undefined,
          env: envWith({ APPEND_COST_SUFFIX: costOn ? "true" : "false" }),
        });
        for (const page of out) {
          expect(page.length).toBeLessThanOrEqual(SMS_MAX);
        }
      }
    }
  });
});
