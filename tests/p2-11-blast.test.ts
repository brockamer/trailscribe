/**
 * P2-11 — End-to-end integration tests for !blast pipeline.
 *
 * Asserts:
 *   - Happy path: 3-of-3 sends succeed; reply summarizes.
 *   - Partial failure: 2-of-3 succeed; reply names the count of failures.
 *   - No `all` group: rejected before any Resend call; reply names the gap.
 *   - Replay: per-recipient sends not duplicated (whole blast is checkpointed).
 *   - Ledger: 0-cost blast entry.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeApp } from "../src/app.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";
import { monthlyTotals } from "../src/core/ledger.js";

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

const ALL_BOOK = JSON.stringify({
  aliases: { all: "a@example.com,b@example.com,c@example.com" },
});
const ALL_BOOK_2 = JSON.stringify({ aliases: { all: "a@x.com,b@y.com" } });
const NO_ALL_BOOK = JSON.stringify({ aliases: { home: "you@example.com" } });

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
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

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv({ ADDRESS_BOOK_JSON: ALL_BOOK });
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

describe("P2-11 !blast — happy path", () => {
  test("3-of-3 sends succeed; reply summarizes", async () => {
    fetchSpy = vi.fn(async (url: URL | RequestInfo) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("api.resend.com")) return jsonResponse({ id: "re_msg_blast" });
      throw new Error(`unmatched fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!blast camp ok"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Blasted to 3 (0 failed)."]);

    const resendCalls = fetchSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("api.resend.com"),
    );
    expect(resendCalls).toHaveLength(3);

    // Each recipient unique
    const tos = resendCalls.map((c) => {
      const body = JSON.parse((c[1] as RequestInit).body as string) as { to: string };
      return body.to;
    });
    expect(new Set(tos)).toEqual(new Set(["a@example.com", "b@example.com", "c@example.com"]));
  });
});

describe("P2-11 !blast — partial failure", () => {
  test("2-of-3 succeed; one Resend 4xx; reply names the failure count", async () => {
    let callCount = 0;
    fetchSpy = vi.fn(async (url: URL | RequestInfo) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("api.resend.com")) {
        callCount += 1;
        if (callCount === 2) {
          return jsonResponse({ name: "validation_error", message: "bad domain" }, 400);
        }
        return jsonResponse({ id: `re_msg_blast_${callCount}` });
      }
      throw new Error(`unmatched fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!blast partial test"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Blasted to 2 (1 failed)."]);
  });
});

describe("P2-11 !blast — no `all` group configured", () => {
  test("address book has no `all` alias: rejected before any Resend call", async () => {
    env = makeTestEnv({ ADDRESS_BOOK_JSON: NO_ALL_BOOK });
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!blast hello"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["No blast group configured."]);
  });
});

describe("P2-11 !blast — idempotency + ledger", () => {
  test("replay does not double-send; ledger records cmd=blast at $0", async () => {
    env = makeTestEnv({ ADDRESS_BOOK_JSON: ALL_BOOK_2 });
    fetchSpy = vi.fn(async (url: URL | RequestInfo) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("api.resend.com")) return jsonResponse({ id: "re_msg_replay" });
      throw new Error(`unmatched fetch: ${u}`);
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const ev = envelope("!blast replay test", { ts: 8888 });
    await postIpc(ev);
    await postIpc(ev);

    const resendCalls = fetchSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("api.resend.com"),
    );
    // First call: 2 sends (one per recipient). Second call: 0 (cached blast op).
    expect(resendCalls).toHaveLength(2);

    const snap = await monthlyTotals(env);
    expect(snap.by_command["blast"]).toEqual({ requests: 1, usd_cost: 0 });
  });
});
