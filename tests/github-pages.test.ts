import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  publishPost,
  PublishError,
  slugify,
} from "../src/adapters/publish/github-pages.js";
import type { Env } from "../src/env.js";
import { makeTestEnv } from "./helpers/env.js";

let env: Env;
let fetchSpy: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;
const NOW = new Date("2026-04-25T17:30:00Z");

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Decode a base64 payload as UTF-8 (atob returns binary-as-Latin-1). */
function decodeUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

beforeEach(() => {
  env = makeTestEnv({
    GITHUB_JOURNAL_REPO: "brockamer/trailscribe-journal",
    GITHUB_JOURNAL_BRANCH: "main",
    GITHUB_JOURNAL_TOKEN: "ghp_test_token_xyz123",
    JOURNAL_POST_PATH_TEMPLATE: "content/posts/{yyyy}-{mm}-{dd}-{slug}.md",
    JOURNAL_URL_TEMPLATE: "https://brockamer.github.io/trailscribe-journal/{yyyy}/{mm}/{dd}/{slug}.html",
  });
  fetchSpy = vi.fn();
  globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("slugify — title → URL slug", () => {
  test("simple ASCII title → lowercase hyphenated", () => {
    expect(slugify("Alpenglow at Lake Sabrina", NOW)).toBe("alpenglow-at-lake-sabrina");
  });

  test("strips non-ASCII (combining accents removed via NFKD)", () => {
    expect(slugify("Café Crème", NOW)).toBe("cafe-creme");
  });

  test("collapses runs of non-alphanumerics into single hyphen", () => {
    expect(slugify("hello!!! world??", NOW)).toBe("hello-world");
  });

  test("trims leading/trailing hyphens", () => {
    expect(slugify("--foo bar--", NOW)).toBe("foo-bar");
  });

  test("truncates at 50 chars and trims trailing hyphen", () => {
    const out = slugify("x".repeat(80), NOW);
    expect(out.length).toBeLessThanOrEqual(50);
  });

  test("empty after stripping → untitled-HHMMSS fallback", () => {
    expect(slugify("!!!", NOW)).toBe("untitled-173000");
    expect(slugify("", NOW)).toBe("untitled-173000");
    // CJK strips to nothing under our ASCII filter.
    expect(slugify("写真", NOW)).toBe("untitled-173000");
  });
});

describe("publishPost — happy path", () => {
  test("commits markdown with frontmatter; returns url + path + sha", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 404 })) // GET path: free
      .mockResolvedValueOnce(
        jsonResponse({
          content: { sha: "blob-sha", path: "content/posts/2026-04-25-test.md", html_url: "x" },
          commit: { sha: "commit-sha-abc123" },
        }),
      );

    const result = await publishPost({
      title: "Test Title",
      haiku: "First line\nSecond line\nThird line",
      body: "Body text.",
      env,
      now: () => NOW,
    });

    expect(result.url).toBe(
      "https://brockamer.github.io/trailscribe-journal/2026/04/25/test-title.html",
    );
    expect(result.path).toBe("content/posts/2026-04-25-test-title.md");
    expect(result.sha).toBe("commit-sha-abc123");
  });

  test("PUT request carries auth, user-agent, and api-version headers", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          content: { sha: "blob-sha", path: "p", html_url: "x" },
          commit: { sha: "csh" },
        }),
      );

    await publishPost({
      title: "Test",
      haiku: "a\nb\nc",
      body: "B",
      env,
      now: () => NOW,
    });

    const putCall = fetchSpy.mock.calls[1];
    const init = putCall[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${env.GITHUB_JOURNAL_TOKEN}`);
    expect(headers["User-Agent"]).toBe("trailscribe");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(init.method).toBe("PUT");
  });

  test("PUT body is base64'd markdown with frontmatter and branch field", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          content: { sha: "blob-sha", path: "p", html_url: "x" },
          commit: { sha: "csh" },
        }),
      );

    await publishPost({
      title: "Lake Sabrina",
      haiku: "Granite glow\nCold cirque wind\nDay turns",
      body: "Pink light bleeds.",
      lat: 37.1682,
      lon: -118.5891,
      placeName: "Lake Sabrina",
      weather: "Clear · 8C",
      env,
      now: () => NOW,
    });

    const putBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string) as {
      message: string;
      content: string;
      branch: string;
    };

    expect(putBody.message).toBe("trailscribe: Lake Sabrina");
    expect(putBody.branch).toBe("main");

    const decoded = decodeUtf8(putBody.content);
    expect(decoded).toContain("---");
    expect(decoded).toContain('title: "Lake Sabrina"');
    expect(decoded).toContain("date: 2026-04-25T17:30:00.000Z");
    expect(decoded).toContain("location: { lat: 37.1682, lon: -118.5891, place: \"Lake Sabrina\" }");
    expect(decoded).toContain('weather: "Clear · 8C"');
    expect(decoded).toContain("tags: [trailscribe]");
    expect(decoded).toContain("Granite glow\nCold cirque wind\nDay turns");
    expect(decoded).toContain("Pink light bleeds.");
  });
});

describe("publishPost — frontmatter conditional keys", () => {
  test("no GPS → location and weather keys OMITTED entirely", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          content: { sha: "blob-sha", path: "p", html_url: "x" },
          commit: { sha: "csh" },
        }),
      );

    await publishPost({
      title: "No GPS Post",
      haiku: "a\nb\nc",
      body: "x",
      env,
      now: () => NOW,
    });

    const putBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string) as {
      content: string;
    };
    const decoded = decodeUtf8(putBody.content);
    expect(decoded).not.toContain("location:");
    expect(decoded).not.toContain("weather:");
    expect(decoded).not.toContain("(0, 0)");
    expect(decoded).toContain("tags: [trailscribe]");
  });

  test("GPS but no placeName → location includes lat/lon, omits place key", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          content: { sha: "blob-sha", path: "p", html_url: "x" },
          commit: { sha: "csh" },
        }),
      );

    await publishPost({
      title: "Coords only",
      haiku: "a\nb\nc",
      body: "x",
      lat: 37,
      lon: -118,
      env,
      now: () => NOW,
    });

    const putBody = JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string) as {
      content: string;
    };
    const decoded = decodeUtf8(putBody.content);
    expect(decoded).toContain("location: { lat: 37, lon: -118 }");
    expect(decoded).not.toContain("place:");
  });
});

describe("publishPost — slug collision", () => {
  test("first path 200 (collision) then 404 → slug becomes <base>-2 and PUT goes there", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({})) // first GET: 200 collision
      .mockResolvedValueOnce(new Response(null, { status: 404 })) // second GET: 404 free
      .mockResolvedValueOnce(
        jsonResponse({
          content: { sha: "blob-sha", path: "p", html_url: "x" },
          commit: { sha: "csh" },
        }),
      );

    const result = await publishPost({
      title: "Test",
      haiku: "a\nb\nc",
      body: "x",
      env,
      now: () => NOW,
    });

    expect(result.path).toBe("content/posts/2026-04-25-test-2.md");
    expect(result.url).toContain("/2026/04/25/test-2.html");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe("publishPost — error paths", () => {
  test("401 on PUT surfaces immediately as PublishError; no retry", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ message: "Bad credentials" }, 401));

    await expect(
      publishPost({ title: "T", haiku: "a\nb\nc", body: "x", env, now: () => NOW }),
    ).rejects.toBeInstanceOf(PublishError);
    expect(fetchSpy).toHaveBeenCalledTimes(2); // GET + one PUT, no retry
  });

  test("503 then 200 → retries", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ message: "service unavailable" }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          content: { sha: "blob-sha", path: "p", html_url: "x" },
          commit: { sha: "csh" },
        }),
      );

    const result = await publishPost({
      title: "T",
      haiku: "a\nb\nc",
      body: "x",
      env,
      delay: () => Promise.resolve(),
      now: () => NOW,
    });
    expect(result.sha).toBe("csh");
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  test("GET collision check failing with 401 throws (doesn't loop into infinite collision dance)", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse({ message: "bad" }, 401));

    await expect(
      publishPost({ title: "T", haiku: "a\nb\nc", body: "x", env, now: () => NOW }),
    ).rejects.toBeInstanceOf(PublishError);
  });
});

describe("publishPost — URL template substitution", () => {
  test("substitutes {yyyy}/{mm}/{dd}/{slug} per JOURNAL_URL_TEMPLATE", async () => {
    env.JOURNAL_URL_TEMPLATE = "https://example.com/blog/{yyyy}/{mm}/{slug}/";
    fetchSpy
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        jsonResponse({
          content: { sha: "b", path: "p", html_url: "x" },
          commit: { sha: "c" },
        }),
      );

    const result = await publishPost({
      title: "Hello World",
      haiku: "a\nb\nc",
      body: "x",
      env,
      now: () => NOW,
    });

    expect(result.url).toBe("https://example.com/blog/2026/04/hello-world/");
  });
});
