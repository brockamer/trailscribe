import { ParsedCommand } from './grammar';
import { addTask } from '../tools/todoist';
import { sendEmail } from '../tools/emailGmail';
import { createPost } from '../tools/posthaven';
import { searchWeb } from '../tools/webSearch';
import { Config } from '../config/env';
import { getNearestPlaceAndWeather } from '../runtime/context';
import { Ledger } from '../runtime/ledger';

/**
 * Process a parsed command and produce a reply. This function
 * orchestrates the correct tool invocation and updates the cost ledger.
 */
export async function orchestrate(command: ParsedCommand, opts: {
  lat?: number;
  lon?: number;
  config: Config;
  ledger: Ledger;
}): Promise<{ body: string; lat?: number; lon?: number }> {
  const { lat, lon, config, ledger } = opts;
  let reply = '';

  switch (command.type) {
    case 'ping':
      reply = 'pong';
      break;
    case 'where': {
      // Use stubbed context to get nearest place and weather summary
      const info = await getNearestPlaceAndWeather({ lat, lon });
      reply = info;
      break;
    }
    case 'ai': {
      // In a production deployment this would call the OpenAI API.
      // Here we simulate the answer.
      reply = `Answer: ${command.query}`;
      break;
    }
    case 'todo': {
      await addTask({ task: command.task, config });
      reply = `Added to Todoist: ${command.task}`;
      break;
    }
    case 'mail': {
      await sendEmail({
        to: command.to,
        subject: command.subj,
        body: command.body,
        config,
      });
      reply = `Email sent to ${command.to}`;
      break;
    }
    case 'drop': {
      // Append note with coordinates/time; in a real implementation this
      // would write to a spreadsheet or JSON log.
      const timestamp = new Date().toISOString();
      // For demonstration we just output a confirmation.
      reply = `Field log entry recorded at ${timestamp}`;
      break;
    }
    case 'camp': {
      const result = await searchWeb({ query: command.query, config });
      reply = `Camp intel: ${result}`;
      break;
    }
    case 'post': {
      await createPost({ title: command.title, body: command.body, config });
      reply = `Posted: ${command.title}`;
      break;
    }
    case 'blast': {
      // In a real implementation this would loop through a configured
      // group of contacts and send each an email. Here we simulate.
      reply = `Broadcast sent to group.`;
      break;
    }
    case 'share': {
      await sendEmail({
        to: command.to,
        subject: 'TrailScribe Share',
        body: command.note,
        config,
      });
      reply = `Shared with ${command.to}`;
      break;
    }
    case 'brief': {
      // Summarise last 24h entries; stub
      reply = 'Daily brief: no activity logged yet.';
      break;
    }
    case 'cost': {
      reply = ledger.getSummary();
      break;
    }
    case 'help': {
      reply = [
        '!ping – health/status',
        '!where – nearest place + weather',
        '!ai <q> – ask AI a question',
        '!todo <task> – add task',
        '!mail to:<addr> subj:<s> body:<b> – send email',
        '!drop <note> – log a note',
        '!camp <q> – trail/camp intel',
        '!post "Title" body:<text> – create blog post',
        '!blast <note> – broadcast to group',
        '!share to:<email> <note> – share one‑off',
        '!brief – daily summary',
        '!cost – usage summary',
      ].join('\n');
      break;
    }
  }

  // Compute cost and update ledger. We count input and output characters as
  // a proxy for tokens. Real implementation would use actual token
  // counts from the OpenAI API.
  const inputTokens = JSON.stringify(command).length;
  const outputTokens = reply.length;
  ledger.record({ inputTokens, outputTokens });

  // Append cost suffix if enabled.
  let suffix = '';
  if (config.APPEND_COST_SUFFIX) {
    suffix = ` · $${ledger.getCycleCost().toFixed(2)}`;
  }

  // Compose final reply trimmed to two SMS messages (~320 chars)
  const maxLen = 320;
  const bodyWithSuffix = reply + suffix;
  const finalBody = bodyWithSuffix.length > maxLen ? bodyWithSuffix.slice(0, maxLen - 3) + '...' : bodyWithSuffix;

  return { body: finalBody, lat, lon };
}