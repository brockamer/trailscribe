import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { chatCompletion, LLMError } from "../../adapters/ai/openrouter.js";
import { sendEmail, ResendError } from "../../adapters/mail/resend.js";
import { recordTransaction } from "../ledger.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { BUDGET_REJECTION_MESSAGE, checkBudget } from "../budget.js";
import { log } from "../../adapters/logging/worker-logs.js";

type AiCommand = Extract<ParsedCommand, { type: "ai" }>;

const REPLY_MAX = 320;
const ESTIMATED_AI_TOKENS = 600;
const SUBJECT_PREVIEW_MAX = 40;
const OVERFLOW_REPLY = "Long answer sent by email.";

const SYSTEM_PROMPT =
  "You are TrailScribe's field research assistant. Answer the user's " +
  "question concisely. Aim for 280 characters or fewer; if more is needed, " +
  "write the full answer and we will route it to email.";

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

  const content = result.content.trim();
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
