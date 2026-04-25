import { describe, test, expect, beforeEach, vi } from "vitest";
import { appendEvent, recentEvents, type ContextEvent } from "../src/core/context.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;

beforeEach(() => {
  env = makeTestEnv();
});

const evt = (overrides: Partial<ContextEvent> = {}): ContextEvent => ({
  timestamp: 1739802015000,
  command_type: "post",
  free_text: "!post hello",
  ...overrides,
});

describe("recentEvents — cold start", () => {
  test("returns [] for an IMEI with no history", async () => {
    const events = await recentEvents("123456789012345", env);
    expect(events).toEqual([]);
  });
});

describe("appendEvent + recentEvents — rolling window", () => {
  test("appended events are returned newest-first", async () => {
    await appendEvent("123456789012345", evt({ timestamp: 1, free_text: "first" }), env);
    await appendEvent("123456789012345", evt({ timestamp: 2, free_text: "second" }), env);
    await appendEvent("123456789012345", evt({ timestamp: 3, free_text: "third" }), env);
    const events = await recentEvents("123456789012345", env);
    expect(events.map((e) => e.free_text)).toEqual(["third", "second", "first"]);
  });

  test("appending a 6th event drops the oldest; 5 retained", async () => {
    for (let i = 1; i <= 6; i += 1) {
      await appendEvent(
        "123456789012345",
        evt({ timestamp: i, free_text: `evt-${i}` }),
        env,
      );
    }
    const events = await recentEvents("123456789012345", env);
    expect(events).toHaveLength(5);
    expect(events.map((e) => e.free_text)).toEqual([
      "evt-6",
      "evt-5",
      "evt-4",
      "evt-3",
      "evt-2",
    ]);
  });

  test("lat/lon are optional — events without GPS round-trip cleanly", async () => {
    await appendEvent("123456789012345", evt({ timestamp: 10 }), env);
    await appendEvent(
      "123456789012345",
      evt({ timestamp: 20, lat: 37.1682, lon: -118.5891 }),
      env,
    );
    const events = await recentEvents("123456789012345", env);
    expect(events[0].lat).toBeCloseTo(37.1682, 4);
    expect(events[1].lat).toBeUndefined();
    expect(events[1].lon).toBeUndefined();
  });

  test("per-IMEI isolation: events for one IMEI do not leak to another", async () => {
    await appendEvent("123456789012345", evt({ free_text: "alice" }), env);
    await appendEvent("999999999999999", evt({ free_text: "bob" }), env);
    const alice = await recentEvents("123456789012345", env);
    const bob = await recentEvents("999999999999999", env);
    expect(alice.map((e) => e.free_text)).toEqual(["alice"]);
    expect(bob.map((e) => e.free_text)).toEqual(["bob"]);
  });
});

describe("KV semantics", () => {
  test("each append writes ctx:<imei> with TTL 30 days, extended on every append", async () => {
    const putSpy = vi.spyOn(env.TS_CONTEXT, "put");
    await appendEvent("123456789012345", evt({ timestamp: 1 }), env);
    await appendEvent("123456789012345", evt({ timestamp: 2 }), env);
    expect(putSpy).toHaveBeenCalledTimes(2);
    for (const call of putSpy.mock.calls) {
      expect(String(call[0])).toBe("ctx:123456789012345");
      const opts = call[2] as { expirationTtl?: number } | undefined;
      expect(opts?.expirationTtl).toBe(60 * 60 * 24 * 30);
    }
  });
});
