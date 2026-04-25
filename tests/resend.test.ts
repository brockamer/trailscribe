import { describe, test, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { sendEmail, ResendError } from "../src/adapters/mail/resend.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;
let fetchSpy: MockInstance<typeof fetch>;

const noDelay = () => Promise.resolve();

beforeEach(() => {
  env = makeTestEnv();
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sendEmail — happy path", () => {
  test("POSTs to https://api.resend.com/emails with Bearer auth, formatted From, plain text body", async () => {
    fetchSpy.mockResolvedValueOnce(jsonResponse(200, { id: "msg_abc123" }));

    const result = await sendEmail({
      to: "alice@example.com",
      subject: "field check",
      body: "all good\nstill on schedule",
      env,
      delay: noDelay,
    });

    expect(result).toEqual({ id: "msg_abc123" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${env.RESEND_API_KEY}`);
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.from).toBe(`${env.RESEND_FROM_NAME} <${env.RESEND_FROM_EMAIL}>`);
    expect(body.to).toBe("alice@example.com");
    expect(body.subject).toBe("field check");
    expect(body.text).toBe("all good\nstill on schedule");
    expect(body.html).toBeUndefined();
  });
});

describe("sendEmail — error paths", () => {
  test("400 invalid recipient surfaces typed ResendError with name + message", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(400, {
        name: "validation_error",
        message: "Invalid `to` field: not an email",
      }),
    );

    let caught: unknown;
    try {
      await sendEmail({
        to: "not-an-email",
        subject: "x",
        body: "y",
        env,
        delay: noDelay,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ResendError);
    const err = caught as ResendError;
    expect(err.status).toBe(400);
    expect(err.errorName).toBe("validation_error");
    expect(err.message).toMatch(/Invalid `to`/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("422 invalid recipient is also surfaced (not retried)", async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(422, { name: "missing_required_field", message: "subject required" }),
    );
    await expect(
      sendEmail({ to: "a@b.com", subject: "", body: "y", env, delay: noDelay }),
    ).rejects.toBeInstanceOf(ResendError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("5xx retried with 1s/4s/16s schedule; success on third attempt", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(500, { message: "boom" }))
      .mockResolvedValueOnce(jsonResponse(502, { message: "bad gateway" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "msg_xyz" }));

    const sleeps: number[] = [];
    const recordingDelay = (ms: number): Promise<void> => {
      sleeps.push(ms);
      return Promise.resolve();
    };

    const result = await sendEmail({
      to: "a@b.com",
      subject: "x",
      body: "y",
      env,
      delay: recordingDelay,
    });
    expect(result).toEqual({ id: "msg_xyz" });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 4000]);
  });

  test("network error retried", async () => {
    fetchSpy
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, { id: "msg_x" }));

    const result = await sendEmail({
      to: "a@b.com",
      subject: "x",
      body: "y",
      env,
      delay: noDelay,
    });
    expect(result.id).toBe("msg_x");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("all retries exhausted → throws ResendError", async () => {
    fetchSpy
      .mockResolvedValueOnce(jsonResponse(500, { message: "boom" }))
      .mockResolvedValueOnce(jsonResponse(503, { message: "down" }))
      .mockResolvedValueOnce(jsonResponse(504, { message: "timeout" }))
      .mockResolvedValueOnce(jsonResponse(502, { message: "still down" }));

    await expect(
      sendEmail({ to: "a@b.com", subject: "x", body: "y", env, delay: noDelay }),
    ).rejects.toBeInstanceOf(ResendError);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
