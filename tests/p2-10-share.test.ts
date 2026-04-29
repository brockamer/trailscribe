/**
 * P2-10 — End-to-end integration tests for !share pipeline.
 *
 * Asserts:
 *   - Alias path: `to:home` resolves via address book; Resend gets the right addr.
 *   - Literal email path: `to:friend@x.com` skips the alias lookup.
 *   - Unknown alias: rejected before any Resend call.
 *   - Bad literal email: rejected.
 *   - GPS path: email body has Maps link + place name.
 *   - No-GPS path: email body has plain footer; reply is `Shared (no GPS).`.
 *   - Idempotency: replay does not double-send.
 *   - Ledger: 0-cost share entry.
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

const LAT = 37.1682;
const LON = -118.5891;

const ADDRESS_BOOK = JSON.stringify({
  aliases: {
    home: "you@example.com",
    mom: "mom@example.com",
    all: "you@example.com,mom@example.com",
  },
});

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envelope(
  freeText: string,
  opts: { ts?: number; gps?: { lat: number; lon: number } } = {},
) {
  const point = opts.gps
    ? { latitude: opts.gps.lat, longitude: opts.gps.lon, altitude: 1000, gpsFix: 2 }
    : { latitude: 0, longitude: 0, altitude: 0, gpsFix: 0 };
  return {
    Version: "2.0",
    Events: [
      {
        imei: "123456789012345",
        messageCode: 3,
        freeText,
        timeStamp: opts.ts ?? 1700000000000,
        point,
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
  env = makeTestEnv({ ADDRESS_BOOK_JSON: ADDRESS_BOOK });
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

describe("P2-10 !share — alias resolution", () => {
  test("alias `home` resolves to mapped email; Resend called with that recipient", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("nominatim.openstreetmap.org"),
        respond: () => jsonResponse({ address: { locality: "Lake Sabrina", state: "California" } }),
      },
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_share" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!share to:home stopped at lake", { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Shared with home."]);

    const resendCall = fetchSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("api.resend.com"),
    );
    expect(resendCall).toBeDefined();
    const sentBody = JSON.parse((resendCall![1] as RequestInit).body as string) as {
      to: string;
      subject: string;
      text: string;
    };
    expect(sentBody.to).toBe("you@example.com");
    expect(sentBody.subject).toBe("TrailScribe — note from the field");
    expect(sentBody.text).toContain("stopped at lake");
    expect(sentBody.text).toContain("Lake Sabrina");
    expect(sentBody.text).toContain(`Maps: https://www.google.com/maps/search/?api=1&query=${LAT},${LON}`);
  });

  test("unknown alias: rejected before Resend call", async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!share to:nobody hello"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toMatch(/^Unknown alias/);
  });
});

describe("P2-10 !share — literal email", () => {
  test("`to:friend@x.com` skips alias lookup and goes straight to Resend", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_literal" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!share to:friend@example.com hello there"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toMatch(/^Shared (with friend@example\.com\.|\(no GPS\)\.)$/);

    const resendCall = fetchSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("api.resend.com"),
    );
    const sentBody = JSON.parse((resendCall![1] as RequestInit).body as string) as { to: string };
    expect(sentBody.to).toBe("friend@example.com");
  });

  test("bad literal email: rejected", async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!share to:not-an-email@ hello"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toMatch(/^Bad to:/);
  });
});

describe("P2-10 !share — no GPS fix", () => {
  test("email body omits location lines; reply is `Shared (no GPS).`", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_nogps" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!share to:home no-gps test"));

    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("nominatim"))).toBe(false);

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Shared (no GPS)."]);

    const resendCall = fetchSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("api.resend.com"),
    );
    const sentBody = JSON.parse((resendCall![1] as RequestInit).body as string) as { text: string };
    expect(sentBody.text).toContain("From inReach — sent");
    expect(sentBody.text).not.toContain("Maps:");
  });
});

describe("P2-10 !share — idempotency + ledger", () => {
  test("replay does not double-send; ledger records cmd=share at $0", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_replay" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const ev = envelope("!share to:home replay test", { ts: 4321 });
    await postIpc(ev);
    await postIpc(ev);

    const resendCalls = fetchSpy.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("api.resend.com"),
    );
    expect(resendCalls).toHaveLength(1);

    const snap = await monthlyTotals(env);
    expect(snap.by_command["share"]).toEqual({ requests: 1, usd_cost: 0 });
  });
});
