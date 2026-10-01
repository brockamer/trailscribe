import type { Env } from "../env.js";
import { dailyTokenBudget } from "../env.js";
import { dailyTotals } from "./ledger.js";

/**
 * Estimated prompt+completion tokens consumed by a typical `!post` narrative.
 * Used by the budget gate to reserve capacity before calling the LLM.
 *
 * Every `ESTIMATED_*_TOKENS` is the typical measured total for its command,
 * prompt plus completion, the model's hidden reasoning tokens included — not
 * the worst case, which would refuse a call that usually fits. A post measured
 * about 1,100 on Opus 5.5 (#263); 400 dated from the Sonnet 4.6 era (#265).
 *
 * Static for α — Phase 3 will measure historical p95 and adapt.
 */
export const ESTIMATED_POST_TOKENS = 1100;

/**
 * Canned reply when the daily budget is exhausted. Kept ≤ 80 chars so it
 * fits in a single Iridium SMS frame with room for the cost suffix.
 */
export const BUDGET_REJECTION_MESSAGE =
  "Daily AI budget reached. Retry tomorrow or raise DAILY_TOKEN_BUDGET.";

export interface BudgetCheckResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Check whether a transaction estimated to consume `estimated` tokens fits
 * within today's remaining budget.
 *
 * `DAILY_TOKEN_BUDGET=0` disables the gate (returns `allowed=true,
 * remaining=Infinity`). For any other value, "remaining" is
 * `budget - (today.prompt_tokens + today.completion_tokens)` and the
 * transaction is allowed iff `remaining >= estimated`.
 *
 * Reads today's totals from the daily ledger (P1-11). KV reads are cheap
 * but not free; callers should call this once per command, not per LLM call.
 */
export async function checkBudget(env: Env, estimated: number): Promise<BudgetCheckResult> {
  const budget = dailyTokenBudget(env);
  if (budget === 0) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY };
  }
  const today = await dailyTotals(env);
  const used = today.prompt_tokens + today.completion_tokens;
  const remaining = budget - used;
  return { allowed: remaining >= estimated, remaining };
}
