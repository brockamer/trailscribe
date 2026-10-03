import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  generateNarrative,
  generateTrackNarrative,
  NarrativeError,
} from "../src/core/narrative.js";
import type { Env } from "../src/env.js";
import { makeTestEnv } from "./helpers/env.js";

let env: Env;
// Workers' fetch overload signature confuses vitest's MockInstance generic;
// type as MockedFunction of the basic global fetch shape.
let fetchSpy: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
const originalFetch = globalThis.fetch;

const NATALIE_NOTE =
  "Lake Sabrina basin glowing pink at sunset, alpenglow on the granite walls. Cold wind off the cirque.";

function jsonResponse(
  content: object | string,
  opts: Partial<{ status: number; usage: object }> = {},
) {
  const body = {
    id: "chatcmpl-test",
    choices: [
      {
        message: {
          role: "assistant",
          content: typeof content === "string" ? content : JSON.stringify(content),
        },
        finish_reason: "stop",
      },
    ],
    usage: opts.usage ?? { prompt_tokens: 240, completion_tokens: 180, total_tokens: 420 },
  };
  return new Response(JSON.stringify(body), {
    status: opts.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  env = makeTestEnv();
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("generateNarrative — happy path", () => {
  test("returns parsed { title, haiku, body, usage } from a well-formed JSON response", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        title: "Alpenglow at Lake Sabrina",
        haiku: "Granite walls glow pink\nWind drops off the cirque\nCold breath turns mist",
        body: "Pink light bleeds across the basin walls as the day dies behind the crest.",
      }),
    );

    const out = await generateNarrative({ note: NATALIE_NOTE, env });

    expect(out.title).toBe("Alpenglow at Lake Sabrina");
    expect(out.haiku.split("\n")).toHaveLength(3);
    expect(out.body).toContain("Pink light");
    expect(out.usage).toEqual({ prompt_tokens: 240, completion_tokens: 180 });
  });

  test("posts to LLM_BASE_URL/chat/completions with bearer auth", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({ note: "x", env });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init as RequestInit).method).toBe("POST");

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${env.LLM_API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("passes LLM_MODEL from env through as the request model", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({ note: "x", env });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("anthropic/claude-sonnet-4-6");
  });

  test("requests json_schema structured output", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({ note: "x", env });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      response_format: { type: string; json_schema: { name: string } };
    };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("narrative");
  });
});

describe("generateNarrative — prompt composition", () => {
  test("with lat/lon/placeName/weather → prompt includes Location + Weather lines", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({
      note: NATALIE_NOTE,
      lat: 37.1682,
      lon: -118.5891,
      placeName: "Lake Sabrina, Inyo County, CA",
      weather: "Clear · 8°C · wind 12 km/h W",
      env,
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = body.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain(`Note: ${NATALIE_NOTE}`);
    // Published precision (#223): the body is public, so the model never sees
    // coordinates finer than the frontmatter will carry.
    expect(userMsg).toContain("Location: Lake Sabrina, Inyo County, CA (37.168, -118.589)");
    expect(userMsg).toContain("Weather: Clear · 8°C · wind 12 km/h W");
  });

  test("JOURNAL_LOCATION_PRECISION=omit → Location line carries the place name only", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({
      note: NATALIE_NOTE,
      lat: 37.1682,
      lon: -118.5891,
      placeName: "Lake Sabrina, Inyo County, CA",
      env: makeTestEnv({ ...env, JOURNAL_LOCATION_PRECISION: "omit" }),
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = body.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("Location: Lake Sabrina, Inyo County, CA");
    expect(userMsg).not.toContain("37.");
    expect(userMsg).not.toContain("-118");
  });

  test("without GPS → prompt OMITS Location line entirely (no '(0, 0)' placeholder)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({ note: NATALIE_NOTE, env });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = body.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain(`Note: ${NATALIE_NOTE}`);
    expect(userMsg).not.toContain("Location:");
    expect(userMsg).not.toContain("0, 0");
    expect(userMsg).not.toContain("(unknown)");
  });

  test("bare !post (no note, #124) → user prompt OMITS 'Note:' line; system prompt forbids invention", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({
      lat: 37.1682,
      lon: -118.5891,
      placeName: "Lake Sabrina, Inyo County, CA",
      weather: "Clear · 8°C · wind 12 km/h W",
      env,
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = body.messages.find((m) => m.role === "user")?.content ?? "";
    const sysMsg = body.messages.find((m) => m.role === "system")?.content ?? "";

    expect(userMsg).not.toContain("Note:");
    expect(userMsg).toContain("Location: Lake Sabrina");
    expect(userMsg).toContain("Weather: Clear");

    expect(sysMsg).toContain("did not provide a caption");
    expect(sysMsg.toLowerCase()).toContain("do not invent");
  });

  test("whitespace-only note → treated as bare (no-note prompt path)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({ note: "   ", placeName: "X", lat: 1, lon: 2, env });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const sysMsg = body.messages.find((m) => m.role === "system")?.content ?? "";
    const userMsg = body.messages.find((m) => m.role === "user")?.content ?? "";

    expect(sysMsg).toContain("did not provide a caption");
    expect(userMsg).not.toContain("Note:");
  });

  test("with-note path → system prompt is the original first-person variant", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({ note: "feeling great", env });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const sysMsg = body.messages.find((m) => m.role === "system")?.content ?? "";

    expect(sysMsg).not.toContain("did not provide a caption");
    expect(sysMsg).toContain("brief notes");
  });

  test("placeName missing but lat/lon present → still omits Location (need all three)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({ note: "x", lat: 37, lon: -118, env });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = body.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).not.toContain("Location:");
  });
});

describe("generateNarrative — error paths", () => {
  test("malformed JSON in choices[0].message.content → NarrativeError", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse("Here's your post: {bogus"));

    await expect(generateNarrative({ note: "x", env })).rejects.toBeInstanceOf(NarrativeError);
  });

  test("schema-violating JSON (missing field) → NarrativeError listing the issue", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: "T", body: "B" }), // missing haiku
    );

    await expect(generateNarrative({ note: "x", env })).rejects.toThrow(/haiku/);
  });

  test("title too long → NarrativeError", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: "x".repeat(61), haiku: "a\nb\nc", body: "B" }),
    );

    await expect(generateNarrative({ note: "x", env })).rejects.toBeInstanceOf(NarrativeError);
  });

  test("empty content string → NarrativeError", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(""));
    await expect(generateNarrative({ note: "x", env })).rejects.toThrow(/no content/);
  });

  test("4xx response surfaces immediately (no retry)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(generateNarrative({ note: "x", env })).rejects.toThrow(/HTTP 401/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("chatCompletion — retry behavior (via narrative)", () => {
  test("5xx then 200 → retries once, returns success", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("internal error", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    // Inject zero-delay so the test doesn't actually wait 1s.
    // Wire through the env's ai layer is not exposed; we rely on the global
    // fetch mock and accept the test sleep is 1s. Mark slow.
    const out = await generateNarrative({ note: "x", env });
    expect(out.title).toBe("T");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 10000);

  test("network error then 200 → retries", async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    const out = await generateNarrative({ note: "x", env });
    expect(out.title).toBe("T");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  }, 10000);
});

describe("LLM_PROVIDER_HEADERS_JSON — analytics passthrough", () => {
  test("merges parsed headers when env var is non-empty JSON", async () => {
    env.LLM_PROVIDER_HEADERS_JSON = JSON.stringify({
      "HTTP-Referer": "https://trailscribe.workers.dev",
      "X-Title": "TrailScribe",
    });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateNarrative({ note: "x", env });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://trailscribe.workers.dev");
    expect(headers["X-Title"]).toBe("TrailScribe");
  });

  test("malformed JSON in env var is silently ignored (no throw)", async () => {
    env.LLM_PROVIDER_HEADERS_JSON = "{not valid json";
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    const out = await generateNarrative({ note: "x", env });
    expect(out.title).toBe("T");
  });
});

describe("generateTrackNarrative — imperial units in LLM input (#195)", () => {
  test("buildTrackPrompt sends mi/ft/mph; system prompt instructs US customary", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));

    await generateTrackNarrative({
      metrics: {
        pingCount: 14,
        startedAt: Date.parse("2026-05-02T15:51:30Z"),
        closedAt: Date.parse("2026-05-02T16:24:30Z"),
        durationSeconds: 1980,
        distanceKm: 10,
        pace: { avgKmh: 16, p50Kmh: 15, p95Kmh: 20 },
        elevation: { gainM: 100, lossM: 80, minM: 0, maxM: 100 },
        routeShape: "out-and-back",
        activityHint: "bike",
      },
      startPlace: "Malibu, CA",
      endPlace: "Topanga, CA",
      env,
    });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = body.messages.find((m) => m.role === "user")?.content ?? "";
    const sysMsg = body.messages.find((m) => m.role === "system")?.content ?? "";

    // No metric units leak through to the model.
    expect(userMsg).not.toMatch(/\bkm\b/);
    expect(userMsg).not.toMatch(/\bkm\/h\b/);
    expect(userMsg).not.toMatch(/\bmeters?\b/);

    // Imperial values present: 10 km → 6.21 mi; 100 m → 328 ft; 16 km/h → 9.94 mph.
    expect(userMsg).toMatch(/Distance: 6\.21 mi/);
    expect(userMsg).toMatch(/Elevation gain: 328 ft/);
    expect(userMsg).toMatch(/Average speed: 9\.9 mph/);
    expect(userMsg).toMatch(/p95: 12\.4 mph/);

    // System prompt explicitly instructs imperial in the body.
    expect(sysMsg).toMatch(/US customary units|miles, feet|mph/);
  });
});

describe("generateTrackNarrative — under-sampled tracks (#230)", () => {
  const metrics = {
    pingCount: 3,
    startedAt: Date.parse("2026-09-12T12:01:00Z"),
    closedAt: Date.parse("2026-09-12T12:16:00Z"),
    durationSeconds: 900,
    distanceKm: 0.0566,
    pace: { avgKmh: 2, p50Kmh: 3, p95Kmh: 3 },
    elevation: { gainM: 0, lossM: 0, minM: 10, maxM: 10 },
    routeShape: "loop" as const,
    activityHint: "walk" as const,
  };
  async function userPrompt(sampling?: { undersampled: boolean }): Promise<string> {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));
    await generateTrackNarrative({
      metrics,
      sampling: sampling && {
        undersampled: sampling.undersampled,
        speedRatio: 8.8,
        estimatedDistanceKm: 0.5,
        maxGapSeconds: 780,
      },
      env,
    });
    const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    return body.messages.find((m) => m.role === "user")?.content ?? "";
  }

  test("marks distance as a lower bound and forbids inferring pauses", async () => {
    const msg = await userPrompt({ undersampled: true });
    expect(msg).toMatch(/Distance: at least 0\.04 mi \(LOWER BOUND/);
    expect(msg).toContain("about 0.31 mi");
    expect(msg).toContain("Data quality");
    expect(msg).toMatch(/Do not infer stopping/);
    expect(msg).not.toMatch(/\bkm\b/);
  });

  test("a well-sampled track prompt is unchanged", async () => {
    const msg = await userPrompt({ undersampled: false });
    expect(msg).toMatch(/Distance: 0\.04 mi/);
    expect(msg).not.toContain("Data quality");
  });
});

describe("generateNarrative — bare post voice and time grounding (#240)", () => {
  async function promptsFor(input: Parameters<typeof generateNarrative>[0]) {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));
    await generateNarrative(input);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    return {
      sys: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
    };
  }

  test("no-note system prompt never says 'traveller' — the word leaks into the post", async () => {
    const { sys } = await promptsFor({ placeName: "X", lat: 1, lon: 2, env });
    expect(sys.toLowerCase()).not.toContain("traveller");
    expect(sys.toLowerCase()).not.toContain("traveler");
  });

  test("no-note system prompt asks for the operator's own first-person voice, not third-person", async () => {
    const { sys } = await promptsFor({ placeName: "X", lat: 1, lon: 2, env });
    expect(sys.toLowerCase()).not.toContain("third-person");
    expect(sys.toLowerCase()).not.toContain("observational");
    expect(sys.toLowerCase()).toContain("first-person");
  });

  test("no-note system prompt keeps every anti-hallucination constraint", async () => {
    const { sys } = await promptsFor({ placeName: "X", lat: 1, lon: 2, env });
    expect(sys.toLowerCase()).toContain("do not invent activities, feelings, companions");
    expect(sys.toLowerCase()).toContain("keep the body short rather than padding");
  });

  test("no-note system prompt forbids opening on coordinates and generalising about the region", async () => {
    const { sys } = await promptsFor({ placeName: "X", lat: 1, lon: 2, env });
    expect(sys.toLowerCase()).toContain("do not open with coordinates");
    expect(sys.toLowerCase()).toContain("this moment");
  });

  test("no-note system prompt tells the model the time of day is fixed", async () => {
    const { sys } = await promptsFor({ placeName: "X", lat: 1, lon: 2, env });
    expect(sys).toContain("Local time");
  });

  test("localTime reaches the user prompt as a 'Local time:' line", async () => {
    const { user } = await promptsFor({
      placeName: "Malibu, CA",
      lat: 34.0,
      lon: -118.7,
      weather: "Clear · 66°F",
      localTime: "21:17 — night",
      isNight: true,
      clockKnown: true,
      env,
    });
    expect(user).toMatch(/^Local time: 21:17 — night/m);
  });

  test("isNight adds an explicit darkness line so the model cannot read 'evening' into clear skies", async () => {
    const { user } = await promptsFor({
      placeName: "Malibu, CA",
      lat: 34.0,
      lon: -118.7,
      weather: "Clear · 66°F",
      localTime: "21:17 — night",
      isNight: true,
      clockKnown: true,
      env,
    });
    expect(user.toLowerCase()).toContain("dark");
  });

  test("a daytime localTime does not claim darkness", async () => {
    const { user } = await promptsFor({
      placeName: "Malibu, CA",
      lat: 34.0,
      lon: -118.7,
      localTime: "13:05 — midday",
      isNight: false,
      clockKnown: true,
      env,
    });
    expect(user).toMatch(/^Local time: 13:05 — midday/m);
    expect(user.toLowerCase()).not.toContain("dark");
  });

  test("a civil clock time reaches the prompt as fact, not as an approximation (#274)", async () => {
    const { user } = await promptsFor({
      placeName: "Malibu, CA",
      lat: 34.0,
      lon: -118.7,
      localTime: "03:28 — night",
      isNight: true,
      clockKnown: true,
      env,
    });
    expect(user).toMatch(/^Local time: 03:28 — night$/m);
    expect(user).not.toContain("mean solar");
    expect(user).not.toContain("approximate");
  });

  test("with no clock time known, the line gives the period and forbids stating a time (#274)", async () => {
    const { user } = await promptsFor({
      placeName: "Malibu, CA",
      lat: 34.0,
      lon: -118.7,
      localTime: "night",
      isNight: true,
      clockKnown: false,
      env,
    });
    expect(user).toMatch(/^Local time: night \(clock time unknown — state no clock time\)$/m);
  });

  test("a caller that omits clockKnown gets the safe line — no clock time asserted (#274)", async () => {
    const { user } = await promptsFor({
      placeName: "Malibu, CA",
      lat: 34.0,
      lon: -118.7,
      localTime: "night",
      isNight: true,
      env,
    });
    expect(user).toMatch(/^Local time: night \(clock time unknown — state no clock time\)$/m);
  });

  test("the system rule allows a clock time only when the Local time line gives one (#274)", async () => {
    const { sys } = await promptsFor({ placeName: "X", lat: 1, lon: 2, env });
    expect(sys).toContain("State a clock time only when the Local time line gives one");
  });

  test("no localTime → no 'Local time:' line (nothing fabricated)", async () => {
    const { user } = await promptsFor({ placeName: "X", lat: 1, lon: 2, env });
    expect(user).not.toContain("Local time");
  });

  test("bare post → Location line carries the place name only, no coordinates to open on", async () => {
    const { user } = await promptsFor({
      lat: 37.1682,
      lon: -118.5891,
      placeName: "Lake Sabrina, Inyo County, CA",
      env,
    });
    expect(user).toContain("Location: Lake Sabrina, Inyo County, CA");
    expect(user).not.toContain("37.168");
    expect(user).not.toContain("-118.589");
  });

  test("captioned post → Location line still carries the (rounded) coordinates", async () => {
    const { user } = await promptsFor({
      note: NATALIE_NOTE,
      lat: 37.1682,
      lon: -118.5891,
      placeName: "Lake Sabrina, Inyo County, CA",
      env,
    });
    expect(user).toContain("Location: Lake Sabrina, Inyo County, CA (37.168, -118.589)");
  });
});

describe("reasoning-model token caps (#263)", () => {
  // Opus 5.5 spends a hidden 180–560 reasoning tokens per narrative call, and they count
  // against max_tokens. At the old 600 cap, 3 of 16 calls ended finish_reason: length.
  const TRACK_METRICS = {
    pingCount: 14,
    startedAt: Date.parse("2026-05-02T15:51:30Z"),
    closedAt: Date.parse("2026-05-02T16:24:30Z"),
    durationSeconds: 1980,
    distanceKm: 3,
    pace: { avgKmh: 4.5, p50Kmh: 4.2, p95Kmh: 12 },
    elevation: { gainM: 33, lossM: 33, minM: 0, maxM: 35 },
    routeShape: "loop" as const,
    activityHint: "mixed" as const,
  };

  function sentBody(): { max_tokens?: number; reasoning?: unknown; model: string } {
    const init = fetchSpy.mock.calls.at(-1)?.[1] as RequestInit;
    return JSON.parse(init.body as string) as {
      max_tokens?: number;
      reasoning?: unknown;
      model: string;
    };
  }

  test("a post narrative leaves room for reasoning tokens: max_tokens 2000", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));
    await generateNarrative({ note: "x", env });
    expect(sentBody().max_tokens).toBe(2000);
  });

  test("a track narrative leaves room for reasoning tokens: max_tokens 3000", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));
    await generateTrackNarrative({ metrics: TRACK_METRICS, env });
    expect(sentBody().max_tokens).toBe(3000);
  });

  test("sends no reasoning parameter, so a rollback to a non-reasoning model is config-only", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));
    await generateNarrative({ note: "x", env });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));
    await generateTrackNarrative({ metrics: TRACK_METRICS, env });
    for (const [, init] of fetchSpy.mock.calls) {
      expect(JSON.parse((init as RequestInit).body as string)).not.toHaveProperty("reasoning");
    }
  });

  test("falls back to anthropic/claude-opus-5.5 when LLM_MODEL is empty", async () => {
    env = makeTestEnv({ LLM_MODEL: "" });
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));
    await generateNarrative({ note: "x", env });
    expect(sentBody().model).toBe("anthropic/claude-opus-5.5");
    fetchSpy.mockResolvedValueOnce(jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }));
    await generateTrackNarrative({ metrics: TRACK_METRICS, env });
    expect(sentBody().model).toBe("anthropic/claude-opus-5.5");
  });
});
