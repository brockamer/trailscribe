import { describe, test, expect, beforeEach } from "vitest";
import { checkBudget, BUDGET_REJECTION_MESSAGE, ESTIMATED_POST_TOKENS } from "../src/core/budget.js";
import { recordTransaction } from "../src/core/ledger.js";
import { makeTestEnv } from "./helpers/env.js";
import type { Env } from "../src/env.js";

let env: Env;

beforeEach(() => {
  env = makeTestEnv({ DAILY_TOKEN_BUDGET: "1000" });
});

describe("checkBudget — gating logic", () => {
  test("cold day: budget allows, remaining = full budget", async () => {
    const r = await checkBudget(env, ESTIMATED_POST_TOKENS);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1000);
  });

  test("two 300-token transactions still under 1000-token budget; third (estimated 400) rejected", async () => {
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 200, completion_tokens: 100 },
      env,
    });
    let r = await checkBudget(env, ESTIMATED_POST_TOKENS);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1000 - 300);

    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 200, completion_tokens: 100 },
      env,
    });
    r = await checkBudget(env, ESTIMATED_POST_TOKENS);
    // 600 used + 400 estimated = 1000 — at the limit, still allowed
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1000 - 600);

    // Third transaction would push us to 900 used + 400 estimated = 1300 — rejected
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 200, completion_tokens: 100 },
      env,
    });
    r = await checkBudget(env, ESTIMATED_POST_TOKENS);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(1000 - 900);
  });

  test("DAILY_TOKEN_BUDGET=0 disables the gate (always allowed, remaining=Infinity)", async () => {
    env = makeTestEnv({ DAILY_TOKEN_BUDGET: "0" });
    await recordTransaction({
      command: "post",
      usage: { prompt_tokens: 99999, completion_tokens: 99999 },
      env,
    });
    const r = await checkBudget(env, ESTIMATED_POST_TOKENS);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(Number.POSITIVE_INFINITY);
  });

  test("non-AI commands count toward usage too — every recorded transaction's prompt+completion deducts", async () => {
    // Even though !ping has zero usage, the request itself doesn't deduct;
    // usage is what counts.
    await recordTransaction({
      command: "ping",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env,
    });
    const r = await checkBudget(env, ESTIMATED_POST_TOKENS);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1000);
  });

  test("rejection message is short and actionable (≤ 80 chars, fits in a single SMS)", () => {
    expect(BUDGET_REJECTION_MESSAGE.length).toBeLessThanOrEqual(80);
    expect(BUDGET_REJECTION_MESSAGE).toMatch(/budget|cap|limit/i);
  });

  test("ESTIMATED_POST_TOKENS is the documented constant 400", () => {
    expect(ESTIMATED_POST_TOKENS).toBe(400);
  });
});
