import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { reverseGeocode } from "../../adapters/location/geocode.js";
import { sendEmail } from "../../adapters/mail/resend.js";
import { resolve as resolveAlias } from "../addressbook.js";
import { recordTransaction } from "../ledger.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { log } from "../../adapters/logging/worker-logs.js";

type BlastCommand = Extract<ParsedCommand, { type: "blast" }>;

const SUBJECT = "TrailScribe — broadcast from the field";
const ALL_GROUP = "all";

/**
 * `!blast <note>` pipeline (plan P2-11). Resolves the `all` alias from the
 * address book and sends one Resend call per recipient. Per-recipient errors
 * are tolerated — one bad address does not block the rest; the device reply
 * summarizes successes vs. failures.
 *
 * The full multi-send is wrapped in a single `withCheckpoint('blast')` whose
 * cached result is the per-recipient outcome map. On retry storms, the entire
 * blast is replayed-once at the storage layer; we don't checkpoint each
 * recipient individually because partial-failure is part of the contract,
 * and the operator's expectation on retry is "the same outcome as before."
 */
export async function handleBlast(
  cmd: BlastCommand,
  ctx: OrchestratorContext,
): Promise<CommandResult> {
  const { env, imei, lat, lon, idemKey } = ctx;

  let recipients: string[];
  try {
    recipients = resolveAlias(env, ALL_GROUP);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "blast_no_group", level: "warn", imei, error: msg });
    return { body: "No blast group configured." };
  }
  if (recipients.length === 0) {
    return { body: "No blast group configured." };
  }

  const hasGps = lat !== undefined && lon !== undefined;
  let placeName: string | undefined;
  if (hasGps) {
    try {
      placeName = await reverseGeocode(lat, lon, env);
    } catch (err) {
      log({
        event: "blast_geocode_failed",
        level: "warn",
        imei,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const body = composeBody(cmd.note, hasGps, placeName, lat, lon, env);

  let outcome: { sent: number; failed: number };
  try {
    outcome = await withCheckpoint(env, idemKey, "blast", async () => {
      let sent = 0;
      let failed = 0;
      for (const to of recipients) {
        try {
          await sendEmail({ to, subject: SUBJECT, body, env });
          sent += 1;
        } catch (err) {
          failed += 1;
          log({
            event: "blast_send_failed",
            level: "warn",
            imei,
            to,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return { sent, failed };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "blast_pipeline_failed", level: "error", imei, error: msg });
    await markFailed(env, idemKey, `blast: ${msg}`);
    return { body: `Error: ${msg.slice(0, 80)}` };
  }

  try {
    await recordTransaction({
      command: "blast",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env,
    });
  } catch (err) {
    log({
      event: "blast_ledger_write_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { body: `Blasted to ${outcome.sent} (${outcome.failed} failed).` };
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
