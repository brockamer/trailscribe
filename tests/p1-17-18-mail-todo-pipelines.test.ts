/**
 * P1-17 + P1-18 — End-to-end integration tests for !mail and !todo pipelines.
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

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function envelope(freeText: string, opts: { ts?: number; gps?: { lat: number; lon: number } } = {}) {
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
  routes: Array<{ match: (url: string, init?: RequestInit) => boolean; respond: () => Response | Promise<Response> }>,
) {
  return vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    for (const r of routes) {
      if (r.match(u, init)) return await r.respond();
    }
    throw new Error(`unmatched fetch: ${u}`);
  });
}

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv({ MAPSHARE_BASE: "https://share.garmin.com/MyMap" });
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

describe("P1-17 !mail — happy path with GPS", () => {
  test("calls geocode + weather + Resend; reply contains 'Sent to <to>' + map link", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("nominatim.openstreetmap.org"),
        respond: () =>
          jsonResponse({
            display_name: "Lake Sabrina, Inyo County, California",
            address: { locality: "Lake Sabrina", state: "California" },
          }),
      },
      {
        match: (u) => u.includes("api.open-meteo.com"),
        respond: () =>
          jsonResponse({
            current: { temperature_2m: 46, wind_speed_10m: 8, weather_code: 0 },
          }),
      },
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_abc" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!mail to:friend@example.com subj:hi body:from the field", { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    const joined = messages.join(" ");
    expect(joined).toContain("Sent to friend@example.com");
    // Device reply must not carry map links — location stays in the email footer.
    expect(joined).not.toContain("google.com/maps");
    expect(joined).not.toContain("share.garmin.com");

    // Verify Resend got the enriched body with location footer.
    const resendCall = fetchSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === "string" && c[0].includes("api.resend.com"),
    );
    expect(resendCall).toBeDefined();
    const resendBody = JSON.parse((resendCall![1] as RequestInit).body as string) as {
      from: string;
      to: string;
      subject: string;
      text: string;
    };
    expect(resendBody.text).toContain("from the field");
    expect(resendBody.text).toContain("From inReach @ Lake Sabrina, California");
    expect(resendBody.text).toContain("(37.1682,-118.5891");
  });
});

describe("P1-17 !mail — no GPS", () => {
  test("skips geocode + weather; footer omits location; reply omits map link", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ id: "re_msg_abc" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!mail to:friend@example.com subj:hi body:hello"));

    const calls = fetchSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((u: string) => u.includes("nominatim"))).toBe(false);
    expect(calls.some((u: string) => u.includes("open-meteo"))).toBe(false);

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages.join(" ")).not.toContain("https://www.google.com/maps");

    const resendCall = fetchSpy.mock.calls[0];
    const resendBody = JSON.parse((resendCall[1] as RequestInit).body as string) as { text: string };
    expect(resendBody.text).toContain("hello");
    expect(resendBody.text).toContain("From inReach — sent");
    expect(resendBody.text).not.toContain("From inReach @");
  });
});

describe("P1-17 !mail — bad email address", () => {
  test("rejects syntactically invalid 'to' before any send", async () => {
    fetchSpy = vi.fn(async () => {
      throw new Error("should not have called fetch");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!mail to:not-an-email subj:hi body:x"));

    expect(fetchSpy).not.toHaveBeenCalled();
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toMatch(/^Bad to:/);
  });
});

describe("P1-17 !mail — Resend 4xx", () => {
  test("400 → 'Mail failed: ...'; markFailed", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => jsonResponse({ name: "validation_error", message: "bad domain" }, 400),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!mail to:friend@example.com subj:hi body:x"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toMatch(/^Mail failed:/);
  });
});

describe("P1-17 !mail — replay safety", () => {
  test("first run sends; replay does not call Resend again", async () => {
    let resendCalls = 0;
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.resend.com"),
        respond: () => {
          resendCalls += 1;
          return jsonResponse({ id: "re_msg" });
        },
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!mail to:friend@example.com subj:hi body:x"));
    expect(resendCalls).toBe(1);

    await postIpc(envelope("!mail to:friend@example.com subj:hi body:x"));
    // status="completed" short-circuits at app.ts level; Resend not called again.
    expect(resendCalls).toBe(1);
  });
});

describe("P1-18 !todo — happy path", () => {
  test("creates Todoist task; reply includes task URL", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.todoist.com"),
        respond: () => jsonResponse({ id: "task-123" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!todo file expense report", { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    const joined = messages.join(" ");
    expect(joined).toContain("Task added · https://todoist.com/showTask?id=task-123");
    // Device reply must not carry map links — location stays in the Todoist description.
    expect(joined).not.toContain("google.com/maps");
    expect(joined).not.toContain("share.garmin.com");

    // Verify the task description carried lat/lon.
    const todoistCall = fetchSpy.mock.calls[0];
    const todoistBody = JSON.parse((todoistCall[1] as RequestInit).body as string) as {
      content: string;
      description: string;
    };
    expect(todoistBody.content).toBe("file expense report");
    expect(todoistBody.description).toContain("37.1682,-118.5891");
  });

  test("ledger transaction recorded as 0-cost", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.todoist.com"),
        respond: () => jsonResponse({ id: "task-xyz" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!todo do thing"));

    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(1);
    expect(snap.usd_cost).toBe(0);
    expect(snap.by_command["todo"]?.requests).toBe(1);
  });
});

describe("P1-18 !todo — no GPS", () => {
  test("description omits coords cleanly when no GPS fix", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.todoist.com"),
        respond: () => jsonResponse({ id: "task-no-gps" }),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!todo no fix"));

    const todoistBody = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as {
      description: string;
    };
    expect(todoistBody.description).not.toContain(",");
    expect(todoistBody.description).not.toContain("0,0");
  });
});

describe("P1-18 !todo — Todoist 4xx", () => {
  test("400 → 'Todo failed: ...'", async () => {
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.todoist.com"),
        respond: () => jsonResponse({ error: "bad token" }, 400),
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!todo x"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toMatch(/^Todo failed:/);
  });
});

describe("P1-18 !todo — replay safety", () => {
  test("first run creates; replay does not call Todoist again", async () => {
    let todoistCalls = 0;
    fetchSpy = makeFetchRouter([
      {
        match: (u) => u.includes("api.todoist.com"),
        respond: () => {
          todoistCalls += 1;
          return jsonResponse({ id: "t-1" });
        },
      },
    ]);
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await postIpc(envelope("!todo replay test"));
    expect(todoistCalls).toBe(1);

    await postIpc(envelope("!todo replay test"));
    expect(todoistCalls).toBe(1);
  });
});
