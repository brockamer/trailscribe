import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  storeTrackRecord,
  handleStopTrack,
  type TrackSessionRecord,
} from "../src/core/tracking.js";
import { generateTrackNarrative } from "../src/core/narrative.js";
import { chatCompletion } from "../src/adapters/ai/openrouter.js";
import { makeTestEnv } from "./helpers/env.js";
import { publishTrackPost } from "../src/adapters/publish/github-pages.js";
import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";
import { monthlyTotals } from "../src/core/ledger.js";
import * as mapshareMod from "../src/adapters/location/mapshare.js";
import * as narrativeMod from "../src/core/narrative.js";
import * as publishMod from "../src/adapters/publish/github-pages.js";
import * as geocodeMod from "../src/adapters/location/geocode.js";
import * as weatherMod from "../src/adapters/location/weather.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GarminEvent } from "../src/core/types.js";

vi.mock("../src/adapters/ai/openrouter.js");
vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", () => ({
  sendReply: vi.fn().mockResolvedValue({ count: 1 }),
}));

describe("storeTrackRecord", () => {
  test("writes the record under track:<imei>:<sessionId>", async () => {
    const env = makeTestEnv();
    const record: TrackSessionRecord = {
      sessionId: "deadbeef",
      imei: "300052030374220",
      startedAt: 1730000000000,
      closedAt: 1730003600000,
      closeReason: "stop",
      pingCount: 14,
      distanceKm: 2.5,
      elevationGainM: 40,
      durationSeconds: 3600,
      journalUrl:
        "https://brockamer.github.io/trailscribe-journal/2026/05/02/x.html",
      rawKml: "<kml/>",
    };
    await storeTrackRecord(env, record);
    const raw = await env.TS_TRACKS.get(
      "track:300052030374220:deadbeef",
      "json",
    );
    expect(raw).toEqual(record);
  });
});

describe("generateTrackNarrative", () => {
  beforeEach(() => {
    vi.mocked(chatCompletion).mockReset();
  });

  function makeTestTrackMetrics() {
    return {
      pingCount: 14,
      startedAt: Date.parse("2026-05-02T15:51:30Z"),
      closedAt: Date.parse("2026-05-02T16:24:30Z"),
      durationSeconds: 1980,
      distanceKm: 2.5,
      pace: { avgKmh: 5, p50Kmh: 4, p95Kmh: 12 },
      elevation: { gainM: 35, lossM: 35, minM: 0, maxM: 35 },
      routeShape: "out-and-back" as const,
      activityHint: "mixed" as const,
    };
  }

  test("calls OpenRouter with track system prompt + structured JSON schema", async () => {
    const env = makeTestEnv();
    vi.mocked(chatCompletion).mockResolvedValue({
      id: "x",
      choices: [{
        message: { role: "assistant", content: JSON.stringify({
          title: "PCH and back",
          haiku: "Sand under wet shoes\nWaves take the line we ran past\nBack uphill, sun high",
          body: "A short out-and-back along PCH and the beach.",
        }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    });

    const result = await generateTrackNarrative({
      metrics: makeTestTrackMetrics(),
      startPlace: "Malibu, CA",
      endPlace: "Malibu, CA",
      env,
    });

    expect(result.title).toBe("PCH and back");
    expect(result.haiku).toContain("\n");
    expect(result.body).toBe("A short out-and-back along PCH and the beach.");
    expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 50 });
    const callArgs = vi.mocked(chatCompletion).mock.calls[0][0];
    const sysMsg = callArgs.req.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toContain("tracking session");
  });

  test("throws NarrativeError when LLM returns no content", async () => {
    const env = makeTestEnv();
    vi.mocked(chatCompletion).mockResolvedValue({
      id: "x",
      choices: [{
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    });

    await expect(
      generateTrackNarrative({
        metrics: makeTestTrackMetrics(),
        env,
      }),
    ).rejects.toThrow(/no content/);
  });

  test("throws NarrativeError when LLM returns non-JSON", async () => {
    const env = makeTestEnv();
    vi.mocked(chatCompletion).mockResolvedValue({
      id: "x",
      choices: [{
        message: { role: "assistant", content: "not json at all" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    await expect(
      generateTrackNarrative({
        metrics: makeTestTrackMetrics(),
        env,
      }),
    ).rejects.toThrow(/non-JSON/);
  });

  test("throws NarrativeError when LLM JSON fails schema (missing body)", async () => {
    const env = makeTestEnv();
    vi.mocked(chatCompletion).mockResolvedValue({
      id: "x",
      choices: [{
        message: { role: "assistant", content: JSON.stringify({
          title: "Just a title",
          haiku: "Lines one\nLines two\nLines three",
          // body missing
        }) },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });

    await expect(
      generateTrackNarrative({
        metrics: makeTestTrackMetrics(),
        env,
      }),
    ).rejects.toThrow(/Track narrative failed schema/);
  });
});

describe("publishTrackPost", () => {
  test("commits markdown with type:track frontmatter via existing publishPost path", async () => {
    const env = makeTestEnv();
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        content: { sha: "abc", path: "_posts/2026-05-02-pch.md", html_url: "x" },
        commit: { sha: "deadbeef" },
      }), { status: 200 }));

    const result = await publishTrackPost({
      title: "PCH and back",
      haiku: "a\nb\nc",
      body: "A nice run.",
      metrics: {
        pingCount: 14,
        startedAt: Date.parse("2026-05-02T15:51:30Z"),
        closedAt: Date.parse("2026-05-02T16:24:30Z"),
        durationSeconds: 1980,
        distanceKm: 2.5,
        pace: { avgKmh: 5, p50Kmh: 4, p95Kmh: 12 },
        elevation: { gainM: 35, lossM: 35, minM: 0, maxM: 35 },
        routeShape: "out-and-back",
        activityHint: "mixed",
      },
      endLat: 34.0269,
      endLon: -118.7603,
      startPlace: "Malibu, CA",
      endPlace: "Malibu, CA",
      env,
    });

    expect(result.url).toMatch(/trailscribe-journal/);
    expect(result.path).toContain("2026-05-02");
    expect(result.url).toContain("2026/05/02");
    const putCall = fetchMock.mock.calls[1];
    const body = JSON.parse((putCall[1]?.body ?? "{}") as string);
    const decoded = atob(body.content);
    expect(decoded).toContain("type: track");
    // 2.5 km → 1.55 mi (kmToMi(2.5) = 1.5534...); 35 m → 115 ft (mToFt(35) = 114.83...).
    // See #195 — frontmatter renamed to imperial.
    expect(decoded).toContain("distance_mi: 1.55");
    expect(decoded).toContain("elevation_gain_ft: 115");
    expect(decoded).toContain("route_shape: out-and-back");
    expect(decoded).toContain("start_place: \"Malibu, CA\"");
    expect(decoded).toContain("end_place: \"Malibu, CA\"");
    // Haiku rendered with CommonMark soft-breaks (#195).
    expect(decoded).toContain("a  \nb  \nc");
  });
});

const FIXTURE_KML_E2E = readFileSync(
  resolve(__dirname, "fixtures/mapshare/pch-2026-05-02.kml"),
  "utf8",
);

async function sessionIdFor(imei: string, closedAtMs: number): Promise<string> {
  const buf = new TextEncoder().encode(`${imei}:${closedAtMs}`);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

describe("session start window (#175 follow-up)", () => {
  test("Stop Track uses recordSessionStart's timestamp as d1 instead of the 12h lookback", async () => {
    const env = makeTestEnv();
    const { recordSessionStart } = await import("../src/core/tracking.js");
    const fetchMock = vi.spyOn(mapshareMod, "fetchMapShareKml").mockResolvedValue(FIXTURE_KML_E2E);
    vi.spyOn(narrativeMod, "generateTrackNarrative").mockResolvedValue({
      title: "x", haiku: "a\nb\nc", body: "y",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    vi.spyOn(publishMod, "publishTrackPost").mockResolvedValue({
      url: "https://x", path: "p", sha: "s",
    });

    const startedAt = Date.parse("2026-05-04T22:01:00Z");
    const closedAt = Date.parse("2026-05-04T22:05:00Z");
    await recordSessionStart(env, "300052030374220", startedAt);

    await handleStopTrack(
      { imei: "300052030374220", messageCode: 12, timeStamp: closedAt },
      env,
      "idem-window-1",
    );

    // fetchMapShareKml(env, startedAtMs, closedAtMs) — 4-min window, NOT a 12h lookback.
    const callArgs = fetchMock.mock.calls[0];
    expect(callArgs[1]).toBe(startedAt);
    expect(callArgs[2]).toBe(closedAt);
  });

  test("Stop Track without a recorded start refuses to publish (no lookback fallback)", async () => {
    vi.mocked(sendReply).mockClear();
    const env = makeTestEnv();
    const mapshareSpy = vi.spyOn(mapshareMod, "fetchMapShareKml");
    const narrativeSpy = vi.spyOn(narrativeMod, "generateTrackNarrative");
    const publishSpy = vi.spyOn(publishMod, "publishTrackPost");

    const closedAt = Date.parse("2026-05-04T22:43:45Z");
    await handleStopTrack(
      { imei: "300052030374220", messageCode: 12, timeStamp: closedAt },
      env,
      "idem-no-start",
    );

    // None of the publish-pipeline side effects should fire.
    expect(mapshareSpy).not.toHaveBeenCalled();
    expect(narrativeSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
    // Operator gets the no-active-session SMS reply.
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendReply).mock.calls[0][1][0]).toContain("no active session");
  });

  test("Stop Track clears the start record so the next Stop without a fresh Start uses fallback", async () => {
    const env = makeTestEnv();
    const { recordSessionStart, readSessionStart } = await import("../src/core/tracking.js");
    vi.spyOn(mapshareMod, "fetchMapShareKml").mockResolvedValue(FIXTURE_KML_E2E);
    vi.spyOn(narrativeMod, "generateTrackNarrative").mockResolvedValue({
      title: "x", haiku: "a\nb\nc", body: "y",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    vi.spyOn(publishMod, "publishTrackPost").mockResolvedValue({
      url: "https://x", path: "p", sha: "s",
    });

    await recordSessionStart(env, "300052030374220", Date.parse("2026-05-04T22:00:00Z"));
    expect(await readSessionStart(env, "300052030374220")).not.toBeNull();

    await handleStopTrack(
      { imei: "300052030374220", messageCode: 12, timeStamp: Date.parse("2026-05-04T22:05:00Z") },
      env,
      "idem-clear-1",
    );

    // After successful Stop Track, the start record is gone.
    expect(await readSessionStart(env, "300052030374220")).toBeNull();
  });
});

describe("handleStopTrack — end to end", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(sendReply).mockReset();
    vi.mocked(sendReply).mockResolvedValue({ count: 1 });
  });

  // Helper: seed a fresh mc 10 (Start Track) record before each handleStopTrack
  // invocation, since the production path always requires this — there is no
  // longer a lookback fallback (#175 fix).
  async function seedSessionStart(env: ReturnType<typeof makeTestEnv>, imei: string, atMs: number) {
    const { recordSessionStart } = await import("../src/core/tracking.js");
    await recordSessionStart(env, imei, atMs);
  }

  test("fetches KML, generates narrative, publishes, replies, persists record", async () => {
    const env = makeTestEnv();
    await seedSessionStart(env, "300052030374220", Date.parse("2026-05-02T15:51:30Z"));
    vi.spyOn(mapshareMod, "fetchMapShareKml").mockResolvedValue(FIXTURE_KML_E2E);
    vi.spyOn(geocodeMod, "reverseGeocode")
      .mockResolvedValueOnce("Malibu, CA")  // start
      .mockResolvedValueOnce("Malibu, CA"); // end
    vi.spyOn(weatherMod, "currentWeather").mockResolvedValue("Sunny, 18°C");
    const narrativeSpy = vi.spyOn(narrativeMod, "generateTrackNarrative").mockResolvedValue({
      title: "PCH and back",
      haiku: "a\nb\nc",
      body: "Run + beach + return.",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    const publishSpy = vi.spyOn(publishMod, "publishTrackPost").mockResolvedValue({
      url: "https://brockamer.github.io/trailscribe-journal/2026/05/02/pch.html",
      path: "_posts/2026-05-02-pch.md",
      sha: "abc",
    });

    const stopEvent: GarminEvent = {
      imei: "300052030374220",
      messageCode: 12,
      timeStamp: Date.parse("2026-05-02T16:24:30Z"),
    };

    await handleStopTrack(stopEvent, env, "idem-key-1");

    expect(publishSpy).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledTimes(1);
    const replyArgs = vi.mocked(sendReply).mock.calls[0];
    expect(replyArgs[0]).toBe("300052030374220");
    expect(replyArgs[1][0]).toContain("Track posted");
    expect(replyArgs[1][0]).toContain("trailscribe-journal");

    // F2: assert enrichment values flowed through to narrative
    const narrativeArgs = narrativeSpy.mock.calls[0][0];
    expect(narrativeArgs.startPlace).toBe("Malibu, CA");
    expect(narrativeArgs.endPlace).toBe("Malibu, CA");
    expect(narrativeArgs.weatherSummary).toBe("Sunny, 18°C");

    // F2: assert enrichment values flowed through to publish (F1)
    const publishArgs = publishSpy.mock.calls[0][0];
    expect(publishArgs.startPlace).toBe("Malibu, CA");
    expect(publishArgs.endPlace).toBe("Malibu, CA");

    const sessionId = await sessionIdFor("300052030374220", stopEvent.timeStamp);
    const stored = await env.TS_TRACKS.get(`track:300052030374220:${sessionId}`, "json") as TrackSessionRecord;
    expect(stored).not.toBeNull();
    expect(stored.pingCount).toBe(14);
    expect(stored.journalUrl).toBe("https://brockamer.github.io/trailscribe-journal/2026/05/02/pch.html");

    // #173: LLM cost records under by_command.track (not .post) so !cost can
    // disaggregate publish-class commands.
    const ledger = await monthlyTotals(env);
    expect(ledger.by_command.track).toMatchObject({ requests: 1 });
    expect(ledger.by_command.post).toBeUndefined();
  });

  test("empty KML: logs warning, sends 'no breadcrumbs' reply, no publish", async () => {
    const env = makeTestEnv();
    const closedAt = Date.now();
    await seedSessionStart(env, "300052030374220", closedAt - 5 * 60 * 1000);
    vi.spyOn(mapshareMod, "fetchMapShareKml").mockResolvedValue("<kml/>");
    const publishSpy = vi.spyOn(publishMod, "publishTrackPost");

    await handleStopTrack(
      { imei: "300052030374220", messageCode: 12, timeStamp: closedAt },
      env,
      "idem-key-2",
    );

    expect(publishSpy).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendReply).mock.calls[0][1][0]).toContain("no breadcrumbs");
  });

  test("single-ping KML: sends 'too brief' reply, no publish, no narrative (#197)", async () => {
    const env = makeTestEnv();
    const closedAt = Date.now();
    await seedSessionStart(env, "300052030374220", closedAt - 5 * 60 * 1000);

    // Minimal one-Placemark KML — mirrors the Garmin MapShare share-page shape
    // that produced the ghost-post bug (Session 1 on 2026-05-17: pingCount=1,
    // distance=0, but a real per-ping velocity that flowed through to the LLM
    // as a defensible-but-meaningless "drive at 65.6 mph" narrative).
    const singlePingKml = `<?xml version="1.0"?>
<kml><Document><Placemark>
  <TimeStamp><when>2026-05-18T03:09:30Z</when></TimeStamp>
  <ExtendedData>
    <Data name="Latitude"><value>34.02767</value></Data>
    <Data name="Longitude"><value>-118.75931</value></Data>
    <Data name="Elevation"><value>40.92 m</value></Data>
    <Data name="Velocity"><value>65.5 km/h</value></Data>
    <Data name="Course"><value>247.5</value></Data>
    <Data name="Valid GPS Fix"><value>True</value></Data>
  </ExtendedData>
</Placemark></Document></kml>`;

    vi.spyOn(mapshareMod, "fetchMapShareKml").mockResolvedValue(singlePingKml);
    const publishSpy = vi.spyOn(publishMod, "publishTrackPost");
    const narrativeSpy = vi.spyOn(narrativeMod, "generateTrackNarrative");

    await handleStopTrack(
      { imei: "300052030374220", messageCode: 12, timeStamp: closedAt },
      env,
      "idem-key-too-brief",
    );

    expect(narrativeSpy).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledTimes(1);
    const reply = vi.mocked(sendReply).mock.calls[0][1][0];
    expect(reply).toContain("Track too brief");
    expect(reply).toContain("1 breadcrumb");
    // Reply must fit Garmin's 160-char Iridium limit
    expect(reply.length).toBeLessThanOrEqual(160);
  });

  test("inner-LLM checkpoint: narrative cached when publish fails, re-run avoids fresh LLM call (#172)", async () => {
    const env = makeTestEnv();
    await seedSessionStart(env, "300052030374220", Date.parse("2026-05-02T15:51:30Z"));
    vi.spyOn(mapshareMod, "fetchMapShareKml").mockResolvedValue(FIXTURE_KML_E2E);
    vi.spyOn(geocodeMod, "reverseGeocode")
      .mockResolvedValue("Malibu, CA");
    vi.spyOn(weatherMod, "currentWeather").mockResolvedValue("Sunny, 18°C");
    const narrativeSpy = vi.spyOn(narrativeMod, "generateTrackNarrative").mockResolvedValue({
      title: "PCH and back",
      haiku: "a\nb\nc",
      body: "Run + beach + return.",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    // First publish call throws (e.g. journal PAT expired); second succeeds.
    const publishSpy = vi.spyOn(publishMod, "publishTrackPost")
      .mockRejectedValueOnce(new Error("403 Bad credentials"))
      .mockResolvedValueOnce({
        url: "https://brockamer.github.io/trailscribe-journal/2026/05/02/pch.html",
        path: "_posts/2026-05-02-pch.md",
        sha: "abc",
      });

    const stopEvent: GarminEvent = {
      imei: "300052030374220",
      messageCode: 12,
      timeStamp: Date.parse("2026-05-02T16:24:30Z"),
    };

    // First call: narrative succeeds, publish throws → outer checkpoint
    // doesn't cache `publish_track`, but inner `track_narrative` IS cached.
    await expect(handleStopTrack(stopEvent, env, "idem-cost-bound")).rejects.toThrow(/Bad credentials/);
    expect(narrativeSpy).toHaveBeenCalledTimes(1);
    expect(publishSpy).toHaveBeenCalledTimes(1);

    // Second call (Garmin retry): narrative cache hit → LLM NOT re-called;
    // publish runs again and succeeds this time.
    await handleStopTrack(stopEvent, env, "idem-cost-bound");
    expect(narrativeSpy).toHaveBeenCalledTimes(1); // <-- the bound: still 1, not 2
    expect(publishSpy).toHaveBeenCalledTimes(2);
    expect(sendReply).toHaveBeenCalledTimes(1);
  });

  test("idempotent on replay: second handleStopTrack call short-circuits", async () => {
    const env = makeTestEnv();
    await seedSessionStart(env, "300052030374220", Date.parse("2026-05-02T15:51:30Z"));
    vi.spyOn(mapshareMod, "fetchMapShareKml").mockResolvedValue(FIXTURE_KML_E2E);
    vi.spyOn(narrativeMod, "generateTrackNarrative").mockResolvedValue({
      title: "x", haiku: "a\nb\nc", body: "y",
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const publishSpy = vi.spyOn(publishMod, "publishTrackPost").mockResolvedValue({
      url: "https://x", path: "p", sha: "s",
    });

    const event: GarminEvent = {
      imei: "300052030374220",
      messageCode: 12,
      timeStamp: Date.parse("2026-05-02T16:24:30Z"),
    };

    const { writeRecord } = await import("../src/core/idempotency.js");
    await writeRecord(env, "idem-replay", { status: "received", receivedAt: Date.now() });

    await handleStopTrack(event, env, "idem-replay");
    await handleStopTrack(event, env, "idem-replay");

    expect(publishSpy).toHaveBeenCalledTimes(1);
  });
});
