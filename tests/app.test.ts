import { describe, test, expect, beforeEach, vi } from "vitest";
import { makeApp } from "../src/app.js";
import { makeTestEnv, kvSize, kvKeys } from "./helpers/env.js";
import type { Env } from "../src/env.js";
import fixture from "./fixtures/garmin/free-text-ping.json";

vi.mock("../src/adapters/outbound/garmin-ipc-inbound.js", () => ({
  sendReply: vi.fn().mockResolvedValue({ count: 1 }),
}));

let app: ReturnType<typeof makeApp>;
let env: Env;

beforeEach(() => {
  app = makeApp();
  env = makeTestEnv();
});

async function postIpc(body: unknown, opts: { bearer?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bearer !== undefined) {
    headers["authorization"] = `Bearer ${opts.bearer}`;
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
          authorization: `Bearer ${env.GARMIN_INBOUND_TOKEN}`,
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
          authorization: `Bearer ${env2.GARMIN_INBOUND_TOKEN}`,
        },
        body: JSON.stringify(fixture),
      },
      env2,
    );
    const keysEnv2 = kvKeys(env2.TS_IDEMPOTENCY);

    expect(keysEnv1).toEqual(keysEnv2);
  });
});

describe("Worker sanity routes", () => {
  test("GET / returns banner", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("TrailScribe");
  });

  test("GET /health returns env + timestamp JSON", async () => {
    const res = await app.request("/health", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; env: string; timestamp: string };
    expect(body.ok).toBe(true);
    expect(body.env).toBe("test");
    expect(typeof body.timestamp).toBe("string");
  });
});
