import { describe, test, expect, beforeEach, vi } from "vitest";
import { makeApp } from "../src/app.js";
import { makeTestEnv, kvSize, kvKeys } from "./helpers/env.js";
import type { Env } from "../src/env.js";
import fixture from "./fixtures/garmin/free-text-ping.json";
import { sendReply } from "../src/adapters/outbound/garmin-ipc-inbound.js";

vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", () => ({
  sendReply: vi.fn().mockResolvedValue({ count: 1 }),
}));

const sendReplyMock = vi.mocked(sendReply);

let app: ReturnType<typeof makeApp>;
let env: Env;

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv();
  sendReplyMock.mockReset();
  sendReplyMock.mockResolvedValue({ count: 1 });
});

async function postIpc(body: unknown, opts: { bearer?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bearer !== undefined) {
    headers["x-outbound-auth-token"] = opts.bearer;
  }
  return app.request(
    "/garmin/ipc",
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    env,
  );
}

describe("Worker /garmin/ipc — Phase 0 behavior", () => {
  test("accepts authorized V2 envelope and writes an idempotency entry", async () => {
    const res = await postIpc(fixture, { bearer: env.GARMIN_INBOUND_TOKEN });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(1);
    expect(kvKeys(env.TS_IDEMPOTENCY)[0]).toMatch(/^idem:[0-9a-f]{64}$/);
  });

  test("short-circuits duplicate delivery of the same event", async () => {
    const bearer = env.GARMIN_INBOUND_TOKEN;
    await postIpc(fixture, { bearer });
    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(1);
    const keysAfterFirst = kvKeys(env.TS_IDEMPOTENCY);

    const second = await postIpc(fixture, { bearer });
    expect(second.status).toBe(200);
    // Still exactly one record — second call short-circuited before write.
    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(1);
    expect(kvKeys(env.TS_IDEMPOTENCY)).toEqual(keysAfterFirst);
  });

  test("rejects missing bearer silently (200 + no KV write, avoids Garmin retry cascade)", async () => {
    const res = await postIpc(fixture);
    expect(res.status).toBe(200);
    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(0);
  });

  test("rejects wrong bearer silently (200, no KV write)", async () => {
    const res = await postIpc(fixture, { bearer: "wrong-token" });
    expect(res.status).toBe(200);
    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(0);
  });

  test("drops events whose IMEI is not in the allowlist", async () => {
    const rogue = {
      ...fixture,
      Events: [{ ...fixture.Events[0], imei: "999999999999999" }],
    };
    const res = await postIpc(rogue, { bearer: env.GARMIN_INBOUND_TOKEN });
    expect(res.status).toBe(200);
    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(0);
  });

  test("tolerates malformed JSON (200 OK, no crash)", async () => {
    const res = await app.request(
      "/garmin/ipc",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-outbound-auth-token": env.GARMIN_INBOUND_TOKEN,
        },
        body: "{ this is not json",
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(0);
  });

  test("tolerates envelopes with unexpected shape (200 OK, no crash)", async () => {
    const res = await postIpc({ foo: "bar" }, { bearer: env.GARMIN_INBOUND_TOKEN });
    expect(res.status).toBe(200);
    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(0);
  });

  test("idempotency key is deterministic across independent envs", async () => {
    await postIpc(fixture, { bearer: env.GARMIN_INBOUND_TOKEN });
    const keysEnv1 = kvKeys(env.TS_IDEMPOTENCY);

    const env2 = makeTestEnv();
    const app2 = makeApp();
    await app2.request(
      "/garmin/ipc",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-outbound-auth-token": env2.GARMIN_INBOUND_TOKEN,
        },
        body: JSON.stringify(fixture),
      },
      env2,
    );
    const keysEnv2 = kvKeys(env2.TS_IDEMPOTENCY);

    expect(keysEnv1).toEqual(keysEnv2);
  });
});

describe("Worker /garmin/ipc — intercept policy (PRD §8 D10, #122)", () => {
  function envelopeWithFreeText(freeText: string) {
    return {
      ...fixture,
      Events: [{ ...fixture.Events[0], freeText, timeStamp: 1700000000000 }],
    };
  }

  test("non-! text is silent-dropped: 200 OK, no IPC reply, idempotency key still recorded", async () => {
    const res = await postIpc(envelopeWithFreeText("hi mom, made it to camp"), {
      bearer: env.GARMIN_INBOUND_TOKEN,
    });
    expect(res.status).toBe(200);
    expect(sendReplyMock).not.toHaveBeenCalled();
    // Idempotency record exists so Garmin retries short-circuit.
    expect(kvSize(env.TS_IDEMPOTENCY)).toBe(1);
  });

  test("empty freeText is silent-dropped: 200 OK, no IPC reply", async () => {
    const res = await postIpc(envelopeWithFreeText(""), { bearer: env.GARMIN_INBOUND_TOKEN });
    expect(res.status).toBe(200);
    expect(sendReplyMock).not.toHaveBeenCalled();
  });

  test("whitespace-only freeText is silent-dropped: 200 OK, no IPC reply", async () => {
    const res = await postIpc(envelopeWithFreeText("   \t  "), {
      bearer: env.GARMIN_INBOUND_TOKEN,
    });
    expect(res.status).toBe(200);
    expect(sendReplyMock).not.toHaveBeenCalled();
  });

  test("!-prefixed unknown verb still gets 'Try !help' (typo recoverability preserved)", async () => {
    const res = await postIpc(envelopeWithFreeText("!pst hi"), {
      bearer: env.GARMIN_INBOUND_TOKEN,
    });
    expect(res.status).toBe(200);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
    const [, messages] = sendReplyMock.mock.calls[0];
    expect(messages.join(" ")).toContain("Try !help");
  });

  test("leading whitespace before ! is tolerated (treated as command, not silent-dropped)", async () => {
    const res = await postIpc(envelopeWithFreeText("  !ping"), {
      bearer: env.GARMIN_INBOUND_TOKEN,
    });
    expect(res.status).toBe(200);
    expect(sendReplyMock).toHaveBeenCalledTimes(1);
  });
});

describe("Worker /garmin/ipc — LOG_TRACK_PAYLOADS diagnostic", () => {
  let consoleLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  function trackEvent(messageCode: number) {
    return {
      Version: "2.0",
      Events: [
        {
          imei: "123456789012345",
          messageCode,
          timeStamp: 1739753925000,
          point: {
            latitude: 34.0379,
            longitude: -118.6916,
            altitude: 12,
            gpsFix: 2,
            course: 215,
            speed: 8.4,
          },
          status: { autonomous: 1, lowBattery: 0, intervalChange: 0, resetDetected: 0 },
        },
      ],
    };
  }

  function nonFreeTextLogs(): Array<Record<string, unknown>> {
    return consoleLog.mock.calls
      .map((args) => {
        try {
          return JSON.parse(String(args[0])) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry?.event === "non_free_text");
  }

  test("default (LOG_TRACK_PAYLOADS=false): non_free_text log omits payload", async () => {
    const res = await postIpc(trackEvent(0), { bearer: env.GARMIN_INBOUND_TOKEN });
    expect(res.status).toBe(200);
    const logs = nonFreeTextLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toHaveProperty("payload");
    expect(logs[0].messageCode).toBe(0);
  });

  test.each([0, 10, 11, 12])(
    "LOG_TRACK_PAYLOADS=true: messageCode %i carries full event payload in log",
    async (messageCode) => {
      env = makeTestEnv({ LOG_TRACK_PAYLOADS: "true" });
      const res = await postIpc(trackEvent(messageCode), {
        bearer: env.GARMIN_INBOUND_TOKEN,
      });
      expect(res.status).toBe(200);
      const logs = nonFreeTextLogs();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toHaveProperty("payload");
      expect((logs[0].payload as { messageCode: number }).messageCode).toBe(messageCode);
      expect((logs[0].payload as { point?: { latitude: number } }).point?.latitude).toBe(34.0379);
    },
  );

  test("LOG_TRACK_PAYLOADS=true does NOT attach payload for non-tracking codes (e.g. 64)", async () => {
    env = makeTestEnv({ LOG_TRACK_PAYLOADS: "true" });
    const res = await postIpc(trackEvent(64), { bearer: env.GARMIN_INBOUND_TOKEN });
    expect(res.status).toBe(200);
    const logs = nonFreeTextLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toHaveProperty("payload");
  });
});

describe("Worker sanity routes", () => {
  test("GET / returns banner", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("TrailScribe");
  });

  test("GET /health returns env + timestamp + dry_run JSON", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      env: string;
      timestamp: string;
      dry_run: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.env).toBe("test");
    expect(typeof body.timestamp).toBe("string");
    expect(body.dry_run).toBe(false);
  });
});
