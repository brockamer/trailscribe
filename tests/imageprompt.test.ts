import { describe, test, expect } from "vitest";
import { buildImagePrompt } from "../src/core/imageprompt.js";

describe("buildImagePrompt — determinism", () => {
  test("same inputs produce identical strings", () => {
    const inputs = {
      caption: "dawn light on the cirque",
      place: "Sierra Nevada, CA",
      altitudeM: 3810,
      localTime: "07:42 — early morning",
      weatherCode: 2,
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
        altitudeM: 3810,
        localTime: "07:42 — early morning",
        weatherCode: 2,
      }),
    ).toMatchInlineSnapshot(
      `"A photorealistic photograph from a backcountry field journal. Render the mood and setting evoked by this note, not a literal depiction of the objects or words in it: dawn light on the cirque. Location: Sierra Nevada, CA. Soft, filtered daylight with scattered clouds and gently diffused shadows. Local time: 07:42 — early morning; lighting and shadows match that time of day. Altitude: 3810 m. Shot on a real camera: natural imperfections, true-to-life color and texture, no illustration or painterly style. No readable text, signage, or watermarks; do not invent or label specific named landmarks beyond what is given."`,
    );
  });

  test("coastal-bluff profile (no altitude, fog)", () => {
    expect(
      buildImagePrompt({
        caption: "fog rolling in over the headland",
        place: "Marin Headlands, CA",
        localTime: "16:10 — late afternoon",
        weatherCode: 45,
      }),
    ).toMatchInlineSnapshot(
      `"A photorealistic photograph from a backcountry field journal. Render the mood and setting evoked by this note, not a literal depiction of the objects or words in it: fog rolling in over the headland. Location: Marin Headlands, CA. Flat, diffused light through fog, muted colors and low-contrast edges. Local time: 16:10 — late afternoon; lighting and shadows match that time of day. Shot on a real camera: natural imperfections, true-to-life color and texture, no illustration or painterly style. No readable text, signage, or watermarks; do not invent or label specific named landmarks beyond what is given."`,
    );
  });

  test("desert-flank profile (no place, clear sky)", () => {
    expect(
      buildImagePrompt({
        caption: "Joshua trees at golden hour",
        altitudeM: 1100,
        localTime: "18:45 — golden hour",
        weatherCode: 0,
      }),
    ).toMatchInlineSnapshot(
      `"A photorealistic photograph from a backcountry field journal. Render the mood and setting evoked by this note, not a literal depiction of the objects or words in it: Joshua trees at golden hour. Bright, clear sunlight with crisp, well-defined shadows. Local time: 18:45 — golden hour; lighting and shadows match that time of day. Altitude: 1100 m. Shot on a real camera: natural imperfections, true-to-life color and texture, no illustration or painterly style. No readable text, signage, or watermarks; do not invent or label specific named landmarks beyond what is given."`,
    );
  });
});

describe("buildImagePrompt — the #235 regressions", () => {
  test("never says 'illustration' as the medium — that word produced cartoons", () => {
    const out = buildImagePrompt({ caption: "x", place: "Malibu, California", weatherCode: 2 });
    expect(out).toContain("A photorealistic photograph");
    expect(out).not.toContain("field journal illustration");
    // the only surviving mention is the negative form, telling the model to avoid it
    expect(out).toContain("no illustration or painterly style");
  });

  test("frames the caption as mood, not as a literal object list", () => {
    const out = buildImagePrompt({ caption: "crushing tasks and heavy sticky note kanban" });
    expect(out).toContain("not a literal depiction of the objects or words in it");
  });

  test("never emits raw coordinates — they cost prompt budget a model cannot use", () => {
    const out = buildImagePrompt({
      caption: "x",
      place: "Malibu, California",
      weatherCode: 2,
      altitudeM: 12,
    });
    expect(out).not.toContain("Coordinates:");
    expect(out).not.toMatch(/-?\d+\.\d{4}/);
  });

  test("weather renders as light quality, never as raw numbers", () => {
    expect(buildImagePrompt({ caption: "x", weatherCode: 0 })).toContain("crisp, well-defined");
    expect(buildImagePrompt({ caption: "x", weatherCode: 71 })).toContain("snow light");
    expect(buildImagePrompt({ caption: "x", weatherCode: 95 })).toContain("storm light");
    expect(buildImagePrompt({ caption: "x", weatherCode: 3 })).not.toMatch(/°F|mph/);
  });

  test("an unmapped weather code still yields a usable light phrase", () => {
    expect(buildImagePrompt({ caption: "x", weatherCode: 12345 })).toContain(
      "Natural outdoor daylight.",
    );
  });
});

describe("buildImagePrompt — graceful omission", () => {
  test("caption-only (no GPS, no enrichment)", () => {
    const out = buildImagePrompt({ caption: "test caption" });
    expect(out).toContain("A photorealistic photograph from a backcountry field journal.");
    expect(out).toContain("it: test caption.");
    expect(out).not.toContain("Altitude:");
    expect(out).not.toContain("Location:");
    expect(out).not.toContain("Local time:");
  });

  test("the lighting-matches-time clause is omitted when there is no time to match", () => {
    // Before #235 this was unconditional boilerplate, and the data to ground
    // it never reached the builder at all.
    const noTime = buildImagePrompt({ caption: "x", place: "Malibu, California" });
    expect(noTime).not.toContain("lighting and shadows match that time of day");

    const withTime = buildImagePrompt({ caption: "x", localTime: "07:42 — early morning" });
    expect(withTime).toContain("lighting and shadows match that time of day");
  });

  test("empty optional strings are treated as absent", () => {
    const out = buildImagePrompt({ caption: "x", place: "", localTime: "" });
    expect(out).not.toContain("Location:");
    expect(out).not.toContain("Local time:");
  });

  test("guards are always present, regardless of telemetry availability", () => {
    const minimal = buildImagePrompt({ caption: "x" });
    expect(minimal).toContain("No readable text, signage, or watermarks");
    expect(minimal).toContain("do not invent or label specific named landmarks");
    expect(minimal).toContain("Shot on a real camera");
  });
});

describe("buildImagePrompt — night/day coherence (#235 review)", () => {
  test("a clear sky at night does not ask for bright sunlight", () => {
    // Before the review fix this produced "Bright, clear sunlight with crisp,
    // well-defined shadows." alongside "02:00 — night" in the same prompt.
    const out = buildImagePrompt({
      caption: "camp set, stars out",
      weatherCode: 0,
      localTime: "02:00 — night",
      isNight: true,
    });
    expect(out).not.toContain("Bright, clear sunlight");
    expect(out).toContain("Clear night sky");
    expect(out).toContain("02:00 — night");
  });

  test("the same code in daylight still asks for sunlight", () => {
    const out = buildImagePrompt({
      caption: "camp set",
      weatherCode: 0,
      localTime: "13:00 — midday",
      isNight: false,
    });
    expect(out).toContain("Bright, clear sunlight");
    expect(out).not.toContain("Clear night sky");
  });

  test("every WMO bucket has a night phrasing that never mentions sun", () => {
    for (const code of [0, 2, 45, 55, 65, 73, 81, 97, 99999]) {
      const out = buildImagePrompt({ caption: "x", weatherCode: code, isNight: true });
      expect(out).not.toMatch(/sunlight|sunny|bright sun/i);
    }
  });

  test("isNight defaults to day when unknown, rather than throwing", () => {
    const out = buildImagePrompt({ caption: "x", weatherCode: 0 });
    expect(out).toContain("Bright, clear sunlight");
  });
});
