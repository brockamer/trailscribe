/**
 * Command grammar parser.
 *
 * This module defines a simple parser for short SMS‑style commands.
 * Each command begins with an exclamation mark (`!`) followed by
 * a verb and optional arguments. The parser returns a discriminated
 * union describing the parsed command or `undefined` when the input
 * does not match any known command.
 */

export type ParsedCommand =
  | { type: 'ping' }
  | { type: 'where' }
  | { type: 'ai'; query: string }
  | { type: 'todo'; task: string }
  | { type: 'mail'; to: string; subj: string; body: string }
  | { type: 'drop'; note: string }
  | { type: 'camp'; query: string }
  | { type: 'post'; title: string; body: string }
  | { type: 'blast'; note: string }
  | { type: 'share'; to: string; note: string }
  | { type: 'brief' }
  | { type: 'cost' }
  | { type: 'help' };

/**
 * Parse a message string into a structured command. Returns undefined
 * when the message is not recognised as a command.
 */
export function parseCommand(message: string): ParsedCommand | undefined {
  const trimmed = message.trim();
  if (!trimmed.startsWith('!')) return undefined;

  // Extract the command verb and remainder.
  const parts = trimmed.split(/\s+/, 2);
  const verb = parts[0].substring(1).toLowerCase();
  const rest = parts[1] ?? '';

  switch (verb) {
    case 'ping':
      return { type: 'ping' };
    case 'where':
      return { type: 'where' };
    case 'brief':
      return { type: 'brief' };
    case 'cost':
      return { type: 'cost' };
    case 'help':
      return { type: 'help' };
    case 'ai': {
      const query = rest.trim();
      if (!query) return undefined;
      return { type: 'ai', query };
    }
    case 'todo': {
      const task = rest.trim();
      if (!task) return undefined;
      return { type: 'todo', task };
    }
    case 'drop': {
      const note = rest.trim();
      if (!note) return undefined;
      return { type: 'drop', note };
    }
    case 'camp': {
      const query = rest.trim();
      if (!query) return undefined;
      return { type: 'camp', query };
    }
    case 'blast': {
      const note = rest.trim();
      if (!note) return undefined;
      return { type: 'blast', note };
    }
    case 'todoist': {
      // support alias for !todo
      const task = rest.trim();
      if (!task) return undefined;
      return { type: 'todo', task };
    }
    case 'share': {
      // Format: !share to:<email> <note>
      const toMatch = rest.match(/to:([^\s]+)\s+(.*)/i);
      if (!toMatch) return undefined;
      const [, to, note] = toMatch;
      return { type: 'share', to, note: note.trim() };
    }
    case 'mail': {
      // Format: !mail to:<addr> subj:<s> body:<b>
      const toMatch = rest.match(/to:([^\s]+)\s+subj:([^\s]+)\s+body:(.+)/i);
      if (!toMatch) return undefined;
      const [, to, subj, body] = toMatch;
      return { type: 'mail', to, subj, body: body.trim() };
    }
    case 'post': {
      // Format: !post "Title" body:<text>
      const postMatch = rest.match(/\"([^\"]+)\"\s+body:(.+)/i);
      if (!postMatch) return undefined;
      const [, title, body] = postMatch;
      return { type: 'post', title, body: body.trim() };
    }
    default:
      return undefined;
  }
}