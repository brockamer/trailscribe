import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { reverseGeocode } from "../../adapters/location/geocode.js";
import { sendEmail, ResendError } from "../../adapters/mail/resend.js";
import { resolve as resolveAlias, isValidEmail } from "../addressbook.js";
import { recordTransaction } from "../ledger.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { log } from "../../adapters/logging/worker-logs.js";

type ShareCommand = Extract<ParsedCommand, { type: "share" }>;

const SUBJECT = "TrailScribe — note from the field";

/**
 * `!share to:<addr|alias> <note>` pipeline (plan P2-10). Single-recipient
 * variant of `!mail` with alias resolution. Reuses Phase 1's Resend adapter;
 * the only new behavior is the address-book lookup when `to` does not look
 * like a literal email.
 */
export async function handleShare(
  cmd: ShareCommand,
  ctx: OrchestratorContext,
): Promise<CommandResult> {
  const { env, imei, lat, lon, idemKey } = ctx;

  let recipient: string;
  let displayLabel: string;
  if (cmd.to.includes("@")) {
    if (!isValidEmail(cmd.to)) {
      return { body: `Bad to: ${cmd.to.slice(0, 60)}` };
    }
    recipient = cmd.to;
    displayLabel = truncateForReply(cmd.to);
  } else {
    let resolved: string[];
    try {
      resolved = resolveAlias(env, cmd.to);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log({ event: "share_alias_unknown", level: "warn", imei, alias: cmd.to, error: msg });
      return { body: `Unknown alias: ${cmd.to.slice(0, 60)}` };
    }
    if (resolved.length === 0) {
      return { body: `Unknown alias: ${cmd.to.slice(0, 60)}` };
    }
    if (resolved.length > 1) {
      log({
        event: "share_alias_multiple",
        level: "warn",
        imei,
        alias: cmd.to,
        count: resolved.length,
      });
    }
    recipient = resolved[0];
    displayLabel = cmd.to;
  }

  const hasGps = lat !== undefined && lon !== undefined;
  let placeName: string | undefined;
  if (hasGps) {
    try {
      placeName = await reverseGeocode(lat, lon, env);
    } catch (err) {
      log({
        event: "share_geocode_failed",
        level: "warn",
        imei,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const body = composeBody(cmd.note, hasGps, placeName, lat, lon, env);

  try {
    await withCheckpoint(env, idemKey, "share", async () => {
      const result = await sendEmail({ to: recipient, subject: SUBJECT, body, env });
      return { id: result.id };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "share_send_failed", level: "error", imei, error: msg });
    await markFailed(env, idemKey, `share: ${msg}`);
    if (err instanceof ResendError) {
      return { body: `Share failed: ${msg.slice(0, 80)}` };
    }
    return { body: `Error: ${msg.slice(0, 80)}` };
  }

  try {
    await recordTransaction({
      command: "share",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env,
    });
  } catch (err) {
    log({
      event: "share_ledger_write_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!hasGps) {
    return { body: "Shared (no GPS)." };
  }
  return { body: `Shared with ${displayLabel}.` };
}

function composeBody(
  note: string,
  hasGps: boolean,
  placeName: string | undefined,
  lat: number | undefined,
  lon: number | undefined,
  env: OrchestratorContext["env"],
): string {
  const iso = new Date().toISOString();
  if (!hasGps) {
    return `${note}\n\n---\nFrom inReach — sent ${iso}`;
  }
  const mapsUrl = `${env.GOOGLE_MAPS_BASE}${lat},${lon}`;
  const mapShareLine = env.MAPSHARE_BASE.length > 0 ? `\nMapShare: ${env.MAPSHARE_BASE}` : "";
  return [
    note,
    "",
    "---",
    `From inReach @ ${placeName ?? "unknown"} (${lat},${lon}) — sent ${iso}`,
    `Maps: ${mapsUrl}${mapShareLine}`,
  ].join("\n");
}

function truncateForReply(s: string): string {
  return s.length > 40 ? s.slice(0, 40) : s;
}
