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
      `"An ordinary, unposed phone photo taken handheld at eye level. Nobody poses and nobody is the subject. The place is deserted, with no one else in sight, near or far, all the way to the horizon; anyone the note mentions has already gone, so draw only the place. Seen first-person, from where the photographer stands, looking at the view as they saw it; the photographer is behind the camera, not in the picture. Any "I" in the text below is the photographer. Render the mood and setting evoked by this note, not a literal depiction of the objects or words in it: dawn light on the cirque. Location: Sierra Nevada, CA; show it the way it really looks there. The only exceptions are a busy town or city street and a popular public beach: there, a few ordinary people far in the background are normal, small and not facing the camera. Soft, filtered daylight with scattered clouds and gently diffused shadows. Local time: 07:42 — early morning; lighting and shadows match that time of day. Altitude: 3810 m. It looks like a real, unedited phone picture: natural exposure, true-to-life color, ordinary everyday framing, slight softness and sensor noise in the shadows. Not cinematic, not a staged stock photo, no HDR glow, no illustration or painterly style. No posed people, no close-up faces, no figure as the subject. No readable text, signage, or watermarks; do not invent or label specific named landmarks beyond what is given."`,
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
      `"An ordinary, unposed phone photo taken handheld at eye level. Nobody poses and nobody is the subject. The place is deserted, with no one else in sight, near or far, all the way to the horizon; anyone the note mentions has already gone, so draw only the place. Seen first-person, from where the photographer stands, looking at the view as they saw it; the photographer is behind the camera, not in the picture. Any "I" in the text below is the photographer. Render the mood and setting evoked by this note, not a literal depiction of the objects or words in it: fog rolling in over the headland. Location: Marin Headlands, CA; show it the way it really looks there. The only exceptions are a busy town or city street and a popular public beach: there, a few ordinary people far in the background are normal, small and not facing the camera. Flat, diffused light through fog, muted colors and low-contrast edges. Local time: 16:10 — late afternoon; lighting and shadows match that time of day. It looks like a real, unedited phone picture: natural exposure, true-to-life color, ordinary everyday framing, slight softness and sensor noise in the shadows. Not cinematic, not a staged stock photo, no HDR glow, no illustration or painterly style. No posed people, no close-up faces, no figure as the subject. No readable text, signage, or watermarks; do not invent or label specific named landmarks beyond what is given."`,
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
      `"An ordinary, unposed phone photo taken handheld at eye level. Nobody poses and nobody is the subject. The place is deserted, with no one else in sight, near or far, all the way to the horizon; anyone the note mentions has already gone, so draw only the place. Seen first-person, from where the photographer stands, looking at the view as they saw it; the photographer is behind the camera, not in the picture. Any "I" in the text below is the photographer. Render the mood and setting evoked by this note, not a literal depiction of the objects or words in it: Joshua trees at golden hour. The only exceptions are a busy town or city street and a popular public beach: there, a few ordinary people far in the background are normal, small and not facing the camera. Bright, clear sunlight with crisp, well-defined shadows. Local time: 18:45 — golden hour; lighting and shadows match that time of day. Altitude: 1100 m. It looks like a real, unedited phone picture: natural exposure, true-to-life color, ordinary everyday framing, slight softness and sensor noise in the shadows. Not cinematic, not a staged stock photo, no HDR glow, no illustration or painterly style. No posed people, no close-up faces, no figure as the subject. No readable text, signage, or watermarks; do not invent or label specific named landmarks beyond what is given."`,
    );
  });
});

describe("buildImagePrompt — the #235 regressions", () => {
  test("never says 'illustration' as the medium — that word produced cartoons", () => {
    const out = buildImagePrompt({ caption: "x", place: "Malibu, California", weatherCode: 2 });
    expect(out).toContain("An ordinary, unposed phone photo");
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
    expect(out).toContain("An ordinary, unposed phone photo taken handheld at eye level.");
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
    expect(minimal).toContain("a real, unedited phone picture");
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

describe("buildImagePrompt — bare !postimg, narrative as subject (#150)", () => {
  const NARRATIVE = "Low cloud over the point: grey light on the water, the cliffs soft-edged.";

  test("with no caption, the narrative supplies the subject", () => {
    const out = buildImagePrompt({
      narrativeSubject: NARRATIVE,
      place: "Malibu, California",
      weatherCode: 2,
    });
    expect(out).toContain(NARRATIVE);
    expect(out).toContain("An ordinary, unposed phone photo");
    expect(out).toContain("Location: Malibu, California;");
  });

  test("the mood-framing qualifier is dropped for narrative subjects", () => {
    // That qualifier exists to stop a human caption being rendered as a literal
    // object list. The narrative is already prose describing a scene, so
    // applying it would fight a problem that isn't there.
    const out = buildImagePrompt({ narrativeSubject: NARRATIVE });
    expect(out).not.toContain("not a literal depiction of the objects or words in it");
  });

  test("a caption still wins when both are present", () => {
    const out = buildImagePrompt({ caption: "fog over the ridge", narrativeSubject: NARRATIVE });
    expect(out).toContain("fog over the ridge");
    expect(out).not.toContain(NARRATIVE);
    expect(out).toContain("not a literal depiction of the objects or words in it");
  });

  test("guards and camera anchor still apply with no caption", () => {
    const out = buildImagePrompt({ narrativeSubject: NARRATIVE });
    expect(out).toContain("a real, unedited phone picture");
    expect(out).toContain("No readable text, signage, or watermarks");
  });

  test("neither caption nor narrative still yields a well-formed prompt", () => {
    const out = buildImagePrompt({ place: "Malibu, California", weatherCode: 0 });
    expect(out).toContain("An ordinary, unposed phone photo");
    expect(out).not.toMatch(/\s{2,}/);
    expect(out).not.toContain("undefined");
  });
});

describe("buildImagePrompt — first-person view, no invented people (#267)", () => {
  // The 2026-09-30 production image drew a woman with a backpack beside an
  // open journal. The prompt never said whose eyes the picture is seen
  // through, so the model put the journal keeper in the scene. Real renders
  // (2026-10-01) showed that a "no people" guard at the end of the prompt
  // still let distant hikers and beachgoers through; only a rule near the
  // front stopped them. Both clauses must therefore precede the subject.
  const CAPTION = "met a hiker at the pass";
  const NARRATIVE =
    "Wind and Old Snow at the Saddle: Made the saddle at last. I'm watching the snow as much as the sky.";
  const captioned = buildImagePrompt({ caption: CAPTION, place: "Inyo County, California" });
  const bare = buildImagePrompt({ narrativeSubject: NARRATIVE, place: "Mono County, California" });
  const subjectAt = (out: string) => Math.max(out.indexOf(CAPTION), out.indexOf(NARRATIVE));

  test("both paths set the first-person view before the subject", () => {
    for (const out of [captioned, bare]) {
      const pov = out.search(/first-person/i);
      expect(pov).toBeGreaterThan(-1);
      expect(pov).toBeLessThan(subjectAt(out));
    }
  });

  test("the photographer stays behind the camera, and the narrative's 'I' is the photographer", () => {
    for (const out of [captioned, bare]) {
      expect(out).toMatch(/behind the camera, not in the picture/);
      expect(out).toMatch(/"I" in the text below is the photographer/);
    }
  });

  test("both paths state the people rule before the subject", () => {
    for (const out of [captioned, bare]) {
      const rule = out.search(/nobody is the subject/i);
      expect(rule).toBeGreaterThan(-1);
      expect(rule).toBeLessThan(subjectAt(out));
    }
  });

  test("the place is deserted, near and far — distant specks count", () => {
    // Operator decision 2026-10-01: outside the exceptions, no figure of any
    // size. Renders showed beachgoers and ridge hikers 5-30 px tall.
    expect(captioned).toMatch(/the place is deserted, with no one else in sight, near or far/i);
  });

  test("people the note mentions are not drawn", () => {
    // "met a hiker at the pass" drew the hiker until this clause existed.
    expect(captioned).toMatch(/anyone the note mentions has already gone, so draw only the place/i);
  });

  test("town streets and popular beaches may have only small, far background people", () => {
    // Operator decisions 2026-10-01: an empty city street looks wrong, and a
    // busy public beach is treated like a town.
    for (const out of [captioned, bare]) {
      expect(out).toMatch(/busy town or city street and a popular public beach/i);
      expect(out).toMatch(/far in the background are normal, small and not facing the camera/i);
    }
  });

  test("the exceptions come after the location, never at the front", () => {
    // With the town exception at the front (round 4), the model applied it to
    // mountain passes too and drew hikers on the ridge. After the location it
    // judges the exception against the actual place.
    const out = buildImagePrompt({ caption: CAPTION, place: "Inyo County, California" });
    const exception = out.search(/only exceptions are/i);
    expect(exception).toBeGreaterThan(out.indexOf("Location:"));
    expect(exception).toBeGreaterThan(out.search(/the place is deserted/i));
  });

  test("the end guard forbids posed people, close-up faces and a figure as the subject", () => {
    const out = buildImagePrompt({ place: "Malibu, California", weatherCode: 0 });
    expect(out).toMatch(/no posed people, no close-up faces, no figure as the subject/i);
  });

  test("the prompt never assumes a trail or a field journal", () => {
    // "while out on the trail" put a trail down the middle of every render,
    // including a lake camp and a city; "field journal" drew an open notebook
    // and, on 2026-09-30, the person writing in it.
    for (const out of [
      buildImagePrompt({ caption: "coffee in the old town", place: "Reykjavík, Iceland" }),
      buildImagePrompt({ narrativeSubject: "Fog at the point: grey and still." }),
    ]) {
      expect(out).not.toMatch(/trail/i);
      expect(out).not.toMatch(/field journal/i);
    }
  });
});
