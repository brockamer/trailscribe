import { describe, test, expect, vi, beforeEach } from "vitest";
import {
  storeTrackRecord,
  type TrackSessionRecord,
} from "../src/core/tracking.js";
import { generateTrackNarrative } from "../src/core/narrative.js";
import { chatCompletion } from "../src/adapters/ai/openrouter.js";
import { makeTestEnv } from "./helpers/env.js";
import { publishTrackPost } from "../src/adapters/publish/github-pages.js";

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
    expect(decoded).toContain("distance_km: 2.5");
    expect(decoded).toContain("route_shape: out-and-back");
  });
});
