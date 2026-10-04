import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { chatCompletion, LLMError } from "../../adapters/ai/openrouter.js";
import { sendEmail, ResendError } from "../../adapters/mail/resend.js";
import { recordTransaction } from "../ledger.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { BUDGET_REJECTION_MESSAGE, checkBudget } from "../budget.js";
import { log } from "../../adapters/logging/worker-logs.js";
import { PLAIN_TEXT_INSTRUCTION, stripMarkdownEmphasis } from "../plaintext.js";

type CampCommand = Extract<ParsedCommand, { type: "camp" }>;

const REPLY_MAX = 320;
/** Typical measured total (see `ESTIMATED_POST_TOKENS`): 345–581 on Opus 5.5 (#265). */
const ESTIMATED_CAMP_TOKENS = 600;
/**
 * Output cap (#265). Without one, OpenRouter reserves credit for 65,536
 * completion tokens (about $1.31 on Opus 5.5) and returns 402 when the balance
 * is lower. At 2000 it reserves $0.04, the same as a `!post`. Measured
 * completions, the model's hidden reasoning tokens included: 230–465.
 */
const CAMP_MAX_TOKENS = 2000;
const SUBJECT_PREVIEW_MAX = 40;
const STALENESS_PREFIX = "(may be outdated) ";
const OVERFLOW_REPLY = "Long answer sent by email.";

const SYSTEM_PROMPT =
  "You are TrailScribe's outdoors-knowledge assistant. The user is in the " +
  "field with no internet. Answer their question about camping, water " +
  "sources, or outdoor features concisely. Be conservative — say " +
  '"uncertain" rather than guess. Aim for 280 characters. ' +
  PLAIN_TEXT_INSTRUCTION;

/**
 * `!camp <query>` pipeline (plan P2-08). LLM-only first cut: the model
 * answers from general knowledge and the reply is prefixed with
 * "(may be outdated)" so the operator never confuses field guidance with
 * real-time data. Real web-search integration is filed as P2-08b — not
 * blocking Phase 2 close.
 *
 * Mirrors `!ai`: budget gate → LLM (checkpointed) → ledger → reply or
 * overflow-to-email. Same idempotency posture.
 */
export async function handleCamp(
  cmd: CampCommand,
  ctx: OrchestratorContext,
): Promise<CommandResult> {
  const { env, imei, idemKey } = ctx;

  const budget = await checkBudget(env, ESTIMATED_CAMP_TOKENS);
  if (!budget.allowed) {
    log({ event: "camp_budget_rejected", level: "warn", imei, remaining: budget.remaining });
    return { body: BUDGET_REJECTION_MESSAGE };
  }

  let result: {
    content: string;
    filtered?: boolean;
    usage: { prompt_tokens: number; completion_tokens: number };
  };
  try {
    result = await withCheckpoint(env, idemKey, "camp", async () => {
      const completion = await chatCompletion({
        req: {
          model: env.LLM_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: cmd.query },
          ],
          max_tokens: CAMP_MAX_TOKENS,
        },
        env,
        label: "camp",
      });
      const choice = completion.choices[0];
      const content = choice?.message.content ?? "";
      return {
        content,
        filtered: choice?.finish_reason === "content_filter",
        usage: {
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
        },
      };
    });
  } catch (err) {
    return failPipeline(env, idemKey, "camp", err, imei);
  }

  try {
    await recordTransaction({
      command: "camp",
      usage: result.usage,
      env,
    });
  } catch (err) {
    log({
      event: "camp_ledger_write_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const content = stripMarkdownEmphasis(result.content.trim());
  if (content.length === 0) {
    // The adapter already retried once (#270); the answer was blocked twice.
    if (result.filtered)
      return { body: "Camp lookup blocked by the provider's filter. Try again." };
    return { body: "Camp lookup returned empty. Try rephrasing." };
  }

  const prefixed = STALENESS_PREFIX + content;
  if (prefixed.length <= REPLY_MAX) {
    return { body: prefixed };
  }

  // Overflow → email full answer (with the staleness prefix preserved on the
  // device pointer reply via OVERFLOW_REPLY's wording).
  try {
    await withCheckpoint(env, idemKey, "camp_overflow_email", async () => {
      const subjectPreview =
        cmd.query.length > SUBJECT_PREVIEW_MAX
          ? cmd.query.slice(0, SUBJECT_PREVIEW_MAX)
          : cmd.query;
      const sendResult = await sendEmail({
        to: env.RESEND_FROM_EMAIL,
        subject: `TrailScribe !camp: ${subjectPreview}`,
        body: `Query:\n${cmd.query}\n\n---\n\n${prefixed}`,
        env,
      });
      return { id: sendResult.id };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "camp_overflow_email_failed", level: "error", imei, error: msg });
    if (err instanceof ResendError) {
      return { body: `Camp overflow email failed: ${msg.slice(0, 80)}` };
    }
    return { body: `Error: ${msg.slice(0, 80)}` };
  }

  return { body: OVERFLOW_REPLY };
}

async function failPipeline(
  env: OrchestratorContext["env"],
  idemKey: string,
  step: string,
  err: unknown,
  imei: string,
): Promise<CommandResult> {
  const msg = err instanceof Error ? err.message : String(err);
  log({ event: `camp_${step}_failed`, level: "error", imei, error: msg });
  await markFailed(env, idemKey, `${step}: ${msg}`);
  if (err instanceof LLMError) {
    return { body: `Camp lookup failed: ${msg.slice(0, 80)}` };
  }
  return { body: `Error: ${msg.slice(0, 80)}` };
}
