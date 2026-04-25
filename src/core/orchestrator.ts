import type { ParsedCommand, CommandResult } from "./types.js";
import type { Env } from "../env.js";
import { monthlyTotals, recordTransaction, type LedgerSnapshot } from "./ledger.js";

export interface OrchestratorContext {
  env: Env;
  imei: string;
  lat?: number;
  lon?: number;
}

/**
 * Dispatch a parsed command to its handler.
 *
 * Phase 1 (P1-19): `!ping`/`!help`/`!cost` return real bodies; `!ping` records
 * a 0-cost transaction in the ledger so it counts toward `!cost` totals;
 * `!cost` reads `monthlyTotals(env)` and formats it. The post/mail/todo handlers
 * remain canned until P1-16/17/18 wire their adapter pipelines.
 */
export async function orchestrate(
  command: ParsedCommand,
  ctx: OrchestratorContext,
): Promise<CommandResult> {
  switch (command.type) {
    case "ping":
      await recordTransaction({
        command: "ping",
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        env: ctx.env,
      });
      // Propagate GPS into the reply so the device confirms its fix on
      // first commission test. Map links land on whichever page has room.
      return { body: "pong", lat: ctx.lat, lon: ctx.lon };
    case "help":
      return { body: helpText() };
    case "cost": {
      const snap = await monthlyTotals(ctx.env);
      return { body: formatCostBody(snap) };
    }
    case "post":
      return { body: "α: !post not yet implemented (Phase 1)" };
    case "mail":
      return { body: "α: !mail not yet implemented (Phase 1)" };
    case "todo":
      return { body: "α: !todo not yet implemented (Phase 1)" };
  }
}

/**
 * Help reply content. Kept ≤320 chars to respect the two-SMS reply budget.
 */
function helpText(): string {
  return [
    "!ping — status",
    "!post <note> — blog",
    "!mail to:_ subj:_ body:_",
    "!todo <task>",
    "!cost — usage",
    "!help",
  ].join("\n");
}

/**
 * Format the `!cost` reply body. Per plan P1-19:
 *   "<requests> req · <tokens>k tok · $<cost> (since <YYYY-MM-01>)"
 * Tokens are summed (prompt + completion) and rendered in thousands with one
 * decimal. Total width capped at ~52 chars in realistic ranges.
 */
function formatCostBody(snap: LedgerSnapshot): string {
  const totalTokens = snap.prompt_tokens + snap.completion_tokens;
  const tokensK = (totalTokens / 1000).toFixed(1);
  const cost = snap.usd_cost.toFixed(2);
  const sinceDate = `${snap.period}-01`;
  return `${snap.requests} req · ${tokensK}k tok · $${cost} (since ${sinceDate})`;
}
