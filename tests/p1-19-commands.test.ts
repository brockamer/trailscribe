/**
 * P1-19 — End-to-end integration tests for !ping, !help, !cost.
 *
 * Drives the Worker via app.request(...) with a real orchestrator and a
 * mocked sendReply. Asserts:
 *   - Each command's body content matches the spec.
 *   - sendReply receives the buildReply'd page array.
 *   - !ping records a 0-cost transaction visible to !cost.
 *   - GPS-bearing !ping picks up map links via buildReply.
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
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv({ MAPSHARE_BASE: "https://share.garmin.com/MyMap" });
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue({ count: 1 });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

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
        timeStamp: opts.ts ?? Date.now(),
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

describe("P1-19 — !ping", () => {
  test("returns 'pong' as a single-page reply, no GPS → no map link", async () => {
    const res = await postIpc(envelope("!ping"));
    expect(res.status).toBe(200);

    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    const [imei, messages] = sendReplyMock.mock.calls[0];
    expect(imei).toBe("123456789012345");
    expect(messages).toEqual(["pong"]);
  });

  test("with GPS fix → reply is just 'pong' (no map links on device)", async () => {
    const res = await postIpc(
      envelope("!ping", { gps: { lat: 37.1682, lon: -118.5891 } }),
    );
    expect(res.status).toBe(200);

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["pong"]);
  });

  test("records a 0-cost transaction in the ledger", async () => {
    await postIpc(envelope("!ping"));
    await postIpc(envelope("!ping", { ts: Date.now() + 1 })); // distinct idem key

    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(2);
    expect(snap.usd_cost).toBe(0);
    expect(snap.by_command["ping"]).toEqual({ requests: 2, usd_cost: 0 });
  });
});

describe("P1-19 — !help", () => {
  test("returns the static help text on a single page (~92 chars)", async () => {
    const res = await postIpc(envelope("!help"));
    expect(res.status).toBe(200);

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("!ping");
    expect(messages[0]).toContain("!post");
    expect(messages[0]).toContain("!mail");
    expect(messages[0]).toContain("!todo");
    expect(messages[0]).toContain("!cost");
    expect(messages[0].length).toBeLessThanOrEqual(160);
  });

  test("does not record a ledger transaction (free informational command)", async () => {
    await postIpc(envelope("!help"));
    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(0);
  });
});

describe("P1-19 — !cost", () => {
  test("empty ledger → '0 req · 0.0k tok · $0.00 (since YYYY-MM-01)'", async () => {
    const res = await postIpc(envelope("!cost"));
    expect(res.status).toBe(200);

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toHaveLength(1);
    const expectedDate = new Date().toISOString().slice(0, 7) + "-01";
    expect(messages[0]).toBe(`0 req · 0.0k tok · $0.00 (since ${expectedDate})`);
    expect(messages[0].length).toBeLessThanOrEqual(80);
  });

  test("after recorded transactions → reflects requests + tokens + cost", async () => {
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 1500, completion_tokens: 500 },
      env: makeTestEnv({
        ...env,
        LLM_INPUT_COST_PER_1K: "0.10",
        LLM_OUTPUT_COST_PER_1K: "0.30",
      }),
    });
    // Same env shape used by the request handler — write the same KV namespace.
    Object.assign(env, {
      LLM_INPUT_COST_PER_1K: "0.10",
      LLM_OUTPUT_COST_PER_1K: "0.30",
    });

    const res = await postIpc(envelope("!cost"));
    expect(res.status).toBe(200);

    const [, messages] = sendReplyMock.mock.calls[0];
    // 2000 tokens total → "2.0k tok"; 1500*0.0001 + 500*0.0003 = 0.15 + 0.15 = $0.30
    expect(messages[0]).toMatch(/^1 req · 2\.0k tok · \$0\.30 \(since \d{4}-\d{2}-01\)$/);
  });

  test("does not record a ledger transaction itself (would skew its own output)", async () => {
    const before = await monthlyTotals(env);
    await postIpc(envelope("!cost"));
    const after = await monthlyTotals(env);
    expect(after.requests).toBe(before.requests);
  });
});

describe("P1-19 — APPEND_COST_SUFFIX integration", () => {
  test("when enabled, !ping reply ends with ` · $X.XX`", async () => {
    env.APPEND_COST_SUFFIX = "true";
    // Seed the ledger with a non-zero cost so the suffix is visible.
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 1000, completion_tokens: 0 },
      env: makeTestEnv({ ...env, LLM_INPUT_COST_PER_1K: "0.07" }),
    });
    Object.assign(env, { LLM_INPUT_COST_PER_1K: "0.07" });

    await postIpc(envelope("!ping"));
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toContain("pong");
    expect(messages[0]).toMatch(/· \$\d+\.\d{2}$/);
  });

  test("when disabled (default), no suffix is appended", async () => {
    await postIpc(envelope("!ping"));
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages[0]).toBe("pong");
  });
});

describe("P1-19 — unknown command path", () => {
  test("unparseable text → 'Unknown command. Try !help' delivered, no ledger entry", async () => {
    const res = await postIpc(envelope("not a command"));
    expect(res.status).toBe(200);

    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages).toEqual(["Unknown command. Try !help"]);

    const snap = await monthlyTotals(env);
    expect(snap.requests).toBe(0);
  });
});
