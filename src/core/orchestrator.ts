import type { ParsedCommand, CommandResult } from "./types.js";
import type { Env } from "../env.js";

export interface OrchestratorContext {
  env: Env;
  imei: string;
  lat?: number;
  lon?: number;
}

/**
 * Dispatch a parsed command to its handler.
 *
 * Phase 0: not wired to the Worker fetch path. `ping` / `help` / `cost` return
 * real replies; `post` / `mail` / `todo` return a canned "not implemented in α"
 * string until Phase 1 fills in the adapters.
 *
 * Phase 1 adds: budget gate (reject expensive commands over DAILY_TOKEN_BUDGET),
 * idempotency op-level checkpoints (skip already-completed sub-ops on replay),
 * context rolling window writes.
 */
export async function orchestrate(
  command: ParsedCommand,
  _ctx: OrchestratorContext,
): Promise<CommandResult> {
  switch (command.type) {
    case "ping":
      return { body: "pong" };
    case "help":
      return { body: helpText() };
    case "cost":
      return { body: "0 req · 0 tok · $0.00 (Phase 1 wires real ledger)" };
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
