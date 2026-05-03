import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  storeTrackRecord,
  type TrackSessionRecord,
} from "../src/core/tracking.js";
import { generateTrackNarrative } from "../src/core/narrative.js";
import { chatCompletion } from "../src/adapters/ai/openrouter.js";
import { makeTestEnv } from "./helpers/env.js";

vi.mock("../src/adapters/ai/openrouter.js");

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
      startPlace: "Malibu, CA",
      endPlace: "Malibu, CA",
      env,
    });

    expect(result.title).toBe("PCH and back");
    expect(result.haiku).toContain("\n");
    expect(result.body).toBeDefined();
    const callArgs = vi.mocked(chatCompletion).mock.calls[0][0];
    const sysMsg = callArgs.req.messages.find((m) => m.role === "system");
    expect(sysMsg?.content).toContain("tracking session");
  });
});
