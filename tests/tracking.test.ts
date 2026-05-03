import { describe, test, expect } from "vitest";
import {
  storeTrackRecord,
  type TrackSessionRecord,
} from "../src/core/tracking.js";
import { makeTestEnv } from "./helpers/env.js";

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
