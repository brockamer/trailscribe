/**
 * Fixture provenance — `tests/fixtures/garmin/*.json`:
 *
 *   free-text-ping.json
 *     Pre-existing Phase 0 fixture, relocated from `tests/fixtures/`.
 *     Palisade Glacier coords (Natalie persona). Not CSV-derived.
 *
 *   breadcrumb-position-report.json
 *     Real-derived from `~/tmp/InReach Location Tracking Log - Sheet1.csv`
 *     row ts=1739753925000 (Pipedream-era capture; some fields normalized in
 *     transit). Real lat/lon/timeStamp kept; alt=-422 m kept as a wild
 *     anomaly the device emitted. CSV's "GPS Fix Quality" column was a
 *     continuous metric (~HDOP, range 0–1145) — not Garmin's V2 `gpsFix`
 *     enum — so we normalized to enum value 2 (3D fix) for Schema V2 fidelity.
 *
 *   sos-declare.json
 *     Constructed by mutating a real mtc=2 row (mtc→4, freeText dropped).
 *     Sheet contained no real SOS rows; SOS goes through Garmin native per
 *     PRD §1, so we'd never expect the Pipedream era to capture one.
 *
 *   free-text-no-gps.json
 *     Constructed: lat/lon/alt/gpsFix all 0 per Garmin Outbound v2.0.8 §Event
 *     Schema V2: "Values are filled with 0 when there is no location
 *     information."
 *
 *   free-text-zero-coords.json
 *     Constructed defensive scenario: gpsFix=2 (claims 3D fix) while coords
 *     are 0,0. Exercises the second clause of `hasFix` in P1-01.
 */
import { describe, test, expect, beforeEach, vi, type MockInstance } from "vitest";
import { makeApp } from "../src/app.js";
import { makeTestEnv, kvSize } from "./helpers/env.js";
import type { Env } from "../src/env.js";

import freeTextPing from "./fixtures/garmin/free-text-ping.json";
import breadcrumb from "./fixtures/garmin/breadcrumb-position-report.json";
import sos from "./fixtures/garmin/sos-declare.json";
import freeTextNoGps from "./fixtures/garmin/free-text-no-gps.json";
import freeTextZeroCoords from "./fixtures/garmin/free-text-zero-coords.json";

import { orchestrate } from "../src/core/orchestrator.js";
import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";
import { idempotencyKey } from "../src/core/idempotency.js";
import type { IdempotencyRecord } from "../src/core/idempotency.js";

vi.mock("../src/core/orchestrator.js", () => ({
  orchestrate: vi.fn(),
}));
vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", () => ({
  sendReply: vi.fn(),
}));

const orchestrateMock = vi.mocked(orchestrate);
const sendReplyMock = vi.mocked(sendReply);

let app: ReturnType<typeof makeApp>;
let env: Env;
let logSpy: MockInstance<(...args: unknown[]) => void>;
let errSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv();
  orchestrateMock.mockReset();
  orchestrateMock.mockResolvedValue({ body: "pong" });
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue({ count: 1 });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

async function postIpc(body: unknown): Promise<Response> {
  return app.request(
    "/garmin/ipc",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.GARMIN_INBOUND_TOKEN}`,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

function loggedEvents(): Array<Record<string, unknown>> {
  const lines: string[] = [];
  for (const call of logSpy.mock.calls) lines.push(String(call[0]));
  for (const call of errSpy.mock.calls) lines.push(String(call[0]));
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function readIdemRecord(event: { imei: string; messageCode: number; timeStamp: number; freeText?: string; payload?: string }) {
  const k = await idempotencyKey(event);
  const raw = await env.TS_IDEMPOTENCY.get(`idem:${k}`);
  return raw === null ? null : (JSON.parse(raw) as IdempotencyRecord);
}

describe("P1-01 — messageCode guard (Guard 1)", () => {
  test("messageCode=3 with !ping dispatches to orchestrator and sends reply", async () => {
    const res = await postIpc(freeTextPing);
    expect(res.status).toBe(200);

    expect(orchestrateMock).toHaveBeenCalledTimes(1);
    const [cmd, ctx] = orchestrateMock.mock.calls[0];
    expect(cmd).toEqual({ type: "ping" });
    expect(ctx.imei).toBe("123456789012345");
    expect(ctx.lat).toBeCloseTo(37.1682, 4);
    expect(ctx.lon).toBeCloseTo(-118.5891, 4);

    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    const [imei, messages] = sendReplyMock.mock.calls[0];
    expect(imei).toBe("123456789012345");
    expect(messages).toEqual(["pong"]);

    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(1);
    const rec = await readIdemRecord(freeTextPing.Events[0]);
    expect(rec?.status).toBe("completed");
    expect(typeof (rec as IdempotencyRecord & { completedAt?: number }).completedAt).toBe("number");
  });

  test("messageCode=0 (breadcrumb) writes idempotency record but does not dispatch", async () => {
    const res = await postIpc(breadcrumb);
    expect(res.status).toBe(200);

    expect(orchestrateMock).not.toHaveBeenCalled();
    expect(sendReplyMock).not.toHaveBeenCalled();

    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(1);
    const rec = await readIdemRecord(breadcrumb.Events[0]);
    expect(rec?.status).toBe("received");

    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("non_free_text");
    expect(events).not.toContain("sos_received_ignored");
  });

  test("messageCode=4 (SOS) is ignored: dedicated log line, no orchestrator, no reply", async () => {
    const res = await postIpc(sos);
    expect(res.status).toBe(200);

    expect(orchestrateMock).not.toHaveBeenCalled();
    expect(sendReplyMock).not.toHaveBeenCalled();

    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(1);
    const rec = await readIdemRecord(sos.Events[0]);
    expect(rec?.status).toBe("received");

    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("sos_received_ignored");
  });
});

describe("P1-01 — GPS-fix guard (Guard 2)", () => {
  test("messageCode=3 with gpsFix=0 dispatches with lat/lon undefined", async () => {
    const res = await postIpc(freeTextNoGps);
    expect(res.status).toBe(200);

    expect(orchestrateMock).toHaveBeenCalledTimes(1);
    const ctx = orchestrateMock.mock.calls[0][1];
    expect(ctx.lat).toBeUndefined();
    expect(ctx.lon).toBeUndefined();
    expect(ctx.imei).toBe("123456789012345");
  });

  test("messageCode=3 with lat=0 + lon=0 + gpsFix>0 is treated as no-fix (defensive)", async () => {
    const res = await postIpc(freeTextZeroCoords);
    expect(res.status).toBe(200);

    expect(orchestrateMock).toHaveBeenCalledTimes(1);
    const ctx = orchestrateMock.mock.calls[0][1];
    expect(ctx.lat).toBeUndefined();
    expect(ctx.lon).toBeUndefined();
  });
});

describe("P1-01 — parse + orchestrate failure paths", () => {
  test("unknown command (parse returns undefined) replies with help hint", async () => {
    const unknown = {
      ...freeTextPing,
      Events: [{ ...freeTextPing.Events[0], freeText: "!banana" }],
    };
    const res = await postIpc(unknown);
    expect(res.status).toBe(200);

    expect(orchestrateMock).not.toHaveBeenCalled();
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    expect(sendReplyMock.mock.calls[0][1]).toEqual(["Unknown command. Try !help"]);

    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("parse_unknown");
  });

  test("orchestrator throwing produces an error reply and is logged", async () => {
    orchestrateMock.mockRejectedValueOnce(new Error("boom"));
    const res = await postIpc(freeTextPing);
    expect(res.status).toBe(200);

    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    expect((sendReplyMock.mock.calls[0][1] as string[])[0]).toMatch(/^Error: /);

    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("orchestrate_error");
  });

  test("sendReply throwing is caught: 200 returned, idem record stays at received", async () => {
    sendReplyMock.mockRejectedValueOnce(new Error("network down"));
    const res = await postIpc(freeTextPing);
    expect(res.status).toBe(200);

    expect(orchestrateMock).toHaveBeenCalledTimes(1);
    const rec = await readIdemRecord(freeTextPing.Events[0]);
    expect(rec?.status).toBe("received");

    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("reply_send_failed");
  });
});
