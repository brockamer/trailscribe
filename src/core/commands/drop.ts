import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { appendEntry, getEntries } from "../fieldlog.js";
import { recordTransaction } from "../ledger.js";
import { log } from "../../adapters/logging/worker-logs.js";

type DropCommand = Extract<ParsedCommand, { type: "drop" }>;

const PREVIEW_MAX = 40;
const REPLY_MAX = 320;

/**
 * `!drop <note>` pipeline (plan P2-05). Appends one structured entry to the
 * per-IMEI FieldLog with timestamp + GPS + free-text note, then replies with
 * a count.
 *
 * Idempotency lives in `appendEntry`: the entry's `id` is the orchestrator's
 * event idempotency key, so a Garmin retry storm collapses to a no-op at the
 * KV layer (defense-in-depth alongside Phase 1's `withCheckpoint`). That's
 * why the handler doesn't itself wrap the append in `withCheckpoint` — the
 * storage layer is already replay-safe by construction.
 */
export async function handleDrop(
  cmd: DropCommand,
  ctx: OrchestratorContext,
): Promise<CommandResult> {
  const { env, imei, lat, lon, idemKey } = ctx;
  const note = cmd.note;

  await appendEntry(env, imei, {
    id: idemKey,
    ts: Date.now(),
    lat,
    lon,
    note,
    source: "drop",
  });

  const entries = await getEntries(env, imei);
  const preview = note.length > PREVIEW_MAX ? note.slice(0, PREVIEW_MAX) : note;
  const body = capReply(`Logged: ${preview}. (${entries.length} entries)`);

  await recordDropLedger(ctx);
  return { body };
}

function capReply(s: string): string {
  return s.length > REPLY_MAX ? s.slice(0, REPLY_MAX) : s;
}

async function recordDropLedger(ctx: OrchestratorContext): Promise<void> {
  try {
    await recordTransaction({
      command: "drop",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env: ctx.env,
    });
  } catch (err) {
    log({
      event: "drop_ledger_write_failed",
      level: "warn",
      imei: ctx.imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
