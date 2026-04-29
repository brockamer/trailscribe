/**
 * P2-05 — End-to-end integration tests for !drop pipeline.
 *
 * Asserts:
 *   - Happy path: appends to FieldLog; reply names the preview + total count.
 *   - Empty note: rejected before any FieldLog write.
 *   - Replay: a Garmin retry of the same event yields no second entry; reply
 *     stays consistent.
 *   - Long note: preview is capped at 40 chars; full note persists in FieldLog.
 *   - Ledger records `cmd: 'drop'` at $0.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { makeApp } from "../src/app.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";
import { monthlyTotals } from "../src/core/ledger.js";
import { getEntries } from "../src/core/fieldlog.js";

import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";

vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", () => ({
  sendReply: vi.fn().mockResolvedValue({ count: 1 }),
}));

const sendReplyMock = vi.mocked(sendReply);

let app: ReturnType<typeof makeApp>;
let env: Env;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

const IMEI = "123456789012345";
const LAT = 37.1682;
const LON = -118.5891;

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
        imei: IMEI,
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

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv();
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue({ count: 1 });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe("P2-05 !drop — happy path", () => {
  test("appends to FieldLog and replies with preview + count", async () => {
    await postIpc(envelope("!drop saw a deer", { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Logged: saw a deer. (1 entries)"]);

    const entries = await getEntries(env, IMEI);
    expect(entries).toHaveLength(1);
    expect(entries[0].note).toBe("saw a deer");
    expect(entries[0].lat).toBe(LAT);
    expect(entries[0].lon).toBe(LON);
    expect(entries[0].source).toBe("drop");
  });

  test("preview is capped at 40 chars; full note persists in FieldLog", async () => {
    const longNote =
      "this is a really long observation note that exceeds the forty-character preview budget by a lot";
    await postIpc(envelope(`!drop ${longNote}`, { gps: { lat: LAT, lon: LON } }));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toContain("Logged: ");
    expect(messages[0]).toContain("(1 entries)");
    // Reply uses 40-char preview, not the full note.
    expect(messages[0]).toContain(longNote.slice(0, 40));
    expect(messages[0]).not.toContain(longNote);

    const entries = await getEntries(env, IMEI);
    expect(entries[0].note).toBe(longNote);
  });

  test("multiple entries: count reflects total in FieldLog", async () => {
    await postIpc(envelope("!drop entry one", { ts: 1, gps: { lat: LAT, lon: LON } }));
    await postIpc(envelope("!drop entry two", { ts: 2, gps: { lat: LAT, lon: LON } }));
    await postIpc(envelope("!drop entry three", { ts: 3, gps: { lat: LAT, lon: LON } }));

    const lastReply = sendReplyMock.mock.calls[2][1];
    expect(lastReply[0]).toBe("Logged: entry three. (3 entries)");

    const entries = await getEntries(env, IMEI);
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.note)).toEqual(["entry one", "entry two", "entry three"]);
  });

  test("records a 0-cost ledger transaction tagged cmd=drop", async () => {
    await postIpc(envelope("!drop telemetry test", { gps: { lat: LAT, lon: LON } }));

    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(1);
    expect(snap.usd_cost).toBe(0);
    expect(snap.by_command["drop"]).toEqual({ requests: 1, usd_cost: 0 });
  });
});

describe("P2-05 !drop — empty note", () => {
  test("rejected at parse time; no FieldLog write", async () => {
    // Grammar requires a non-empty rest-of-line. An argless !drop falls through
    // to the unknown-command path, so the handler never runs.
    await postIpc(envelope("!drop"));

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Unknown command. Try !help"]);

    const entries = await getEntries(env, IMEI);
    expect(entries).toHaveLength(0);
  });
});

describe("P2-05 !drop — idempotency", () => {
  test("replay of the same event yields no second entry; reply stays consistent", async () => {
    const env1 = envelope("!drop replay test", { ts: 9999, gps: { lat: LAT, lon: LON } });

    await postIpc(env1);
    await postIpc(env1); // identical timeStamp + content → identical idemKey

    const entries = await getEntries(env, IMEI);
    expect(entries).toHaveLength(1);

    // First call produces "(1 entries)"; second call short-circuits at the
    // app-layer idempotency cache and reuses the same reply, so we don't see
    // a "(2 entries)" reply.
    const replies = sendReplyMock.mock.calls.map((c) => c[1][0]);
    expect(replies[0]).toBe("Logged: replay test. (1 entries)");
  });
});
