import { describe, test, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import {
  recordTransaction,
  monthlyTotals,
  dailyTotals,
  type LedgerSnapshot,
} from "../src/core/ledger.js";
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
