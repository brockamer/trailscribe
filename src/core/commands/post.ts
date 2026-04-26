import type { CommandResult, ParsedCommand } from "../types.js";
import type { OrchestratorContext } from "../orchestrator.js";
import { reverseGeocode } from "../../adapters/location/geocode.js";
import { currentWeather } from "../../adapters/location/weather.js";
import { generateNarrative } from "../narrative.js";
import { publishPost } from "../../adapters/publish/github-pages.js";
import { recordTransaction } from "../ledger.js";
import { appendEvent } from "../context.js";
import { withCheckpoint, markFailed } from "../idempotency.js";
import { BUDGET_REJECTION_MESSAGE, ESTIMATED_POST_TOKENS, checkBudget } from "../budget.js";
import { log } from "../../adapters/logging/worker-logs.js";

type PostCommand = Extract<ParsedCommand, { type: "post" }>;

export interface HandlePostContext extends OrchestratorContext {
  idemKey: string;
}

/**
 * `!post <note>` end-to-end pipeline (plan P1-16).
 *
 * Composes geocode + weather + narrative + publish + ledger + context-append +
 * reply-build. All side-effecting steps go through `withCheckpoint` so a Garmin
 * webhook replay (post-200, pre-`markCompleted`) skips the expensive ones —
 * we don't republish the blog or burn another OpenRouter call.
 *
 * Skip strategy when no GPS fix:
 *   - geocode + weather are skipped entirely (returning `undefined`).
 *   - narrative receives no `placeName` / `weather` / `lat` / `lon`, so its
 *     prompt omits those lines (no fabricated location detail).
 *   - reply body has no map links (handled by `buildReply` upstream when
 *     `result.lat` / `result.lon` are undefined).
 *
 * On any per-step failure we `markFailed` and return a short error reply; the
 * orchestrator + app.ts will deliver it to the user. A subsequent retry from
 * Garmin re-enters this handler; `withCheckpoint` short-circuits already-done
 * ops so retries cost nothing extra.
 */
export async function handlePost(cmd: PostCommand, ctx: HandlePostContext): Promise<CommandResult> {
  const { env, imei, lat, lon, idemKey } = ctx;

  const budget = await checkBudget(env, ESTIMATED_POST_TOKENS);
  if (!budget.allowed) {
    log({
      event: "post_budget_rejected",
      level: "warn",
      imei,
      remaining: budget.remaining,
    });
    return { body: BUDGET_REJECTION_MESSAGE };
  }

  const hasGps = lat !== undefined && lon !== undefined;

  let placeName: string | undefined;
  let weather: string | undefined;
  if (hasGps) {
    const [placeResult, weatherResult] = await Promise.allSettled([
      reverseGeocode(lat, lon, env),
      currentWeather(lat, lon, env),
    ]);
    if (placeResult.status === "fulfilled") placeName = placeResult.value;
    else
      log({
        event: "post_geocode_failed",
        level: "warn",
        imei,
        error:
          placeResult.reason instanceof Error
            ? placeResult.reason.message
            : String(placeResult.reason),
      });
    if (weatherResult.status === "fulfilled") weather = weatherResult.value;
    else
      log({
        event: "post_weather_failed",
        level: "warn",
        imei,
        error:
          weatherResult.reason instanceof Error
            ? weatherResult.reason.message
            : String(weatherResult.reason),
      });
  }

  let narrative: Awaited<ReturnType<typeof generateNarrative>>;
  try {
    narrative = await withCheckpoint(env, idemKey, "narrative", () =>
      generateNarrative({
        note: cmd.note,
        lat,
        lon,
        placeName,
        weather,
        env,
      }),
    );
  } catch (err) {
    return failPipeline(env, idemKey, "narrative", err);
  }

  let publishResult: Awaited<ReturnType<typeof publishPost>>;
  try {
    publishResult = await withCheckpoint(env, idemKey, "publish", () =>
      publishPost({
        title: narrative.title,
        haiku: narrative.haiku,
        body: narrative.body,
        lat,
        lon,
        placeName,
        weather,
        env,
      }),
    );
  } catch (err) {
    return failPipeline(env, idemKey, "publish", err);
  }

  // Ledger + context are best-effort: a failure here doesn't block the user
  // reply (which is what they actually care about).
  try {
    await recordTransaction({
      command: "post",
      usage: narrative.usage,
      env,
    });
  } catch (err) {
    log({
      event: "post_ledger_write_failed",
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
        command_type: "post",
        free_text: cmd.note,
      },
      env,
    );
  } catch (err) {
    log({
      event: "post_context_append_failed",
      level: "warn",
      imei,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const body = `Posted: ${narrative.title} · ${publishResult.url}`;
  return { body };
}

async function failPipeline(
  env: HandlePostContext["env"],
  idemKey: string,
  step: "narrative" | "publish",
  err: unknown,
): Promise<CommandResult> {
  const msg = err instanceof Error ? err.message : String(err);
  log({ event: `post_${step}_failed`, level: "error", error: msg });
  await markFailed(env, idemKey, `${step}: ${msg}`);
  return { body: `Error: ${msg.slice(0, 80)}` };
}
