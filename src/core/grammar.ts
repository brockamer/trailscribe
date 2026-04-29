import type { ParsedCommand } from "./types.js";

/**
 * Parse an SMS-style `!command` into a structured ParsedCommand.
 * Returns undefined for unknown commands or malformed arguments.
 *
 * α-MVP commands (Phase 1, see PRD §2):
 *   !ping                                      health check
 *   !help                                      command summary
 *   !cost                                      month-to-date usage
 *   !post <note>                               journal entry (LLM narrative)
 *   !mail (to|t):<addr> [(subj|s):<subj>] [(body|b):<body>]   enriched email
 *   !todo <task>                               Todoist task
 *
 * Phase 2 commands (plans/phase-2-extended-commands.md P2-02 + P2-18):
 *   !where                                     reverse-geocode current fix
 *   !weather                                   current-location forecast
 *   !drop <note>                               FieldLog journal entry
 *   !brief [Nd]                                LLM summary; default 24h window
 *   !ai <question>                             open-ended LLM Q&A
 *   !camp <query>                              outdoors-knowledge LLM
 *   !share to:<addr|alias> <note>              single-recipient enriched email
 *   !blast <note>                              broadcast to address-book "all"
 *   !postimg <caption>                         image-augmented journal post
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
      return rest ? { type: "post", note: rest } : { type: "post" };
    }
    case "todo": {
      if (!rest) return undefined;
      return { type: "todo", task: rest };
    }
    case "mail": {
      // Format: !mail (to|t):<addr> [(subj|s):<subj>] [(body|b):<body>]
      // - `to:` / `t:` are interchangeable; same for `subj:` / `s:` and `body:` / `b:`.
      // - Keys may be mixed within one message (e.g. `t:x@y.com subj:hi b:msg`).
      // - Order is fixed (to → subj → body); subj and body are independently optional.
      // - Default subject is supplied downstream by handleMail (see commands/mail.ts).
      const match = rest.match(
        /^(?:to|t):(\S+)(?:\s+(?:subj|s):(.+?))?(?:\s+(?:body|b):(.+))?$/i,
      );
      if (!match) return undefined;
      const [, to, subj, body] = match;
      return {
        type: "mail",
        to,
        ...(subj !== undefined ? { subj: subj.trim() } : {}),
        ...(body !== undefined ? { body: body.trim() } : {}),
      };
    }
    case "where":
      return { type: "where" };
    case "weather":
      return { type: "weather" };
    case "drop": {
      if (!rest) return undefined;
      return { type: "drop", note: rest };
    }
    case "brief": {
      if (!rest) return { type: "brief" };
      const m = rest.match(/^(\d+)d$/i);
      if (!m) return undefined;
      return { type: "brief", windowDays: Number.parseInt(m[1], 10) };
    }
    case "ai": {
      if (!rest) return undefined;
      return { type: "ai", question: rest };
    }
    case "camp": {
      if (!rest) return undefined;
      return { type: "camp", query: rest };
    }
    case "share": {
      // Format: !share to:<addr|alias> <note>
      const m = rest.match(/^to:(\S+)\s+(.+)$/i);
      if (!m) return undefined;
      const [, to, note] = m;
      return { type: "share", to, note: note.trim() };
    }
    case "blast": {
      if (!rest) return undefined;
      return { type: "blast", note: rest };
    }
    case "postimg": {
      if (!rest) return undefined;
      return { type: "postimg", caption: rest };
    }
    default:
      return undefined;
  }
}
