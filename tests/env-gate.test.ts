/**
 * #212 — the env schema runs on the `/garmin/ipc` request path.
 *
 * Before #212, `parseEnv()` ran only in tests, so a malformed IMEI_ALLOWLIST
 * dropped every event as `imei_not_allowed` (warn) and production dry-run sent
 * nothing, both with HTTP 200 and no error. Decisions (recorded on #212): a
 * malformed env still answers 200 — Garmin's retry escalator cannot repair
 * config — and any schema failure stops the request before events are read.
 */
import { describe, test, expect, beforeEach, vi, type MockInstance } from "vitest";
import { makeApp } from "../src/app.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";
import freeTextPing from "./fixtures/garmin/free-text-ping.json";

import { orchestrate } from "../src/core/orchestrator.js";
import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";

vi.mock("../src/core/orchestrator.js", () => ({
  orchestrate: vi.fn(),
}));
vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", () => ({
  sendReply: vi.fn(),
}));

const orchestrateMock = vi.mocked(orchestrate);
const sendReplyMock = vi.mocked(sendReply);

let app: ReturnType<typeof makeApp>;
let logSpy: MockInstance<(...args: unknown[]) => void>;
let errSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  app = makeApp();
  orchestrateMock.mockReset();
  orchestrateMock.mockResolvedValue({ body: "pong" });
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue({ count: 1 });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

async function postIpc(env: Env, token = env.GARMIN_INBOUND_TOKEN): Promise<Response> {
  return app.request(
    "/garmin/ipc",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-outbound-auth-token": token },
      body: JSON.stringify(freeTextPing),
    },
    env,
  );
}

function rawLogLines(): string[] {
  return [...logSpy.mock.calls, ...errSpy.mock.calls].map((call) => String(call[0]));
}

function loggedEvents(): Array<Record<string, unknown>> {
  return rawLogLines().map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("#212 — env gate on /garmin/ipc", () => {
  test("valid env: the event is processed as before", async () => {
    const res = await postIpc(makeTestEnv());
    expect(res.status).toBe(200);
    expect(orchestrateMock).toHaveBeenCalledTimes(1);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    expect(loggedEvents().map((e) => e.event)).not.toContain("env_invalid");
  });

  test("malformed IMEI_ALLOWLIST: 200, error log naming the variable, no event processed", async () => {
    // A dropped digit. (A trailing newline is not malformed: imeiAllowSet trims
    // it, so the gate tolerates it too — see env.test.ts.)
    const badAllowlist = "12345678901234";
    const res = await postIpc(makeTestEnv({ IMEI_ALLOWLIST: badAllowlist }));

    expect(res.status).toBe(200);
    expect(orchestrateMock).not.toHaveBeenCalled();
    expect(sendReplyMock).not.toHaveBeenCalled();

    const events = loggedEvents();
    const invalid = events.find((e) => e.event === "env_invalid");
    expect(invalid?.level).toBe("error");
    expect(invalid?.variables).toEqual(["IMEI_ALLOWLIST"]);
    // The gate replaces the silent per-event drop, not adds to it.
    expect(events.map((e) => e.event)).not.toContain("imei_not_allowed");
  });

  test("the error log never carries a variable's value", async () => {
    const secretish = "999999999999999,not-an-imei";
    await postIpc(makeTestEnv({ IMEI_ALLOWLIST: secretish, IPC_SCHEMA_VERSION: "9" as "2" }));

    const line = rawLogLines().find((l) => l.includes('"env_invalid"'));
    expect(line).toBeDefined();
    expect(line).not.toContain("999999999999999");
    expect(line).not.toContain("not-an-imei");
    // zod's enum message echoes the received value ("received '9'"); only
    // variable and rule names may reach the log.
    expect(line).not.toMatch(/received/i);
    // Schema order, not argument order.
    expect(JSON.parse(line!).variables).toEqual(["IPC_SCHEMA_VERSION", "IMEI_ALLOWLIST"]);
  });

  test("IPC_INBOUND_DRY_RUN=true in production is refused: no event processed", async () => {
    const res = await postIpc(
      makeTestEnv({ TRAILSCRIBE_ENV: "production", IPC_INBOUND_DRY_RUN: "true" }),
    );

    expect(res.status).toBe(200);
    expect(orchestrateMock).not.toHaveBeenCalled();
    expect(sendReplyMock).not.toHaveBeenCalled();

    const invalid = loggedEvents().find((e) => e.event === "env_invalid");
    expect(invalid?.level).toBe("error");
    expect(invalid?.problems).toEqual([
      { variable: "IPC_INBOUND_DRY_RUN", rule: "forbidden_in_production" },
    ]);
  });

  test("a broken env still logs ipc_received, so the lost message is on record", async () => {
    await postIpc(makeTestEnv({ IMEI_ALLOWLIST: "" }));
    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("ipc_received");
    expect(events.indexOf("ipc_received")).toBeLessThan(events.indexOf("env_invalid"));
  });

  test("an unauthenticated POST never reaches the gate (no error-log noise)", async () => {
    await postIpc(makeTestEnv({ IMEI_ALLOWLIST: "" }), "wrong-token-0123456789");
    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("auth_fail");
    expect(events).not.toContain("env_invalid");
  });
});

describe("#212 — GET /health reports env validity (boolean only)", () => {
  async function health(env: Env): Promise<Record<string, unknown>> {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  test("valid env → env_ok true, nothing logged", async () => {
    const body = await health(makeTestEnv());
    expect(body.ok).toBe(true);
    expect(body.env_ok).toBe(true);
    expect(loggedEvents().map((e) => e.event)).not.toContain("env_invalid");
  });

  test("malformed env → env_ok false; names go to the log, never to the public body", async () => {
    const body = await health(makeTestEnv({ IMEI_ALLOWLIST: "999999999999999,x" }));
    // Liveness is unchanged: the Worker is up, its config is not.
    expect(body.ok).toBe(true);
    expect(body.env_ok).toBe(false);
    const text = JSON.stringify(body);
    expect(text).not.toContain("IMEI_ALLOWLIST");
    expect(text).not.toContain("999999999999999");

    const invalid = loggedEvents().find((e) => e.event === "env_invalid");
    expect(invalid?.level).toBe("error");
    expect(invalid?.path).toBe("/health");
    expect(invalid?.variables).toEqual(["IMEI_ALLOWLIST"]);
    expect(rawLogLines().join("\n")).not.toContain("999999999999999");
  });
});
