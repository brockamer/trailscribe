/**
 * P2-08 — End-to-end integration tests for !camp pipeline.
 *
 * Asserts:
 *   - Short reply: device gets `(may be outdated) <answer>`.
 *   - Long reply: device gets the canned overflow pointer; full prefixed
 *     answer routes to the operator email.
 *   - Budget gate: short-circuits before any LLM call.
 *   - Idempotency: replay does not double-bill the LLM or double-send email.
 *   - Empty query: rejected upstream by the grammar; handler not invoked.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeApp } from "../src/app.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";
import { monthlyTotals, recordTransaction } from "../src/core/ledger.js";

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

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function chatCompletionResponse(content: string, prompt = 60, completion = 80) {
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
        imei: "123456789012345",
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

describe("P2-08 !camp — short reply happy path", () => {
  test("device gets `(may be outdated) <answer>`; ledger captures usage", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => jsonResponse(chatCompletionResponse("Onion Valley has dispersed sites along the creek.")),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp water Onion Valley"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual([
      "(may be outdated) Onion Valley has dispersed sites along the creek.",
    ]);

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("api.resend.com"))).toBe(false);

    const snap = await monthlyTotals(env);
    expect(snap.by_command["camp"].requests).toBe(1);
    expect(snap.prompt_tokens).toBe(60);
    expect(snap.completion_tokens).toBe(80);
  });
});

describe("P2-08 !camp — long reply email path", () => {
  test("> 320 chars: device gets pointer; Resend gets prefixed full answer", async () => {
    const longAnswer = "z".repeat(500);
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => jsonResponse(chatCompletionResponse(longAnswer)),
      },
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_camp_long" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp deep camping research"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Long answer sent by email."]);

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
    expect(sentBody.subject).toContain("TrailScribe !camp");
    expect(sentBody.text).toContain("(may be outdated) " + longAnswer);
  });
});

describe("P2-08 !camp — budget gate", () => {
  test("daily budget exhausted: short-circuits before any LLM call", async () => {
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 40000, completion_tokens: 12000 },
      env,
    });
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp test budget"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toContain("Daily AI budget reached");
  });
});

describe("P2-08 !camp — idempotency", () => {
  test("replay hits LLM once and emails once", async () => {
    const longAnswer = "w".repeat(500);
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => jsonResponse(chatCompletionResponse(longAnswer)),
      },
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_camp_replay" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const ev = envelope("!camp replay test", { ts: 5555 });
    await postIpc(ev);
    await postIpc(ev);

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    const llmCalls = calls.filter((u) => u.includes("openrouter") || u.includes("/chat/completions"));
    const emailCalls = calls.filter((u) => u.includes("api.resend.com"));
    expect(llmCalls).toHaveLength(1);
    expect(emailCalls).toHaveLength(1);
  });
});

describe("P2-08 !camp — empty query", () => {
  test("rejected at parse time; LLM never called", async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Unknown command. Try !help"]);
  });
});
