import { describe, test, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import {
  recordTransaction,
  recordImageTransaction,
  monthlyTotals,
  dailyTotals,
  type LedgerSnapshot,
} from "../src/core/ledger.js";
import { putJSON } from "../src/adapters/storage/kv.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;
let logSpy: MockInstance<(...args: unknown[]) => void>;
let errSpy: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  env = makeTestEnv({
    LLM_INPUT_COST_PER_1K: "0.30",
    LLM_OUTPUT_COST_PER_1K: "1.20",
  });
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

function loggedEvents(): Array<Record<string, unknown>> {
  const lines: string[] = [];
  for (const c of logSpy.mock.calls) lines.push(String(c[0]));
  for (const c of errSpy.mock.calls) lines.push(String(c[0]));
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("recordTransaction — cost computation", () => {
  test("AI command: usd_cost = input/1k * prompt + output/1k * completion", async () => {
    const result = await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 200, completion_tokens: 100 },
      env,
    });
    // 0.30 * 200/1000 + 1.20 * 100/1000 = 0.06 + 0.12 = 0.18
    expect(result.usd_cost).toBeCloseTo(0.18, 4);
  });

  test("non-AI command: zero usage → zero cost", async () => {
    const result = await recordTransaction({
      command: "ping",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env,
    });
    expect(result.usd_cost).toBe(0);
  });
});

describe("recordTransaction — KV layout + rollup math", () => {
  test("appending one transaction to a fresh month writes both monthly and daily snapshots", async () => {
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      env,
    });

    const monthly = await monthlyTotals(env);
    const daily = await dailyTotals(env);

    expect(monthly).toMatchObject({
      requests: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
    });
    expect(monthly.usd_cost).toBeCloseTo(0.3 * 0.1 + 1.2 * 0.05, 4);
    expect(monthly.by_command.post).toMatchObject({ requests: 1 });
    expect(monthly.period).toMatch(/^\d{4}-\d{2}$/);

    expect(daily).toMatchObject({
      requests: 1,
      prompt_tokens: 100,
      completion_tokens: 50,
    });
    expect(daily.period).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(daily.usd_cost).toBeCloseTo(monthly.usd_cost, 4);
  });

  test("two transactions in series accumulate (requests, tokens, usd, by_command)", async () => {
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      env,
    });
    await recordTransaction({
      command: "ping",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env,
    });
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 200, completion_tokens: 80 },
      env,
    });

    const monthly = await monthlyTotals(env);
    expect(monthly.requests).toBe(3);
    expect(monthly.prompt_tokens).toBe(300);
    expect(monthly.completion_tokens).toBe(130);
    // 0.30 * 0.3 + 1.20 * 0.13 = 0.09 + 0.156 = 0.246
    expect(monthly.usd_cost).toBeCloseTo(0.246, 4);
    expect(monthly.by_command.post).toMatchObject({ requests: 2 });
    expect(monthly.by_command.ping).toMatchObject({ requests: 1 });
    // Non-AI commands record zero cost
    expect(monthly.by_command.ping.usd_cost).toBe(0);
  });

  test("per-day totals match per-month totals for transactions in the same day", async () => {
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 50, completion_tokens: 25 },
      env,
    });
    await recordTransaction({
      command: "mail",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env,
    });

    const monthly = await monthlyTotals(env);
    const daily = await dailyTotals(env);

    expect(daily.requests).toBe(monthly.requests);
    expect(daily.prompt_tokens).toBe(monthly.prompt_tokens);
    expect(daily.completion_tokens).toBe(monthly.completion_tokens);
    expect(daily.usd_cost).toBeCloseTo(monthly.usd_cost, 4);
  });
});

describe("recordTransaction — KV semantics", () => {
  test("daily snapshot is written with an 8-day TTL; monthly has no TTL", async () => {
    const dailyPutSpy = vi.spyOn(env.TS_LEDGER, "put");
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      env,
    });

    const dayKeyCall = dailyPutSpy.mock.calls.find((c) => /^ledger:\d{4}-\d{2}-\d{2}$/.test(String(c[0])));
    const monthKeyCall = dailyPutSpy.mock.calls.find((c) => /^ledger:\d{4}-\d{2}$/.test(String(c[0])));

    expect(dayKeyCall).toBeDefined();
    expect(monthKeyCall).toBeDefined();

    const dayOpts = dayKeyCall![2] as { expirationTtl?: number } | undefined;
    const monthOpts = monthKeyCall![2] as { expirationTtl?: number } | undefined;
    expect(dayOpts?.expirationTtl).toBe(60 * 60 * 24 * 8);
    expect(monthOpts?.expirationTtl).toBeUndefined();
  });

  test("monthlyTotals on a cold (never-written) period returns a zero snapshot, not null", async () => {
    const totals = await monthlyTotals(env, "1999-01");
    expect(totals).toMatchObject<Partial<LedgerSnapshot>>({
      period: "1999-01",
      requests: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      usd_cost: 0,
    });
    expect(totals.by_command).toEqual({});
  });

  test("dailyTotals on a cold period returns a zero snapshot", async () => {
    const totals = await dailyTotals(env, "1999-01-01");
    expect(totals.requests).toBe(0);
    expect(totals.usd_cost).toBe(0);
  });

  test("monthly snapshot returns image fields as 0 when never written (backwards compat)", async () => {
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      env,
    });
    const monthly = await monthlyTotals(env);
    expect(monthly.image_requests).toBeUndefined();
    expect(monthly.image_usd_cost).toBeUndefined();
    // Reader pattern (used by !cost): coalesce undefined → 0
    expect(monthly.image_requests ?? 0).toBe(0);
    expect(monthly.image_usd_cost ?? 0).toBe(0);
  });

  test("daily-write failure does not throw; monthly write still succeeds", async () => {
    let dailyAttempts = 0;
    const realPut = env.TS_LEDGER.put.bind(env.TS_LEDGER);
    env.TS_LEDGER.put = (async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      if (/^ledger:\d{4}-\d{2}-\d{2}$/.test(key)) {
        dailyAttempts += 1;
        throw new Error("simulated daily KV failure");
      }
      return realPut(key, value, opts);
    }) as typeof env.TS_LEDGER.put;

    const result = await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      env,
    });

    expect(result.usd_cost).toBeGreaterThan(0);
    expect(dailyAttempts).toBeGreaterThanOrEqual(1);

    const monthly = await monthlyTotals(env);
    expect(monthly.requests).toBe(1);

    const events = loggedEvents().map((e) => e.event);
    expect(events).toContain("ledger_daily_write_failed");
  });
});

describe("recordImageTransaction — image-gen aggregates (P2-17)", () => {
  test("first image write seeds image_requests=1 and image_usd_cost=cost", async () => {
    await recordImageTransaction({ command: "postimg", usdCost: 0.003, env });
    const monthly = await monthlyTotals(env);
    expect(monthly.image_requests).toBe(1);
    expect(monthly.image_usd_cost).toBeCloseTo(0.003, 6);
  });

  test("two image writes accumulate", async () => {
    await recordImageTransaction({ command: "postimg", usdCost: 0.003, env });
    await recordImageTransaction({ command: "postimg", usdCost: 0.005, env });
    const monthly = await monthlyTotals(env);
    expect(monthly.image_requests).toBe(2);
    expect(monthly.image_usd_cost).toBeCloseTo(0.008, 6);
  });

  test("image writes do NOT touch text fields (requests, usd_cost, by_command)", async () => {
    await recordImageTransaction({ command: "postimg", usdCost: 0.003, env });
    const monthly = await monthlyTotals(env);
    expect(monthly.requests).toBe(0);
    expect(monthly.usd_cost).toBe(0);
    expect(monthly.prompt_tokens).toBe(0);
    expect(monthly.completion_tokens).toBe(0);
    expect(monthly.by_command).toEqual({});
  });

  test("text writes preserve existing image aggregates (mergeEntry carry-over)", async () => {
    await recordImageTransaction({ command: "postimg", usdCost: 0.003, env });
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 100, completion_tokens: 50 },
      env,
    });
    const monthly = await monthlyTotals(env);
    expect(monthly.image_requests).toBe(1);
    expect(monthly.image_usd_cost).toBeCloseTo(0.003, 6);
    expect(monthly.requests).toBe(1);
    expect(monthly.by_command.post.requests).toBe(1);
  });

  test("daily snapshot also receives the image write", async () => {
    await recordImageTransaction({ command: "postimg", usdCost: 0.003, env });
    const daily = await dailyTotals(env);
    expect(daily.image_requests).toBe(1);
    expect(daily.image_usd_cost).toBeCloseTo(0.003, 6);
  });

  test("a pre-P2-17 snapshot (no image fields) gets image fields on first image write", async () => {
    // Simulate an existing snapshot written by Phase 1 ledger code, which
    // never set image_requests / image_usd_cost.
    const yyyymm = new Date().toISOString().slice(0, 7);
    const legacy: LedgerSnapshot = {
      period: yyyymm,
      requests: 5,
      prompt_tokens: 200,
      completion_tokens: 100,
      usd_cost: 0.42,
      by_command: { post: { requests: 5, usd_cost: 0.42 } },
      last_update_ms: Date.now() - 1000,
    };
    await putJSON(env.TS_LEDGER, `ledger:${yyyymm}`, legacy);

    await recordImageTransaction({ command: "postimg", usdCost: 0.003, env });

    const monthly = await monthlyTotals(env);
    // Image aggregates seeded
    expect(monthly.image_requests).toBe(1);
    expect(monthly.image_usd_cost).toBeCloseTo(0.003, 6);
    // Legacy text aggregates untouched
    expect(monthly.requests).toBe(5);
    expect(monthly.usd_cost).toBeCloseTo(0.42, 4);
    expect(monthly.by_command.post.requests).toBe(5);
  });
});
