import { describe, test, expect, beforeEach, vi } from "vitest";
import { appendEntry, getEntries, type FieldLogEntry } from "../src/core/fieldlog.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;

beforeEach(() => {
  env = makeTestEnv();
});

const entry = (overrides: Partial<FieldLogEntry> = {}): FieldLogEntry => ({
  id: "idem-key-default",
  ts: 1739802015000,
  note: "saw a marmot",
  source: "drop",
  ...overrides,
});

const IMEI = "123456789012345";

describe("getEntries — cold start", () => {
  test("returns [] for an IMEI with no history", async () => {
    expect(await getEntries(env, IMEI)).toEqual([]);
  });
});

describe("appendEntry + getEntries — round-trip", () => {
  test("appended entries are returned chronological (oldest first)", async () => {
    await appendEntry(env, IMEI, entry({ id: "k1", ts: 1, note: "first" }));
    await appendEntry(env, IMEI, entry({ id: "k2", ts: 2, note: "second" }));
    await appendEntry(env, IMEI, entry({ id: "k3", ts: 3, note: "third" }));
    const entries = await getEntries(env, IMEI);
    expect(entries.map((e) => e.note)).toEqual(["first", "second", "third"]);
  });

  test("lat/lon are optional — entries without GPS round-trip cleanly", async () => {
    await appendEntry(env, IMEI, entry({ id: "k1", ts: 10 }));
    await appendEntry(env, IMEI, entry({ id: "k2", ts: 20, lat: 37.1682, lon: -118.5891 }));
    const entries = await getEntries(env, IMEI);
    expect(entries[0].lat).toBeUndefined();
    expect(entries[0].lon).toBeUndefined();
    expect(entries[1].lat).toBeCloseTo(37.1682, 4);
    expect(entries[1].lon).toBeCloseTo(-118.5891, 4);
  });

  test("source field is preserved (drop vs post)", async () => {
    await appendEntry(env, IMEI, entry({ id: "k1", ts: 1, source: "drop" }));
    await appendEntry(env, IMEI, entry({ id: "k2", ts: 2, source: "post" }));
    const entries = await getEntries(env, IMEI);
    expect(entries.map((e) => e.source)).toEqual(["drop", "post"]);
  });

  test("per-IMEI isolation", async () => {
    const other = "999999999999999";
    await appendEntry(env, IMEI, entry({ id: "a", note: "alice" }));
    await appendEntry(env, other, entry({ id: "b", note: "bob" }));
    expect((await getEntries(env, IMEI)).map((e) => e.note)).toEqual(["alice"]);
    expect((await getEntries(env, other)).map((e) => e.note)).toEqual(["bob"]);
  });
});

describe("FIFO eviction at MAX_ENTRIES (100)", () => {
  test("after 101 appends, the oldest is dropped and 100 remain", async () => {
    for (let i = 1; i <= 101; i += 1) {
      await appendEntry(env, IMEI, entry({ id: `k${i}`, ts: i, note: `entry-${i}` }));
    }
    const entries = await getEntries(env, IMEI);
    expect(entries).toHaveLength(100);
    // Oldest survivor is entry-2; entry-1 was evicted.
    expect(entries[0].note).toBe("entry-2");
    expect(entries[entries.length - 1].note).toBe("entry-101");
  });
});

describe("idempotency — duplicate id is a no-op", () => {
  test("re-appending the same id does not add a second entry", async () => {
    await appendEntry(env, IMEI, entry({ id: "same-key", ts: 1, note: "first" }));
    await appendEntry(env, IMEI, entry({ id: "same-key", ts: 1, note: "first" }));
    await appendEntry(env, IMEI, entry({ id: "same-key", ts: 1, note: "first" }));
    expect(await getEntries(env, IMEI)).toHaveLength(1);
  });

  test("a different id with the same content is a separate entry", async () => {
    await appendEntry(env, IMEI, entry({ id: "k1", ts: 1, note: "saw a marmot" }));
    await appendEntry(env, IMEI, entry({ id: "k2", ts: 2, note: "saw a marmot" }));
    expect(await getEntries(env, IMEI)).toHaveLength(2);
  });
});

describe("getEntries options — since + limit for !brief", () => {
  beforeEach(async () => {
    for (let i = 1; i <= 10; i += 1) {
      await appendEntry(env, IMEI, entry({ id: `k${i}`, ts: i * 1000, note: `e${i}` }));
    }
  });

  test("`since` filters to entries at-or-after the bound", async () => {
    const out = await getEntries(env, IMEI, { since: 6000 });
    expect(out.map((e) => e.note)).toEqual(["e6", "e7", "e8", "e9", "e10"]);
  });

  test("`limit` caps to the most-recent N (oldest-first)", async () => {
    const out = await getEntries(env, IMEI, { limit: 3 });
    expect(out.map((e) => e.note)).toEqual(["e8", "e9", "e10"]);
  });

  test("`since` + `limit` compose (filter, then cap)", async () => {
    const out = await getEntries(env, IMEI, { since: 4000, limit: 2 });
    expect(out.map((e) => e.note)).toEqual(["e9", "e10"]);
  });
});

describe("KV semantics", () => {
  test("each append writes fieldlog:<imei> with TTL 30 days, refreshed on every call", async () => {
    const putSpy = vi.spyOn(env.TS_CONTEXT, "put");
    await appendEntry(env, IMEI, entry({ id: "k1", ts: 1 }));
    await appendEntry(env, IMEI, entry({ id: "k2", ts: 2 }));
    expect(putSpy).toHaveBeenCalledTimes(2);
    for (const call of putSpy.mock.calls) {
      expect(String(call[0])).toBe(`fieldlog:${IMEI}`);
      const opts = call[2] as { expirationTtl?: number } | undefined;
      expect(opts?.expirationTtl).toBe(60 * 60 * 24 * 30);
    }
  });

  test("idempotent replay does not write to KV", async () => {
    await appendEntry(env, IMEI, entry({ id: "same", ts: 1 }));
    const putSpy = vi.spyOn(env.TS_CONTEXT, "put");
    await appendEntry(env, IMEI, entry({ id: "same", ts: 1 }));
    expect(putSpy).not.toHaveBeenCalled();
  });
});
