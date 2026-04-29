/**
 * P2-06 — End-to-end integration tests for !brief pipeline.
 *
 * Asserts:
 *   - Empty FieldLog: short-circuits with "No entries to brief on."; LLM
 *     never called.
 *   - Happy path with FieldLog entries: LLM call produces a 5-line summary
 *     ≤320 chars; reply hits the device directly.
 *   - Long output: device gets `Brief sent by email.`; full content goes
 *     to operator email.
 *   - Custom window: `!brief 7d` filters FieldLog to last 7 days.
 *   - Daily token budget gate: short-circuits LLM call when exhausted.
 *   - Idempotency: replay does not re-bill the LLM.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeApp } from "../src/app.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";
import { recordTransaction } from "../src/core/ledger.js";
import { appendEntry } from "../src/core/fieldlog.js";

import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";

vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", () => ({
  sendReply: vi.fn().mockResolvedValue({ count: 1 }),
}));

const sendReplyMock = vi.mocked(sendReply);

let app: ReturnType<typeof makeApp>;
let env: Env;
let fetchSpy: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const IMEI = "123456789012345";

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatCompletionResponse(content: string, prompt = 100, completion = 150) {
  return {
    id: "chatcmpl-test",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
  };
}

function envelope(freeText: string, opts: { ts?: number } = {}) {
  return {
    Version: "2.0",
    Events: [
      {
        imei: IMEI,
        messageCode: 3,
        freeText,
        timeStamp: opts.ts ?? 1700000000000,
        point: { latitude: 0, longitude: 0, altitude: 0, gpsFix: 0 },
      },
    ],
  };
}

async function postIpc(body: unknown): Promise<Response> {
  return app.request(
    "/garmin/ipc",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-outbound-auth-token": env.GARMIN_INBOUND_TOKEN,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

function makeFetchRouter(
  routes: Array<{ match: (url: string) => boolean; respond: () => Response | Promise<Response> }>,
) {
  return vi.fn(async (url: URL | RequestInfo) => {
    const u = typeof url === "string" ? url : url.toString();
    for (const r of routes) {
      if (r.match(u)) return await r.respond();
    }
    throw new Error(`unmatched fetch: ${u}`);
  });
}

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv({
    LLM_INPUT_COST_PER_1K: "0.003",
    LLM_OUTPUT_COST_PER_1K: "0.015",
  });
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue({ count: 1 });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  logSpy.mockRestore();
  errSpy.mockRestore();
});

async function seedEntries(count: number, daysAgo = 0): Promise<void> {
  const baseTs = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  for (let i = 0; i < count; i += 1) {
    await appendEntry(env, IMEI, {
      id: `seed-${daysAgo}-${i}`,
      ts: baseTs - i * 60_000,
      lat: 37.1,
      lon: -118.5,
      note: `seed entry ${i}`,
      source: "drop",
    });
  }
}

describe("P2-06 !brief — empty FieldLog", () => {
  test("short-circuits with canned message; LLM never called", async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!brief"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["No entries to brief on."]);
  });
});

describe("P2-06 !brief — happy path with entries", () => {
  test("LLM called with FieldLog context; short reply hits device", async () => {
    await seedEntries(3);
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () =>
          jsonResponse(
            chatCompletionResponse(
              "Logged 3 observations.\nMostly mid-day at base camp.\nWeather steady.\nNo SOS events.\nMonth-to-date $0.05.",
            ),
          ),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!brief"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toContain("Logged 3 observations");
    expect(messages[0].length).toBeLessThanOrEqual(320);

    // Verify the LLM was called with the seeded entries in the prompt.
    const llmCall = fetchSpy.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0].includes("openrouter.ai") || c[0].includes("/chat/completions")),
    );
    const reqBody = JSON.parse((llmCall![1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = reqBody.messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("seed entry 0");
    expect(userMsg).toContain("seed entry 1");
    expect(userMsg).toContain("seed entry 2");
  });
});

describe("P2-06 !brief — long output email path", () => {
  test("> 320 chars: device gets pointer; full brief routes to email", async () => {
    await seedEntries(2);
    const longBrief = "A".repeat(500);
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => jsonResponse(chatCompletionResponse(longBrief)),
      },
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_brief_long" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!brief"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Brief sent by email."]);

    const resendCall = fetchSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("api.resend.com"),
    );
    expect(resendCall).toBeDefined();
    const sentBody = JSON.parse((resendCall![1] as RequestInit).body as string) as {
      to: string;
      subject: string;
      text: string;
    };
    expect(sentBody.to).toBe(env.RESEND_FROM_EMAIL);
    expect(sentBody.subject).toContain("TrailScribe brief");
    expect(sentBody.text).toContain(longBrief);
  });
});

describe("P2-06 !brief — custom window", () => {
  test("`!brief 7d` includes entries within 7 days; excludes older", async () => {
    await seedEntries(1, 0); // today
    await seedEntries(1, 3); // 3 days ago
    await seedEntries(1, 10); // 10 days ago

    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => jsonResponse(chatCompletionResponse("brief output")),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!brief 7d"));

    const llmCall = fetchSpy.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0].includes("openrouter.ai") || c[0].includes("/chat/completions")),
    );
    const reqBody = JSON.parse((llmCall![1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    const userMsg = reqBody.messages.find((m) => m.role === "user")!.content;
    expect(userMsg).toContain("seed entry"); // some entries surface
    expect(userMsg).toContain("Window: last 7d");
    // The 10-day-old entry should be excluded — but it carries the same
    // "seed entry 0" content as the others, so we assert the entry-count
    // line instead.
    expect(userMsg).toContain("Entries: 2.");
  });
});

describe("P2-06 !brief — budget gate", () => {
  test("daily budget exhausted: short-circuits LLM call", async () => {
    await seedEntries(2);
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 40000, completion_tokens: 12000 },
      env,
    });
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!brief"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toContain("Daily AI budget reached");
  });
});

describe("P2-06 !brief — idempotency", () => {
  test("replay does not re-bill the LLM", async () => {
    await seedEntries(2);
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => jsonResponse(chatCompletionResponse("brief output")),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const ev = envelope("!brief", { ts: 7777 });
    await postIpc(ev);
    await postIpc(ev);

    const llmCalls = fetchSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("openrouter") || u.includes("/chat/completions"));
    expect(llmCalls).toHaveLength(1);
  });
});
