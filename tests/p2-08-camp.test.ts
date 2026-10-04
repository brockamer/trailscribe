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

function chatCompletionResponse(
  content: string,
  prompt = 60,
  completion = 80,
  finishReason = "stop",
) {
  return {
    id: "chatcmpl-test",
    choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
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
        respond: () =>
          jsonResponse(chatCompletionResponse("Onion Valley has dispersed sites along the creek.")),
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
    const llmCalls = calls.filter(
      (u) => u.includes("openrouter") || u.includes("/chat/completions"),
    );
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
    expect(messages).toEqual(["!camp needs a question. Example: !camp water near Onion Valley"]);
  });

  test("logs parse_usage with the verb, not parse_unknown (#294)", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp"));

    const events = logSpy.mock.calls.map(
      (c: unknown[]) => JSON.parse(String(c[0])) as Record<string, unknown>,
    );
    expect(events.find((e) => e.event === "parse_usage")).toMatchObject({ verb: "camp" });
    expect(events.some((e) => e.event === "parse_unknown")).toBe(false);
  });

  test("a Garmin retry of the same bare !camp sends the hint once (#294)", async () => {
    globalThis.fetch = vi.fn() as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp", { ts: 1700000001234 }));
    await postIpc(envelope("!camp", { ts: 1700000001234 }));

    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });
});

describe("P2-08 !camp — output cap (#265)", () => {
  // With no max_tokens, OpenRouter reserves credit for 65,536 completion tokens
  // (about $1.31 on Opus 5.5) and returns 402 when the balance is lower.
  function llmRequestBody(): { max_tokens?: number } {
    const call = fetchSpy.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("/chat/completions"),
    );
    return JSON.parse((call![1] as RequestInit).body as string) as { max_tokens?: number };
  }

  function llmRouter(finishReason: string) {
    return makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () =>
          jsonResponse(chatCompletionResponse("Water at the inlet.", 60, 80, finishReason)),
      },
    ]);
  }

  test("sends max_tokens 2000, the same output reservation as a !post", async () => {
    fetchSpy = llmRouter("stop");
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp water near lake sabrina"));

    expect(llmRequestBody().max_tokens).toBe(2000);
  });

  test("an answer cut off at the cap logs llm_finish_reason labelled camp and is still delivered", async () => {
    fetchSpy = llmRouter("length");
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp water near lake sabrina"));

    const warnLines = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(
      warnLines.some(
        (l: string) => l.includes('"event":"llm_finish_reason"') && l.includes('"label":"camp"'),
      ),
    ).toBe(true);
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["(may be outdated) Water at the inlet."]);
  });

  test("a complete answer logs no llm_finish_reason", async () => {
    fetchSpy = llmRouter("stop");
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp water near lake sabrina"));

    const warnLines = errSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(warnLines.some((l: string) => l.includes('"event":"llm_finish_reason"'))).toBe(false);
  });

  // #270: the provider's safety filter stops about 1 in 20 identical requests
  // with no content. The adapter retries once; a second block gets its own reply.
  function filterRouter(outcomes: Array<"filter" | "ok">) {
    let n = 0;
    return makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () =>
          outcomes[n++] === "filter"
            ? jsonResponse(chatCompletionResponse("", 100, 314, "content_filter"))
            : jsonResponse(chatCompletionResponse("Water at the inlet.", 100, 150, "stop")),
      },
    ]);
  }

  test("an answer filtered once is retried and delivered (#270)", async () => {
    fetchSpy = filterRouter(["filter", "ok"]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp water near lake sabrina"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["(may be outdated) Water at the inlet."]);
  });

  test("an answer filtered twice tells the device the provider's filter blocked it (#270)", async () => {
    fetchSpy = filterRouter(["filter", "filter"]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp water near lake sabrina"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Camp lookup blocked by the provider's filter. Try again."]);
    expect(messages).not.toEqual(["Camp lookup returned empty. Try rephrasing."]);
  });
});

describe("P2-08 !camp — plain text (#271)", () => {
  // The device shows Markdown emphasis as literal asterisks and they use reply
  // budget. The prompt asks for plain text; stripping is the backstop.
  function systemPrompt(): string {
    const call = fetchSpy.mock.calls.find((c: unknown[]) =>
      String(c[0]).includes("/chat/completions"),
    );
    const body = JSON.parse((call![1] as RequestInit).body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    return body.messages.find((m) => m.role === "system")!.content;
  }

  function llmRouter(content: string) {
    return makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => jsonResponse(chatCompletionResponse(content)),
      },
    ]);
  }

  test("the system prompt asks for plain text, no Markdown", async () => {
    fetchSpy = llmRouter("Water at the inlet.");
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp water near lake sabrina"));

    const prompt = systemPrompt().toLowerCase();
    expect(prompt).toContain("plain text");
    expect(prompt).toContain("asterisks");
  });

  test("paired ** in the answer is stripped, and the staleness prefix stays", async () => {
    fetchSpy = llmRouter("**Yes, likely.** Water at the inlet (JMT), **fill early**.");
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp water near lake sabrina"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual([
      "(may be outdated) Yes, likely. Water at the inlet (JMT), fill early.",
    ]);
  });

  test("markers are stripped before the length check, so a clean answer that fits is not emailed", async () => {
    // 54 bold one-letter words: with the 18-char staleness prefix that is 341
    // chars with markers (over the 320 budget, so it would overflow to email)
    // and 125 without (one SMS page).
    const marked = Array.from({ length: 54 }, () => "**a**").join(" ");
    const clean = Array.from({ length: 54 }, () => "a").join(" ");
    expect(("(may be outdated) " + marked).length).toBeGreaterThan(320);
    expect(("(may be outdated) " + clean).length).toBeLessThanOrEqual(320);
    fetchSpy = llmRouter(marked);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp water near lake sabrina"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["(may be outdated) " + clean]);
    const calls = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((u: string) => u.includes("api.resend.com"))).toBe(false);
  });
});

describe("camp — OpenRouter actual cost reaches the ledger (#162)", () => {
  test("usage.cost is recorded instead of the env-rate estimate", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("openrouter.ai") || u.includes("/chat/completions"),
        respond: () => {
          const res = chatCompletionResponse("Onion Valley has dispersed sites.");
          return jsonResponse({ ...res, usage: { ...res.usage, cost: 0.0421 } });
        },
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!camp water Onion Valley"));

    const snap = await monthlyTotals(env);
    expect(snap.by_command["camp"]?.usd_cost).toBe(0.0421);
  });
});
