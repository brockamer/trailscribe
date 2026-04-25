import { describe, test, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { sendReply, IpcInboundError } from "../src/adapters/outbound/garmin-ipc-inbound.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;
let fetchSpy: MockInstance<typeof fetch>;
let logSpy: MockInstance<(...args: unknown[]) => void>;
let errSpy: MockInstance<(...args: unknown[]) => void>;

const noDelay = () => Promise.resolve();

beforeEach(() => {
  env = makeTestEnv();
  fetchSpy = vi.spyOn(globalThis, "fetch");
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  logSpy.mockRestore();
  errSpy.mockRestore();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function loggedEvents(): Array<Record<string, unknown>> {
  const lines: string[] = [];
  for (const c of logSpy.mock.calls) lines.push(String(c[0]));
  for (const c of errSpy.mock.calls) lines.push(String(c[0]));
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("sendReply — happy path", () => {
  test("single message: one HTTP POST to /api/Messaging/Message with X-API-Key + Sender + /Date(ms)/", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { count: 1 }));

    const result = await sendReply("123456789012345", ["pong"], env, { delay: noDelay });

    expect(result).toEqual({ count: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(`${env.GARMIN_IPC_INBOUND_BASE_URL}/api/Messaging/Message`);
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe(env.GARMIN_IPC_INBOUND_API_KEY);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse((init as RequestInit).body as string) as {
      Messages: Array<{ Recipients: string[]; Sender: string; Timestamp: string; Message: string }>;
    };
    expect(body.Messages).toHaveLength(1);
    const msg = body.Messages[0];
    expect(msg.Recipients).toEqual(["123456789012345"]);
    expect(msg.Sender).toBe(env.IPC_INBOUND_SENDER);
    expect(msg.Message).toBe("pong");
    expect(msg.Timestamp).toMatch(/^\/Date\(\d+\)\/$/);
  });

  test("two messages: two sequential HTTP POSTs, count=2", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(200, { count: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, { count: 1 }));

    const result = await sendReply(
      "123456789012345",
      ["page one (1/2)", "page two (2/2)"],
      env,
      { delay: noDelay },
    );

    expect(result).toEqual({ count: 2 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const messagesSent = fetchSpy.mock.calls.map((c) => {
      const body = JSON.parse((c[1] as RequestInit).body as string) as {
        Messages: Array<{ Message: string }>;
      };
      return body.Messages[0].Message;
    });
    expect(messagesSent).toEqual(["page one (1/2)", "page two (2/2)"]);
  });
});

describe("sendReply — input validation (caller bug)", () => {
  test("throws synchronously if any message exceeds 160 chars; no fetch issued", async () => {
    const tooLong = "x".repeat(161);
    await expect(
      sendReply("123456789012345", ["ok", tooLong], env, { delay: noDelay }),
    ).rejects.toThrow(/exceeds 160/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("throws on empty messages array", async () => {
    await expect(sendReply("123456789012345", [], env, { delay: noDelay })).rejects.toThrow(
      /at least one message/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sendReply — Garmin error responses", () => {
  test("422 surfaces {Code, Description} in the typed error", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(422, {
        Code: 5,
        Description: "Message length 200 exceeds maximum of 160.",
        Message: "InvalidMessageError",
      }),
    );

    let caught: unknown;
    try {
      await sendReply("123456789012345", ["whatever"], env, { delay: noDelay });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(IpcInboundError);
    const err = caught as IpcInboundError;
    expect(err.status).toBe(422);
    expect(err.code).toBe(5);
    expect(err.message).toMatch(/InvalidMessageError/);
    expect(err.description).toMatch(/exceeds maximum/);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("401 logs auth_fail_outbound and rethrows", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(401, { Code: 1, Description: "Unauthorized" }),
    );

    await expect(
      sendReply("123456789012345", ["pong"], env, { delay: noDelay }),
    ).rejects.toBeInstanceOf(IpcInboundError);

    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("auth_fail_outbound");
  });

  test("403 also logs auth_fail_outbound and rethrows", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(403, { Code: 1 }));

    await expect(
      sendReply("123456789012345", ["pong"], env, { delay: noDelay }),
    ).rejects.toBeInstanceOf(IpcInboundError);

    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("auth_fail_outbound");
  });
});

describe("sendReply — retry semantics (5xx/429)", () => {
  test("5xx → success on second attempt; total 2 fetch calls; result count=1", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(500, { Code: 1, Description: "InternalError" }))
      .mockResolvedValueOnce(jsonResponse(200, { count: 1 }));

    const result = await sendReply("123456789012345", ["pong"], env, { delay: noDelay });
    expect(result).toEqual({ count: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("429 with Retry-After is also retried", async () => {
    const tooMany = new Response(JSON.stringify({ Code: 2 }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "1" },
    });
    fetchSpy
      .mockResolvedValueOnce(tooMany)
      .mockResolvedValueOnce(jsonResponse(200, { count: 1 }));

    const result = await sendReply("123456789012345", ["pong"], env, { delay: noDelay });
    expect(result).toEqual({ count: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("all retries exhausted (initial + 3 retries) → log reply_delivery_failed, rethrow", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(500, { Code: 1 }))
      .mockResolvedValueOnce(jsonResponse(502, { Code: 1 }))
      .mockResolvedValueOnce(jsonResponse(503, { Code: 1 }))
      .mockResolvedValueOnce(jsonResponse(504, { Code: 1 }));

    await expect(
      sendReply("123456789012345", ["pong"], env, { delay: noDelay }),
    ).rejects.toBeInstanceOf(IpcInboundError);

    expect(fetchSpy).toHaveBeenCalledTimes(4);
    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("reply_delivery_failed");
  });

  test("network error (fetch rejects) is also retried", async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse(200, { count: 1 }));

    const result = await sendReply("123456789012345", ["pong"], env, { delay: noDelay });
    expect(result).toEqual({ count: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("retry delays follow 1s/4s/16s schedule before retries 1, 2, 3", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(500, { Code: 1 }))
      .mockResolvedValueOnce(jsonResponse(500, { Code: 1 }))
      .mockResolvedValueOnce(jsonResponse(500, { Code: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, { count: 1 }));

    const sleptMs: number[] = [];
    const recordingDelay = (ms: number): Promise<void> => {
      sleptMs.push(ms);
      return Promise.resolve();
    };

    await sendReply("123456789012345", ["pong"], env, { delay: recordingDelay });
    expect(sleptMs).toEqual([1000, 4000, 16000]);
  });
});
