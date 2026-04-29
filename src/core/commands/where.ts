import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { reverseGeocode } from "../../adapters/location/geocode.js";
import { recordTransaction } from "../ledger.js";
import { log } from "../../adapters/logging/worker-logs.js";

type WhereCommand = Extract<ParsedCommand, { type: "where" }>;

const NO_FIX_REPLY = "Need GPS fix — try again outdoors.";
const REPLY_MAX = 320;

/**
 * `!where` pipeline (plan P2-03). Reverse-geocode the device's current GPS
 * fix and reply with `<place>. <Maps link> <MapShare link>` capped at the
 * 320-char two-SMS budget. No LLM call, no idempotency-checkpointed step:
 * `reverseGeocode` is a pure read with KV caching, so a Garmin retry is
 * naturally a cache hit.
 *
 * No-fix path (`lat`/`lon` undefined) replies with a fixed prompt so the
 * operator knows to step out from under canopy. Geocode failures already
 * collapse inside `reverseGeocode` (returns `"unknown location"`), so the
 * handler never sees a thrown error from that call.
 */
export async function handleWhere(
  _cmd: WhereCommand,
  ctx: OrchestratorContext,
): Promise<CommandResult> {
  const { env, lat, lon } = ctx;

  if (lat === undefined || lon === undefined) {
    await recordWhereLedger(ctx);
    return { body: NO_FIX_REPLY };
  }

  const placeName = await reverseGeocode(lat, lon, env);
  const mapsUrl = `${env.GOOGLE_MAPS_BASE}${lat},${lon}`;
  const mapShareUrl = env.MAPSHARE_BASE;
  const links = mapShareUrl ? `${mapsUrl} ${mapShareUrl}` : mapsUrl;
  const body = capReply(`${placeName}. ${links}`);

  await recordWhereLedger(ctx);
  return { body };
}

function capReply(s: string): string {
  return s.length > REPLY_MAX ? s.slice(0, REPLY_MAX) : s;
}

async function recordWhereLedger(ctx: OrchestratorContext): Promise<void> {
  try {
    await recordTransaction({
      command: "where",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env: ctx.env,
    });
  } catch (err) {
    log({
      event: "where_ledger_write_failed",
      level: "warn",
      imei: ctx.imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
