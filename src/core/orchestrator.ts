import type { ParsedCommand, CommandResult } from "./types.js";
import type { Env } from "../env.js";
import { monthlyTotals, recordTransaction, type LedgerSnapshot } from "./ledger.js";
import { handlePost } from "./commands/post.js";
import { handleMail } from "./commands/mail.js";
import { handleTodo } from "./commands/todo.js";
import { handleWhere } from "./commands/where.js";
import { handleWeather } from "./commands/weather.js";
import { handleDrop } from "./commands/drop.js";
import { handleBrief } from "./commands/brief.js";
import { handleAi } from "./commands/ai.js";

export interface OrchestratorContext {
  env: Env;
  imei: string;
  lat?: number;
  lon?: number;
  /**
   * Idempotency key for the inbound webhook delivery. Threaded into command
   * handlers so per-op `withCheckpoint` calls (P1-13) can short-circuit on
   * replay. Required from Phase 1 onward.
   */
  idemKey: string;
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
      return { body: "pong" };
    case "help":
      return { body: helpText() };
    case "cost": {
      const snap = await monthlyTotals(ctx.env);
      return { body: formatCostBody(snap) };
    }
    case "post":
      return handlePost(command, ctx);
    case "mail":
      return handleMail(command, ctx);
    case "todo":
      return handleTodo(command, ctx);
    case "where":
      return handleWhere(command, ctx);
    case "weather":
      return handleWeather(command, ctx);
    case "drop":
      return handleDrop(command, ctx);
    case "brief":
      return handleBrief(command, ctx);
    case "ai":
      return handleAi(command, ctx);
    case "camp":
    case "share":
    case "blast":
    case "postimg":
      // Phase 2 commands parse cleanly (P2-02) but the per-command handlers
      // land in P2-03..P2-11 + P2-18. Until then a real send surfaces a clear
      // device-visible error via app.ts's orchestrate-error reply path.
      throw new Error(`!${command.type} not yet implemented`);
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
