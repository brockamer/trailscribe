/**
 * P2-07 — End-to-end integration tests for !ai pipeline.
 *
 * Asserts:
 *   - Short reply happy path: device reply is the LLM content; ledger captures
 *     real OpenRouter usage; no email send.
 *   - Long reply email path: device reply is the canned overflow pointer;
 *     full LLM output goes to the operator email via Resend.
 *   - Budget gate: short-circuits before any LLM call.
 *   - Idempotency: replay does not double-bill the LLM or double-send email.
 *   - Empty question: rejected upstream by the grammar; handler not invoked.
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

function chatCompletionResponse(content: string, prompt = 50, completion = 100) {
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

describe("P2-07 !ai — short reply happy path", () => {
  test("LLM content ≤ 320 chars goes straight to the device; no email send", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => jsonResponse(chatCompletionResponse("Granite is an igneous rock formed from cooled magma.")),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!ai what is granite"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Granite is an igneous rock formed from cooled magma."]);

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("api.resend.com"))).toBe(false);

    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(1);
    expect(snap.by_command["ai"].requests).toBe(1);
    expect(snap.prompt_tokens).toBe(50);
    expect(snap.completion_tokens).toBe(100);
  });
});

describe("P2-07 !ai — long reply email path", () => {
  test("LLM content > 320 chars: device gets pointer; Resend gets full answer", async () => {
    const longAnswer = "x".repeat(500);
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => jsonResponse(chatCompletionResponse(longAnswer)),
      },
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_long" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!ai explain mineralogy in great detail"));

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
    expect(sentBody.subject).toContain("TrailScribe !ai");
    expect(sentBody.subject).toContain("explain mineralogy");
    expect(sentBody.text).toContain(longAnswer);
    expect(sentBody.text).toContain("Question:");
  });
});

describe("P2-07 !ai — budget gate", () => {
  test("daily budget exhausted: short-circuits before any LLM call", async () => {
    // Seed today's daily ledger past the 50,000-token budget.
    const overBudgetUsage = { prompt_tokens: 40000, completion_tokens: 12000 };
    await recordTransaction({ command: "post", usage: overBudgetUsage, env });

    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!ai test budget"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toContain("Daily AI budget reached");
  });
});

describe("P2-07 !ai — idempotency", () => {
  test("replay of the same event hits LLM once and emails once", async () => {
    const longAnswer = "y".repeat(500);
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => jsonResponse(chatCompletionResponse(longAnswer)),
      },
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_replay" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const ev = envelope("!ai replay test", { ts: 9876 });
    await postIpc(ev);
    await postIpc(ev);

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    const llmCalls = calls.filter((u) => u.includes("openrouter") || u.includes("/chat/completions"));
    const emailCalls = calls.filter((u) => u.includes("api.resend.com"));
    expect(llmCalls).toHaveLength(1);
    expect(emailCalls).toHaveLength(1);
  });
});

describe("P2-07 !ai — empty question", () => {
  test("rejected at parse time; LLM never called", async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!ai"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Unknown command. Try !help"]);
  });
});
