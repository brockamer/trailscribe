import { describe, expect, test } from "vitest";

import { buildReply, JOURNAL_LIVE_HINT, SMS_MAX } from "../src/core/reply.js";
import { slugify } from "../src/adapters/publish/github-pages.js";
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
      env: envWith({ MAPSHARE_BASE: "https://share.garmin.com" }),
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

/**
 * #249 — a journal URL must reach the device whole, in one SMS, with a hint
 * that the page is not live until GitHub Pages finishes building (30–143 s).
 * Worst case: a 60-char narrative title slugs to 50 chars, plus the `-10`
 * collision suffix from `findFreePath`, under the production URL template —
 * 117 chars of URL.
 */
describe("buildReply — journal link (#249)", () => {
  const LONG_TITLE = "Alpenglow over the Sawtooth crest after a long, cold climb!";
  const WORST_URL = `https://brockamer.github.io/trailscribe-journal/2026/09/27/${slugify(LONG_TITLE, new Date(0))}-10.html`;
  const SHORT_URL = "https://brockamer.github.io/trailscribe-journal/2026/09/27/fog.html";

  /** The URL appears whole in exactly one page, and is never cut by a marker. */
  function expectUrlIntact(pages: string[], url: string): void {
    expect(pages.filter((p) => p.includes(url))).toHaveLength(1);
  }

  test("worst-case URL is 117 chars (guards the arithmetic below)", () => {
    expect(LONG_TITLE.length).toBeLessThanOrEqual(60);
    expect(WORST_URL.length).toBe(117);
  });

  test("short body + short URL → one page: body, URL on its own line, live hint", () => {
    const out = buildReply({ body: "Posted: Fog", journalUrl: SHORT_URL, env: envWith() });
    expect(out).toEqual([`Posted: Fog\n${SHORT_URL}${JOURNAL_LIVE_HINT}`]);
  });

  test("worst-case title + URL → two pages, URL whole on the last page with the hint", () => {
    const out = buildReply({
      body: `Posted: ${LONG_TITLE}`,
      journalUrl: WORST_URL,
      env: envWith(),
    });
    expect(out).toHaveLength(2);
    for (const page of out) expect(page.length).toBeLessThanOrEqual(SMS_MAX);
    expectUrlIntact(out, WORST_URL);
    expect(out[0]).toBe(`Posted: ${LONG_TITLE}(1/2)`);
    expect(out[1]).toBe(`${WORST_URL}${JOURNAL_LIVE_HINT}(2/2)`);
  });

  test("worst case with the cost suffix on: every page fits, suffix on the last page", () => {
    const out = buildReply({
      body: `Posted: ${LONG_TITLE}`,
      journalUrl: WORST_URL,
      costUsdMtd: 12.34,
      env: envWith({ APPEND_COST_SUFFIX: "true" }),
    });
    for (const page of out) expect(page.length).toBeLessThanOrEqual(SMS_MAX);
    expectUrlIntact(out, WORST_URL);
    expect(out[out.length - 1]).toContain(JOURNAL_LIVE_HINT);
    expect(out[out.length - 1]).toContain("· $12.34");
  });

  test("!postimg no-image note in the body survives the worst case", () => {
    const body = `Posted: ${LONG_TITLE} (no image — retry !postimg)`;
    const out = buildReply({ body, journalUrl: WORST_URL, env: envWith() });
    for (const page of out) expect(page.length).toBeLessThanOrEqual(SMS_MAX);
    expectUrlIntact(out, WORST_URL);
    expect(out.join("")).toContain("(no image — retry !postimg)");
  });

  test("an over-long body is truncated on page 1; the URL page is untouched", () => {
    const out = buildReply({ body: "x".repeat(400), journalUrl: WORST_URL, env: envWith() });
    expect(out).toHaveLength(2);
    expect(out[0].length).toBe(SMS_MAX);
    expect(out[1]).toBe(`${WORST_URL}${JOURNAL_LIVE_HINT}(2/2)`);
  });

  test("no journalUrl → behaviour unchanged (no hint)", () => {
    expect(buildReply({ body: "pong", env: envWith() })).toEqual(["pong"]);
  });
});

/**
 * #261 — `links` are atomic, the same rule as the journal URL. Worst case is a
 * `!where` reply: a 60-char place name (`MAX_NAME_LENGTH` in geocode.ts), a
 * Maps URL with 38 chars of full-precision coordinates, and the MapShare URL.
 */
describe("buildReply — atomic links (#261)", () => {
  const NAME_60 = "N".repeat(52) + ", Calif.";
  const MAPS =
    "https://www.google.com/maps/search/?api=1&query=-34.130980971234564,-118.7622714123456";
  const MAPSHARE = "https://share.garmin.com/trailscribe";

  function expectLinksIntact(pages: string[], links: string[]): void {
    for (const link of links) expect(pages.filter((p) => p.includes(link))).toHaveLength(1);
  }

  test("worst-case inputs have the lengths the issue measured", () => {
    expect(NAME_60.length).toBe(60);
    expect(MAPS.length).toBe(48 + 38);
    expect(MAPSHARE.length).toBe(36);
  });

  test("short body + links → one page: body, links on their own line", () => {
    const out = buildReply({
      body: "Lake Sabrina, California",
      links: [MAPS, MAPSHARE],
      env: envWith(),
    });
    expect(out).toEqual([`Lake Sabrina, California\n${MAPS} ${MAPSHARE}`]);
  });

  test("worst case → two pages; no link is cut and no marker sits inside one", () => {
    const out = buildReply({ body: NAME_60, links: [MAPS, MAPSHARE], env: envWith() });
    expect(out).toEqual([`${NAME_60}(1/2)`, `${MAPS} ${MAPSHARE}(2/2)`]);
    expectLinksIntact(out, [MAPS, MAPSHARE]);
  });

  test("worst case with the cost suffix on: every page fits, links whole", () => {
    const out = buildReply({
      body: NAME_60,
      links: [MAPS, MAPSHARE],
      costUsdMtd: 12.34,
      env: envWith({ APPEND_COST_SUFFIX: "true" }),
    });
    for (const page of out) expect(page.length).toBeLessThanOrEqual(SMS_MAX);
    expectLinksIntact(out, [MAPS, MAPSHARE]);
    expect(out[out.length - 1]).toBe(`${MAPS} ${MAPSHARE} · $12.34(2/2)`);
  });

  test("links that cannot share a page are dropped whole, from the end, never split", () => {
    const longShare = `https://share.garmin.com/${"k".repeat(60)}`;
    const out = buildReply({ body: NAME_60, links: [MAPS, longShare], env: envWith() });
    for (const page of out) expect(page.length).toBeLessThanOrEqual(SMS_MAX);
    expectLinksIntact(out, [MAPS]);
    expect(out.join("")).not.toContain("kkkk");
  });

  test("no link fits → page 2 is the cost suffix alone, with no leading space", () => {
    const out = buildReply({
      body: NAME_60,
      links: [`https://x.test/${"y".repeat(150)}`],
      costUsdMtd: 1,
      env: envWith({ APPEND_COST_SUFFIX: "true" }),
    });
    expect(out[1]).toBe("· $1.00(2/2)");
  });

  test("journalUrl and links together: journal URL first, with its hint", () => {
    const out = buildReply({
      body: "Posted: Fog",
      journalUrl: "https://example.test/fog.html",
      links: [MAPSHARE],
      env: envWith(),
    });
    expect(out).toEqual([
      `Posted: Fog\nhttps://example.test/fog.html${JOURNAL_LIVE_HINT} ${MAPSHARE}`,
    ]);
  });

  test("empty links → behaviour unchanged", () => {
    expect(buildReply({ body: "pong", links: [], env: envWith() })).toEqual(["pong"]);
  });
});
