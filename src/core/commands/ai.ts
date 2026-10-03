import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { chatCompletion, LLMError } from "../../adapters/ai/openrouter.js";
import { sendEmail, ResendError } from "../../adapters/mail/resend.js";
import { recordTransaction } from "../ledger.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { BUDGET_REJECTION_MESSAGE, checkBudget } from "../budget.js";
import { log } from "../../adapters/logging/worker-logs.js";
import { PLAIN_TEXT_INSTRUCTION, stripMarkdownEmphasis } from "../plaintext.js";

type AiCommand = Extract<ParsedCommand, { type: "ai" }>;

const REPLY_MAX = 320;
/** Typical measured total (see `ESTIMATED_POST_TOKENS`): 418–456 on Opus 5.5 (#265). */
const ESTIMATED_AI_TOKENS = 600;
/**
 * Output cap (#265). Without one, OpenRouter reserves credit for 65,536
 * completion tokens (about $1.31 on Opus 5.5) before the call runs and returns
 * 402 when the balance is lower. At 3000 it reserves $0.06, the same as a track
 * post. The model's hidden reasoning tokens count against the cap. Short
 * answers measured 324–373 completion tokens; a long-form question measured
 * 1,733 (615 reasoning, 2,879 characters of answer), so 3000 leaves room for an
 * answer of about 6,000 characters, which overflows to email.
 */
const AI_MAX_TOKENS = 3000;
const SUBJECT_PREVIEW_MAX = 40;
const OVERFLOW_REPLY = "Long answer sent by email.";

const SYSTEM_PROMPT =
  "You are TrailScribe's field research assistant. Answer the user's " +
  "question concisely. Aim for 280 characters or fewer; if more is needed, " +
  "write the full answer and we will route it to email. " +
  PLAIN_TEXT_INSTRUCTION;

/**
 * `!ai <question>` pipeline (plan P2-07). Open-ended LLM Q&A via OpenRouter.
 *
 * Reply path:
 *   - LLM output ≤ 320 chars: reply directly on device.
 *   - LLM output > 320 chars: reply `Long answer sent by email.` and Resend
 *     the full answer to the operator email.
 *
 * The LLM call is checkpointed so a Garmin retry storm does not double-bill
 * OpenRouter. The Resend send is also checkpointed under a separate op so a
 * mid-retry can short-circuit the email send too.
 *
 * Empty question is rejected upstream by the grammar.
 */
export async function handleAi(cmd: AiCommand, ctx: OrchestratorContext): Promise<CommandResult> {
  const { env, imei, idemKey } = ctx;

  const budget = await checkBudget(env, ESTIMATED_AI_TOKENS);
  if (!budget.allowed) {
    log({ event: "ai_budget_rejected", level: "warn", imei, remaining: budget.remaining });
    return { body: BUDGET_REJECTION_MESSAGE };
  }

  let result: { content: string; usage: { prompt_tokens: number; completion_tokens: number } };
  try {
    result = await withCheckpoint(env, idemKey, "ai", async () => {
      const completion = await chatCompletion({
        req: {
          model: env.LLM_MODEL,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: cmd.question },
          ],
          max_tokens: AI_MAX_TOKENS,
        },
        env,
      });
      const choice = completion.choices[0];
      if (choice?.finish_reason === "length") {
        log({
          event: "ai_truncated",
          level: "warn",
          imei,
          max_tokens: AI_MAX_TOKENS,
          completion_tokens: completion.usage.completion_tokens,
        });
      }
      const content = choice?.message.content ?? "";
      return {
        content,
        usage: {
          prompt_tokens: completion.usage.prompt_tokens,
          completion_tokens: completion.usage.completion_tokens,
        },
      };
    });
  } catch (err) {
    return failPipeline(env, idemKey, "ai", err, imei);
  }

  // Ledger always records — even if email overflow path runs we want the LLM
  // cost captured.
  try {
    await recordTransaction({
      command: "ai",
      usage: result.usage,
      env,
    });
  } catch (err) {
    log({
      event: "ai_ledger_write_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const content = stripMarkdownEmphasis(result.content.trim());
  if (content.length === 0) {
    return { body: "AI returned empty reply. Try rephrasing." };
  }
  if (content.length <= REPLY_MAX) {
    return { body: content };
  }

  // Overflow: route the full answer via email; device gets the short pointer.
  try {
    await withCheckpoint(env, idemKey, "ai_overflow_email", async () => {
      const subjectPreview =
        cmd.question.length > SUBJECT_PREVIEW_MAX
          ? cmd.question.slice(0, SUBJECT_PREVIEW_MAX)
          : cmd.question;
      const sendResult = await sendEmail({
        to: env.RESEND_FROM_EMAIL,
        subject: `TrailScribe !ai: ${subjectPreview}`,
        body: `Question:\n${cmd.question}\n\n---\n\n${content}`,
        env,
      });
      return { id: sendResult.id };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "ai_overflow_email_failed", level: "error", imei, error: msg });
    if (err instanceof ResendError) {
      return { body: `AI overflow email failed: ${msg.slice(0, 80)}` };
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
  log({ event: `ai_${step}_failed`, level: "error", imei, error: msg });
  await markFailed(env, idemKey, `${step}: ${msg}`);
  if (err instanceof LLMError) {
    return { body: `AI failed: ${msg.slice(0, 80)}` };
  }
  return { body: `Error: ${msg.slice(0, 80)}` };
}
