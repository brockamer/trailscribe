import { describe, test, expect } from "vitest";
import { buildImagePrompt } from "../src/core/imageprompt.js";

describe("buildImagePrompt — determinism", () => {
  test("same inputs produce identical strings", () => {
    const inputs = {
      caption: "dawn light on the cirque",
      place: "Sierra Nevada, CA",
      lat: 37.1682,
      lon: -118.5891,
      altitudeM: 3810,
      localTime: "07:42 — early morning",
      weather: "scattered clouds, 9C, light wind",
    };
    expect(buildImagePrompt(inputs)).toBe(buildImagePrompt(inputs));
  });
});

describe("buildImagePrompt — telemetry profile snapshots", () => {
  test("alpine profile (full telemetry)", () => {
    expect(
      buildImagePrompt({
        caption: "dawn light on the cirque",
        place: "Sierra Nevada, CA",
        lat: 37.1682,
        lon: -118.5891,
        altitudeM: 3810,
        localTime: "07:42 — early morning",
        weather: "scattered clouds, 9C, light wind",
      }),
    ).toMatchInlineSnapshot(
      `"Photographic field journal illustration: dawn light on the cirque. Location: Sierra Nevada, CA. Coordinates: 37.1682, -118.5891. Altitude: 3810 m. Local time: 07:42 — early morning. Weather: scattered clouds, 9C, light wind. Realistic, plausible scene grounded in the telemetry above. Lighting and shadows match the local time of day. No text, captions, watermarks, signs, or readable lettering anywhere in the image. Do not invent or label specific named landmarks unless explicitly stated above."`,
    );
  });

  test("coastal-bluff profile (no altitude)", () => {
    expect(
      buildImagePrompt({
        caption: "fog rolling in over the headland",
        place: "Marin Headlands, CA",
        lat: 37.8324,
        lon: -122.5,
        localTime: "16:10 — late afternoon",
        weather: "marine layer, 14C",
      }),
    ).toMatchInlineSnapshot(
      `"Photographic field journal illustration: fog rolling in over the headland. Location: Marin Headlands, CA. Coordinates: 37.8324, -122.5000. Local time: 16:10 — late afternoon. Weather: marine layer, 14C. Realistic, plausible scene grounded in the telemetry above. Lighting and shadows match the local time of day. No text, captions, watermarks, signs, or readable lettering anywhere in the image. Do not invent or label specific named landmarks unless explicitly stated above."`,
    );
  });

  test("desert-flank profile (caption + telemetry only, no place)", () => {
    expect(
      buildImagePrompt({
        caption: "Joshua trees at golden hour",
        lat: 33.8734,
        lon: -115.9009,
        altitudeM: 1100,
        localTime: "18:45 — golden hour",
        weather: "clear, 28C, calm",
      }),
    ).toMatchInlineSnapshot(
      `"Photographic field journal illustration: Joshua trees at golden hour. Coordinates: 33.8734, -115.9009. Altitude: 1100 m. Local time: 18:45 — golden hour. Weather: clear, 28C, calm. Realistic, plausible scene grounded in the telemetry above. Lighting and shadows match the local time of day. No text, captions, watermarks, signs, or readable lettering anywhere in the image. Do not invent or label specific named landmarks unless explicitly stated above."`,
    );
  });
});

describe("buildImagePrompt — graceful omission", () => {
  test("caption-only (no GPS, no enrichment)", () => {
    const out = buildImagePrompt({ caption: "test caption" });
    expect(out).toContain("Photographic field journal illustration: test caption.");
    expect(out).not.toContain("Coordinates:");
    expect(out).not.toContain("Altitude:");
    expect(out).not.toContain("Location:");
    expect(out).not.toContain("Local time:");
    expect(out).not.toContain("Weather:");
    expect(out).toContain("Realistic, plausible scene");
    expect(out).toContain("No text, captions, watermarks");
  });

  test("empty optional strings are treated as absent", () => {
    const out = buildImagePrompt({
      caption: "x",
      place: "",
      localTime: "",
      weather: "",
    });
    expect(out).not.toContain("Location:");
    expect(out).not.toContain("Local time:");
    expect(out).not.toContain("Weather:");
  });

  test("lat without lon (or vice versa) omits coordinates", () => {
    const onlyLat = buildImagePrompt({ caption: "x", lat: 37.0 });
    expect(onlyLat).not.toContain("Coordinates:");
    const onlyLon = buildImagePrompt({ caption: "x", lon: -118.0 });
    expect(onlyLon).not.toContain("Coordinates:");
  });

  test("realism guards always present, regardless of telemetry availability", () => {
    const minimal = buildImagePrompt({ caption: "x" });
    expect(minimal).toContain("No text, captions, watermarks");
    expect(minimal).toContain("Do not invent or label specific named landmarks");
    expect(minimal).toContain("Lighting and shadows match the local time");
  });
});
