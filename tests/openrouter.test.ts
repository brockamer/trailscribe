/**
 * chatCompletion — content_filter retry and finish-reason logging (#270).
 *
 * Measured 2026-10-04: about 1 in 20 identical `!brief` requests on Opus 5.5
 * came back `finish_reason: content_filter` (`native_finish_reason: refusal`)
 * with no content. The adapter retries such a response once, for every
 * caller, and logs every non-`stop` finish as `llm_finish_reason`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { chatCompletion } from "../src/adapters/ai/openrouter.js";
import type { Env } from "../src/env.js";
import { makeTestEnv } from "./helpers/env.js";

let env: Env;
let fetchSpy: ReturnType<typeof vi.fn>;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
const originalFetch = globalThis.fetch;

function completion(
  content: string,
  finishReason: string,
  opts: { prompt?: number; completion?: number; native?: string; cost?: number } = {},
): Response {
  const prompt = opts.prompt ?? 367;
  const done = opts.completion ?? 500;
  const cost = opts.cost === undefined ? {} : { cost: opts.cost };
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      choices: [
        {
          message: { role: "assistant", content },
          finish_reason: finishReason,
          native_finish_reason: opts.native ?? (finishReason === "stop" ? "end_turn" : "refusal"),
        },
      ],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: done,
        total_tokens: prompt + done,
        ...cost,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

const filtered = () => completion("", "content_filter", { completion: 314 });

function call() {
  return chatCompletion({
    req: {
      model: "anthropic/claude-opus-5.5",
      messages: [{ role: "user", content: "brief me" }],
      max_tokens: 2000,
    },
    env,
    label: "brief",
    delay: async () => undefined,
  });
}

function finishLogs(): Array<Record<string, unknown>> {
  return errSpy.mock.calls
    .map((c: unknown[]) => JSON.parse(String(c[0])) as Record<string, unknown>)
    .filter((l: Record<string, unknown>) => l.event === "llm_finish_reason");
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

describe("chatCompletion — content_filter retry (#270)", () => {
  test("an empty content_filter answer is retried once and the second answer returned", async () => {
    fetchSpy
      .mockResolvedValueOnce(filtered())
      .mockResolvedValueOnce(completion("4 entries.", "stop"));

    const res = await call();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(res.choices[0]?.message.content).toBe("4 entries.");
    expect(res.choices[0]?.finish_reason).toBe("stop");
  });

  test("the returned usage adds both attempts, because OpenRouter bills the filtered one", async () => {
    fetchSpy
      .mockResolvedValueOnce(filtered())
      .mockResolvedValueOnce(completion("4 entries.", "stop", { completion: 500 }));

    const res = await call();

    expect(res.usage).toEqual({
      prompt_tokens: 734,
      completion_tokens: 814,
      total_tokens: 1548,
    });
  });

  test("a second filtered answer is returned, not retried again", async () => {
    fetchSpy.mockResolvedValueOnce(filtered()).mockResolvedValueOnce(filtered());

    const res = await call();

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(res.choices[0]?.finish_reason).toBe("content_filter");
    expect(res.choices[0]?.message.content).toBe("");
    expect(res.usage.completion_tokens).toBe(628);
  });

  test("a content_filter finish that still carries content is not retried", async () => {
    fetchSpy.mockResolvedValueOnce(completion("Partial brief.", "content_filter"));

    const res = await call();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.choices[0]?.message.content).toBe("Partial brief.");
  });

  test("a length finish is not retried", async () => {
    fetchSpy.mockResolvedValueOnce(completion("", "length", { native: "max_tokens" }));

    await call();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

describe("chatCompletion — usage.cost (#162)", () => {
  test("OpenRouter's usage.cost is returned with the token counts", async () => {
    fetchSpy.mockResolvedValueOnce(completion("4 entries.", "stop", { cost: 0.0123 }));

    const res = await call();

    expect(res.usage.cost).toBe(0.0123);
  });

  test("the retry adds the cost of both attempts, because OpenRouter bills the filtered one", async () => {
    fetchSpy
      .mockResolvedValueOnce(completion("", "content_filter", { cost: 0.0071 }))
      .mockResolvedValueOnce(completion("4 entries.", "stop", { cost: 0.0123 }));

    const res = await call();

    expect(res.usage.cost).toBeCloseTo(0.0194, 10);
  });

  test("the retry drops the cost when one attempt has none, so the ledger estimates both", async () => {
    fetchSpy
      .mockResolvedValueOnce(filtered())
      .mockResolvedValueOnce(completion("4 entries.", "stop", { cost: 0.0123 }));

    const res = await call();

    expect(res.usage.cost).toBeUndefined();
    expect(res.usage.completion_tokens).toBe(814);
  });
});

describe("chatCompletion — llm_finish_reason log (#270)", () => {
  test("a non-stop finish logs one warn line naming the caller and both finish reasons", async () => {
    fetchSpy.mockResolvedValueOnce(
      completion("cut off", "length", { native: "max_tokens", completion: 2000 }),
    );

    await call();

    const logs = finishLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      level: "warn",
      label: "brief",
      model: "anthropic/claude-opus-5.5",
      finish_reason: "length",
      native_finish_reason: "max_tokens",
      max_tokens: 2000,
      completion_tokens: 2000,
      attempt: 1,
    });
  });

  test("each filtered attempt logs, so a double filter shows twice", async () => {
    fetchSpy.mockResolvedValueOnce(filtered()).mockResolvedValueOnce(filtered());

    await call();

    const logs = finishLogs();
    expect(logs.map((l) => l.attempt)).toEqual([1, 2]);
    expect(logs.every((l) => l.finish_reason === "content_filter")).toBe(true);
    expect(logs.every((l) => l.native_finish_reason === "refusal")).toBe(true);
  });

  test("a stop finish logs nothing", async () => {
    fetchSpy.mockResolvedValueOnce(completion("4 entries.", "stop"));

    await call();

    expect(finishLogs()).toHaveLength(0);
  });
});
