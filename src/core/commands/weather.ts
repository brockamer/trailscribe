import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { currentWeather } from "../../adapters/location/weather.js";
import { recordTransaction } from "../ledger.js";
import { log } from "../../adapters/logging/worker-logs.js";

type WeatherCommand = Extract<ParsedCommand, { type: "weather" }>;

const NO_FIX_REPLY = "Need GPS fix — try again outdoors.";
const REPLY_MAX = 320;

/**
 * `!weather` pipeline (plan P2-04). Returns the cached Open-Meteo current-
 * conditions string for the device's GPS fix. No LLM call, no state write —
 * mirrors the `!where` shape and reuses the Phase 1 weather adapter.
 *
 * The adapter already returns a compact `<temp>, <wind>, <label>` string and
 * handles its own failure modes (network/HTTP/JSON/missing-fields all collapse
 * to `"weather unavailable"`), so the handler never sees a thrown error from
 * `currentWeather`.
 *
 * Note: P2-04's plan-text acceptance describes an expanded `Hi <hi>° / Lo <lo>°.
 * <wind>kt <dir>.` format with a next-24h summary. That would need a second
 * Open-Meteo daily-forecast call (the existing adapter only fetches current
 * conditions). Filed as a follow-up if the short form proves insufficient in
 * the field; for now we ship the adapter's existing output to keep this PR a
 * pure dispatch carve-out.
 */
export async function handleWeather(
  _cmd: WeatherCommand,
  ctx: OrchestratorContext,
): Promise<CommandResult> {
  const { env, lat, lon } = ctx;

  if (lat === undefined || lon === undefined) {
    await recordWeatherLedger(ctx);
    return { body: NO_FIX_REPLY };
  }

  const weather = await currentWeather(lat, lon, env);
  const body = capReply(weather);

  await recordWeatherLedger(ctx);
  return { body };
}

function capReply(s: string): string {
  return s.length > REPLY_MAX ? s.slice(0, REPLY_MAX) : s;
}

async function recordWeatherLedger(ctx: OrchestratorContext): Promise<void> {
  try {
    await recordTransaction({
      command: "weather",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      env: ctx.env,
    });
  } catch (err) {
    log({
      event: "weather_ledger_write_failed",
      level: "warn",
      imei: ctx.imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
