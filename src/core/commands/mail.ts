import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { reverseGeocode } from "../../adapters/location/geocode.js";
import { currentWeather } from "../../adapters/location/weather.js";
import { sendEmail, ResendError } from "../../adapters/mail/resend.js";
import { recordTransaction } from "../ledger.js";
import { appendEvent } from "../context.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { log } from "../../adapters/logging/worker-logs.js";

type MailCommand = Extract<ParsedCommand, { type: "mail" }>;

interface HandleMailContext extends OrchestratorContext {
  idemKey: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * `!mail to:_ subj:_ body:_` pipeline (plan P1-17).
 *
 * Composes optional geocode/weather → enriched email body → Resend send
 * (checkpointed) → ledger + context. Reply is `"Sent to <to>"` with map links
 * appended via buildReply when GPS is present.
 */
export async function handleMail(cmd: MailCommand, ctx: HandleMailContext): Promise<CommandResult> {
  const { env, imei, lat, lon, idemKey } = ctx;

  if (!EMAIL_RE.test(cmd.to)) {
    return { body: `Bad to: ${cmd.to.slice(0, 60)}` };
  }

  const hasGps = lat !== undefined && lon !== undefined;
  let placeName: string | undefined;
  let weather: string | undefined;
  if (hasGps) {
    const [placeR, wxR] = await Promise.allSettled([
      reverseGeocode(lat, lon, env),
      currentWeather(lat, lon, env),
    ]);
    if (placeR.status === "fulfilled") placeName = placeR.value;
    if (wxR.status === "fulfilled") weather = wxR.value;
  }

  const enrichedBody = composeBody(cmd.body, hasGps, placeName, weather, lat, lon);

  try {
    await withCheckpoint(env, idemKey, "mail", async () => {
      const result = await sendEmail({
        to: cmd.to,
        subject: cmd.subj,
        body: enrichedBody,
        env,
      });
      return { id: result.id };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ event: "mail_send_failed", level: "error", imei, to: cmd.to, error: msg });
    await markFailed(env, idemKey, `mail: ${msg}`);
    if (err instanceof ResendError) {
      return { body: `Mail failed: ${msg.slice(0, 80)}` };
    }
    return { body: `Error: ${msg.slice(0, 80)}` };
  }

  try {
    await recordTransaction({
      command: "mail",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env,
    });
  } catch (err) {
    log({
      event: "mail_ledger_write_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await appendEvent(
      imei,
      {
        timestamp: Date.now(),
        lat,
        lon,
        command_type: "mail",
        free_text: `${cmd.to}|${cmd.subj}`,
      },
      env,
    );
  } catch (err) {
    log({
      event: "mail_context_append_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return { body: `Sent to ${cmd.to}` };
}

function composeBody(
  userBody: string,
  hasGps: boolean,
  placeName: string | undefined,
  weather: string | undefined,
  lat: number | undefined,
  lon: number | undefined,
): string {
  const iso = new Date().toISOString();
  const footer = hasGps
    ? `\n\n---\nFrom inReach @ ${placeName ?? "unknown"} (${lat},${lon}, ${weather ?? "weather unavailable"}) — sent ${iso}`
    : `\n\n---\nFrom inReach — sent ${iso}`;
  return userBody + footer;
}
