import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { generateNarrative, NarrativeError } from "../src/core/narrative.js";
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

function jsonResponse(content: object | string, opts: Partial<{ status: number; usage: object }> = {}) {
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
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }),
    );

    await generateNarrative({ note: "x", env });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init as RequestInit).method).toBe("POST");

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${env.LLM_API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("uses LLM_MODEL from env (default: openai/gpt-5-mini)", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }),
    );

    await generateNarrative({ note: "x", env });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("openai/gpt-5-mini");
  });

  test("requests json_schema structured output", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }),
    );

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
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }),
    );

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
    expect(userMsg).toContain("Location: Lake Sabrina, Inyo County, CA (37.1682, -118.5891)");
    expect(userMsg).toContain("Weather: Clear · 8°C · wind 12 km/h W");
  });

  test("without GPS → prompt OMITS Location line entirely (no '(0, 0)' placeholder)", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }),
    );

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

  test("placeName missing but lat/lon present → still omits Location (need all three)", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }),
    );

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
      .mockResolvedValueOnce(
        jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }),
      );

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
      .mockResolvedValueOnce(
        jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }),
      );

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
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }),
    );

    await generateNarrative({ note: "x", env });

    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["HTTP-Referer"]).toBe("https://trailscribe.workers.dev");
    expect(headers["X-Title"]).toBe("TrailScribe");
  });

  test("malformed JSON in env var is silently ignored (no throw)", async () => {
    env.LLM_PROVIDER_HEADERS_JSON = "{not valid json";
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({ title: "T", haiku: "a\nb\nc", body: "B" }),
    );

    const out = await generateNarrative({ note: "x", env });
    expect(out.title).toBe("T");
  });
});
