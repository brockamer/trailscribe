import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { chatCompletion, LLMError } from "../../adapters/ai/openrouter.js";
import { sendEmail, ResendError } from "../../adapters/mail/resend.js";
import { recordTransaction, monthlyTotals } from "../ledger.js";
import { getEntries, type FieldLogEntry } from "../fieldlog.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { BUDGET_REJECTION_MESSAGE, checkBudget } from "../budget.js";
import { log } from "../../adapters/logging/worker-logs.js";

type BriefCommand = Extract<ParsedCommand, { type: "brief" }>;

const REPLY_MAX = 320;
const ESTIMATED_BRIEF_TOKENS = 800;
const DEFAULT_WINDOW_DAYS = 1;
const OVERFLOW_REPLY = "Brief sent by email.";
const NO_ENTRIES_REPLY = "No entries to brief on.";

const SYSTEM_PROMPT =
  "You are TrailScribe's field briefing writer. Summarize the operator's " +
  "recent FieldLog entries plus month-to-date activity into a tight 5-line " +
  "summary. No preamble, no headers — just the lines, separated by " +
  "newlines. Aim for 280 characters total. Use plain text only.";

/**
 * `!brief [Nd]` pipeline (plan P2-06). Aggregates FieldLog + ledger and asks
 * the LLM for a five-line summary. Default window is 24 hours; an optional
 * `windowDays` argument from the grammar overrides it.
 *
 * If the FieldLog is empty for the window, short-circuits with a canned
 * "no entries" reply (no LLM cost). If the LLM produces a reply that
 * exceeds 320 chars after page formatting, the device gets a pointer and
 * the full brief routes to operator email — same overflow pattern as
 * !ai / !camp / !post.
 */
export async function handleBrief(
  cmd: BriefCommand,
  ctx: OrchestratorContext,
): Promise<CommandResult> {
  const { env, imei, idemKey } = ctx;
  const windowDays = cmd.windowDays ?? DEFAULT_WINDOW_DAYS;
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const entries = await getEntries(env, imei, { since });
  if (entries.length === 0) {
    return { body: NO_ENTRIES_REPLY };
  }

  const budget = await checkBudget(env, ESTIMATED_BRIEF_TOKENS);
  if (!budget.allowed) {
    log({ event: "brief_budget_rejected", level: "warn", imei, remaining: budget.remaining });
    return { body: BUDGET_REJECTION_MESSAGE };
  }

  const ledgerSnap = await monthlyTotals(env);
  const userPrompt = buildUserPrompt(entries, ledgerSnap, windowDays);

  let result: { content: string; usage: { prompt_tokens: number; completion_tokens: number } };
  try {
    result = await withCheckpoint(env, idemKey, "brief", async () => {
      const completion = await chatCompletion({
        req: {
          model: env.LLM_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
        },
        env,
      });
      const content = completion.choices[0]?.message.content ?? "";
      return {
        content,
        usage: {
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
        },
      };
    });
  } catch (err) {
    return failPipeline(env, idemKey, "brief", err, imei);
  }

  try {
    await recordTransaction({ command: "brief", usage: result.usage, env });
  } catch (err) {
    log({
      event: "brief_ledger_write_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const content = result.content.trim();
  if (content.length === 0) {
    return { body: "Brief returned empty. Try again." };
  }
  if (content.length <= REPLY_MAX) {
    return { body: content };
  }

  // Overflow → email.
  try {
    await withCheckpoint(env, idemKey, "brief_overflow_email", async () => {
      const sendResult = await sendEmail({
        to: env.RESEND_FROM_EMAIL,
        subject: `TrailScribe brief (last ${windowDays}d, ${entries.length} entries)`,
        body: `Window: last ${windowDays}d\n\n${content}`,
        env,
      });
      return { id: sendResult.id };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "brief_overflow_email_failed", level: "error", imei, error: msg });
    if (err instanceof ResendError) {
      return { body: `Brief overflow email failed: ${msg.slice(0, 80)}` };
    }
    return { body: `Error: ${msg.slice(0, 80)}` };
  }

  return { body: OVERFLOW_REPLY };
}

function buildUserPrompt(
  entries: FieldLogEntry[],
  ledgerSnap: { requests: number; usd_cost: number },
  windowDays: number,
): string {
  const lines = entries
    .map((e) => {
      const t = new Date(e.ts).toISOString();
      const loc = e.lat !== undefined && e.lon !== undefined ? ` @ ${e.lat},${e.lon}` : "";
      return `- ${t}${loc}: ${e.note}`;
    })
    .join("\n");
  return [
    `Window: last ${windowDays}d. Entries: ${entries.length}.`,
    `Month-to-date: ${ledgerSnap.requests} requests, $${ledgerSnap.usd_cost.toFixed(2)}.`,
    "",
    "FieldLog entries (chronological):",
    lines,
  ].join("\n");
}

async function failPipeline(
  env: OrchestratorContext["env"],
  idemKey: string,
  step: string,
  err: unknown,
  imei: string,
): Promise<CommandResult> {
  const msg = err instanceof Error ? err.message : String(err);
  log({ event: `brief_${step}_failed`, level: "error", imei, error: msg });
  await markFailed(env, idemKey, `${step}: ${msg}`);
  if (err instanceof LLMError) {
    return { body: `Brief failed: ${msg.slice(0, 80)}` };
  }
  return { body: `Error: ${msg.slice(0, 80)}` };
}
