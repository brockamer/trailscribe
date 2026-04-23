import type { ParsedCommand } from "./types.js";

/**
 * Parse an SMS-style `!command` into a structured ParsedCommand.
 * Returns undefined for unknown commands or malformed arguments.
 *
 * α-MVP command set (see PRD §2):
 *   !ping                                      health check
 *   !help                                      command summary
 *   !cost                                      month-to-date usage
 *   !post <note>                               journal entry (narrative via OpenAI)
 *   !mail to:<addr> subj:<subj> body:<body>    enriched email
 *   !todo <task>                               Todoist task
 *
 * Deferred verbs (!where, !drop, !brief, !ai, !camp, !blast, !share, !weather)
 * return undefined — they'll be added in Phase 2+.
 */
export function parseCommand(message: string): ParsedCommand | undefined {
  const trimmed = message.trim();
  if (!trimmed.startsWith("!")) return undefined;

  const parts = trimmed.split(/\s+/, 2);
  const verb = parts[0].substring(1).toLowerCase();
  const rest = trimmed.slice(parts[0].length).trim();

  switch (verb) {
    case "ping":
      return { type: "ping" };
    case "help":
      return { type: "help" };
    case "cost":
      return { type: "cost" };
    case "post": {
      if (!rest) return undefined;
      return { type: "post", note: rest };
    }
    case "todo": {
      if (!rest) return undefined;
      return { type: "todo", task: rest };
    }
    case "mail": {
      // Format: !mail to:<addr> subj:<subj with spaces OK> body:<body>
      // The subj field must allow spaces — fixed from previous `[^\s]+` bug.
      const match = rest.match(/^to:(\S+)\s+subj:(.+?)\s+body:(.+)$/i);
      if (!match) return undefined;
      const [, to, subj, body] = match;
      return { type: "mail", to, subj: subj.trim(), body: body.trim() };
    }
    default:
      return undefined;
  }
}
