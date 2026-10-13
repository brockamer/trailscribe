import type { Env } from "../env.js";
import { appendCostSuffix } from "../env.js";
import type { CommandResult } from "./types.js";
import { buildReply } from "./reply.js";
import { monthlyTotals } from "./ledger.js";
import { markCompleted, withCheckpoint } from "./idempotency.js";
import { deliver } from "../adapters/outbound/deliver.js";
import { log } from "../adapters/logging/worker-logs.js";

/**
 * Send pre-built pages under the `reply` checkpoint, so a replay after a
 * successful send (but before `markCompleted` reached KV) does not send twice.
 * Returns true on send or cache-hit replay; false on send failure.
 */
export async function sendPagesWithCheckpoint(
  env: Env,
  idemKey: string,
  imei: string,
  pages: string[],
): Promise<boolean> {
  try {
    await withCheckpoint(env, idemKey, "reply", async () => {
      await deliver(imei, { pages }, env);
      return { sentAt: Date.now() };
    });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "reply_send_failed", level: "error", imei, error: msg });
    return false;
  }
}

/**
 * The reply tail shared by the Garmin webhook and provider callbacks (#268):
 * optional cost suffix, `buildReply`, checkpointed send, `markCompleted` on
 * success. Returns false when the send failed (record left not completed).
 */
export async function deliverCommandResult(
  env: Env,
  idemKey: string,
  imei: string,
  result: CommandResult,
): Promise<boolean> {
  // The cost suffix is opt-in; only read the ledger when the flag is on, to
  // save the KV round-trip on every reply. The orchestrator already updated
  // the ledger for !ping et al, so this read sees the just-written total.
  const costUsdMtd = appendCostSuffix(env) ? (await monthlyTotals(env)).usd_cost : undefined;
  const pages = buildReply({
    body: result.body,
    journalUrl: result.journalUrl,
    links: result.links,
    costUsdMtd,
    env,
  });
  const ok = await sendPagesWithCheckpoint(env, idemKey, imei, pages);
  if (ok) await markCompleted(env, idemKey);
  return ok;
}
