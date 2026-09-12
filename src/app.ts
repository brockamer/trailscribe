import { Hono } from "hono";
import type { Env } from "./env.js";
import { appendCostSuffix, imeiAllowSet, ipcInboundDryRun, logTrackPayloads } from "./env.js";
import type { CommandResult, GarminEnvelope, GarminEvent } from "./core/types.js";
import {
  idempotencyKey,
  readRecord,
  writeRecord,
  withCheckpoint,
  markCompleted,
  markFailed,
} from "./core/idempotency.js";
import { log } from "./adapters/logging/worker-logs.js";
import { parseCommand } from "./core/grammar.js";
import { orchestrate } from "./core/orchestrator.js";
import { sendReply } from "./adapters/outbound/garmin-ipc-inbound.js";
import { buildReply } from "./core/reply.js";
import { monthlyTotals } from "./core/ledger.js";
import {
  handleStopTrack,
  recordSessionStart,
  recordTrackInterval,
  recordTrackEvent,
} from "./core/tracking.js";

/**
 * Garmin tracking event codes. mc 0 = Position Report, mc 10 = Start Track,
 * mc 11 = Track Interval, mc 12 = Stop Track. mc 12 is routed separately
 * through handleStopTrack above; the others currently log via non_free_text
 * with optional payload capture for diagnostic purposes.
 */
const TRACK_MESSAGE_CODES: readonly number[] = [0, 10, 11, 12] as const;

/**
 * Run an orchestrator with the standard error contract: log on throw, mark the
 * idempotency record completed/failed for observability, never propagate the
 * error (Garmin must always receive 200; otherwise it triggers the
 * 2/4/8/16/32/64/128s retry escalator + 12h × 5d pause cycle, PRD §5).
 *
 * Use this for any branch in handleEvent that invokes a side-effecting
 * orchestrator like handleStopTrack. Extends naturally as new tracking events
 * (Start Track, Position Report) get their own routing branches in later cuts.
 */
async function safeOrchestrate(
  opLabel: string,
  fn: () => Promise<void>,
  env: Env,
  key: string,
  imei: string,
): Promise<void> {
  try {
    await fn();
    await markCompleted(env, key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({
      event: `${opLabel}_error`,
      level: "error",
      imei,
      error: msg,
      key,
    });
    await markFailed(env, key, msg);
  }
}

/**
 * Hono app factory. Lives in its own module so tests can call `makeApp()`
 * and drive the handler via `app.request(...)` without Miniflare.
 */
export function makeApp() {
  const app = new Hono<{ Bindings: Env }>();

  app.get("/", (c) => c.text("TrailScribe α-MVP (Phase 0)"));

  app.get("/health", (c) =>
    c.json({
      ok: true,
      env: c.env.TRAILSCRIBE_ENV,
      timestamp: new Date().toISOString(),
      dry_run: ipcInboundDryRun(c.env),
    }),
  );

  /**
   * Garmin IPC Outbound receiver.
   *
   * Per PRD §4, §5 + plan P1-01 + P1-13:
   *   1. Verify bearer token (static, configured on Garmin Portal Connect).
   *   2. Parse body as Garmin V2 envelope.
   *   3. Per event: verify IMEI allowlist; compute idempotency key; on
   *      `status="completed"` replay short-circuit immediately. Other states
   *      (received/processing/failed) fall through; per-op `withCheckpoint`
   *      calls skip already-done sub-ops.
   *   4. Guard 1 — only `messageCode === 3` (Free Text) dispatches. SOS
   *      (`messageCode === 4`) is logged and dropped per PRD §1 ("not a
   *      safety system"). Position Reports (`messageCode === 0`) and other
   *      non-FT events are logged and dropped.
   *   5. Guard 2 — strip lat/lon when there's no GPS fix (Garmin fills zeros
   *      per Outbound v2.0.8 §Event Schema V2).
   *   6. Parse → orchestrate → reply via IPC Inbound. Errors at any step are
   *      logged and the Worker still returns 200, avoiding Garmin's retry
   *      cascade for app-level failures.
   */
  app.post("/garmin/ipc", async (c) => {
    const auth = c.req.header("x-outbound-auth-token");
    const expected = c.env.GARMIN_INBOUND_TOKEN;
    if (!auth || auth !== expected) {
      log({ event: "auth_fail", level: "warn", path: "/garmin/ipc" });
      return c.text("ok", 200);
    }

    // Read the raw text once so we can both parse it and capture a sample for
    // the ipc_received diagnostic. Parsing happens after capture so even an
    // un-parseable body is visible in logs.
    const rawBody = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      log({
        event: "bad_json",
        level: "warn",
        bodyBytes: rawBody.length,
        rawBodySample: rawBody.slice(0, 1024),
      });
      return c.text("ok", 200);
    }

    // Diagnostic: log envelope shape on every webhook POST so we can see what
    // Garmin actually sends. Counts events, lists top-level keys, and snapshots
    // the first 1KB of raw body. One log per webhook (low volume — Garmin IPC
    // batches per-device). Not gated on any flag — this is metadata about the
    // shape, not payload contents.
    log({
      event: "ipc_received",
      level: "info",
      bodyBytes: rawBody.length,
      version:
        typeof (body as { Version?: unknown })?.Version === "string"
          ? (body as { Version: string }).Version
          : null,
      topLevelKeys:
        body && typeof body === "object" && !Array.isArray(body)
          ? Object.keys(body as Record<string, unknown>)
          : [],
      eventsLength: Array.isArray((body as { Events?: unknown })?.Events)
        ? (body as { Events: unknown[] }).Events.length
        : null,
      rawBodySample: rawBody.slice(0, 1024),
    });

    if (!isGarminEnvelope(body)) {
      log({ event: "bad_envelope", level: "warn" });
      return c.text("ok", 200);
    }

    const allow = imeiAllowSet(c.env);
    for (const event of body.Events) {
      await handleEvent(event, c.env, allow);
    }

    return c.text("ok", 200);
  });

  return app;
}

async function handleEvent(event: GarminEvent, env: Env, allow: Set<string>): Promise<void> {
  if (!event.imei || !allow.has(event.imei)) {
    log({ event: "imei_not_allowed", level: "warn", imei: event.imei });
    return;
  }

  const key = await idempotencyKey(event);

  const existing = await readRecord(env, key);
  if (existing?.status === "completed") {
    log({
      event: "idempotent_replay",
      level: "info",
      imei: event.imei,
      messageCode: event.messageCode,
      key,
    });
    return;
  }

  // First delivery (or partial-progress replay): seed/refresh the record.
  // Subsequent withCheckpoint calls and the terminal markCompleted/markFailed
  // overwrite this entry, preserving any completedOps/opResults from a prior
  // partial run.
  if (!existing) {
    await writeRecord(env, key, { status: "received", receivedAt: Date.now() });
  }

  if (event.messageCode !== 3) {
    // #201: Latch the device's current tracking interval whenever a tracking
    // event carries a nonzero change. Per Garmin IPC Outbound spec, the
    // intervalChange field is nonzero only on actual changes (0 = unchanged),
    // so most events flow past this no-op. Persisted in TS_TRACKS as
    // `track_interval:<imei>` and read by handleStopTrack's refusal branches
    // to surface a (interval: Xh) hint when the device autonomously bumped
    // to a long interval. Runs BEFORE the per-mc dispatch so the value is
    // visible to handleStopTrack on a mc=12 event whose own status carries
    // an intervalChange.
    // Diagnostic history for #201. `recordTrackInterval` below keeps a single
    // number and discards the rest of `status`, which is why the 2026-09-12
    // walking field test could not be explained: the device announced a
    // 14400 s interval two minutes into a walk on a unit set to 2 minutes, and
    // the payload that would say why was already gone.
    //
    // Recorded for every tracking message code, not just those with a nonzero
    // intervalChange — an mc 11 reporting 0 is itself evidence about what that
    // field means. mc 0 matters most of all: MapShare and the IPC Outbound
    // breadcrumb stream are independent, so capturing mc 0 here shows whether
    // the device transmitted position reports at all, regardless of what
    // reached MapShare.
    //
    // Best-effort: a diagnostic write must never fail the request path, or the
    // instrument becomes the outage.
    if (TRACKING_MESSAGE_CODES.has(event.messageCode)) {
      try {
        await recordTrackEvent(env, event.imei, event);
      } catch (err) {
        log({
          event: "track_event_record_failed",
          level: "warn",
          imei: event.imei,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const intervalChange = event.status?.intervalChange;
    if (typeof intervalChange === "number" && intervalChange > 0) {
      try {
        await recordTrackInterval(env, event.imei, intervalChange);
        log({
          event: "track_interval_recorded",
          level: "info",
          imei: event.imei,
          intervalSec: intervalChange,
          messageCode: event.messageCode,
          key,
        });
      } catch (err) {
        log({
          event: "track_interval_record_failed",
          level: "warn",
          imei: event.imei,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (event.messageCode === 4) {
      log({ event: "sos_received_ignored", level: "warn", imei: event.imei, key });
    } else if (event.messageCode === 12) {
      await safeOrchestrate(
        "stop_track_handler",
        () => handleStopTrack(event, env, key),
        env,
        key,
        event.imei,
      );
    } else if (event.messageCode === 10) {
      // Start Track — record the session's start timestamp so the next mc 12
      // (Stop Track) for this IMEI uses it as the MapShare KML query's d1
      // lower bound. Without this, closely-spaced sessions conflate.
      try {
        await recordSessionStart(env, event.imei, event.timeStamp);
        log({
          event: "track_session_start_recorded",
          level: "info",
          imei: event.imei,
          startedAt: event.timeStamp,
          key,
        });
      } catch (err) {
        log({
          event: "track_session_start_record_failed",
          level: "warn",
          imei: event.imei,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      const isTrack = TRACK_MESSAGE_CODES.includes(event.messageCode);
      log({
        event: "non_free_text",
        level: "info",
        imei: event.imei,
        messageCode: event.messageCode,
        key,
        // Diagnostic: when LOG_TRACK_PAYLOADS=true, attach the full tracking
        // event so a fixture can be reconstructed from logs. Silent-drop
        // policy is unchanged — this only affects the log line's content.
        ...(isTrack && logTrackPayloads(env) ? { payload: event } : {}),
      });
    }
    return;
  }

  const point = event.point;
  const hasFix = !!point && point.gpsFix !== 0 && !(point.latitude === 0 && point.longitude === 0);
  const lat = hasFix ? point.latitude : undefined;
  const lon = hasFix ? point.longitude : undefined;

  // Intercept policy (PRD §8 D10): silent-drop messages that don't begin with
  // `!` so casual operator traffic to friends/family is invisible to TrailScribe.
  // `!`-prefixed unknowns still receive "Try !help" so command typos remain
  // recoverable. See #122.
  const trimmed = (event.freeText ?? "").trim();
  if (!trimmed.startsWith("!")) {
    log({
      event: "intercept_skipped",
      level: "info",
      imei: event.imei,
      reason: "non-command",
      freeTextPreview: trimmed.slice(0, 80),
      key,
    });
    await markCompleted(env, key);
    return;
  }

  const command = parseCommand(trimmed);
  if (!command) {
    log({
      event: "parse_unknown",
      level: "info",
      imei: event.imei,
      freeText: event.freeText ?? null,
      key,
    });
    const messages = buildReply({ body: "Unknown command. Try !help", env });
    await trySendReplyWithCheckpoint(env, key, event.imei, messages);
    await markCompleted(env, key);
    return;
  }

  let result: CommandResult;
  try {
    result = await orchestrate(command, { env, imei: event.imei, lat, lon, idemKey: key });
    log({
      event: "orchestrate_ok",
      level: "info",
      imei: event.imei,
      cmd: command.type,
      key,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({
      event: "orchestrate_error",
      level: "error",
      imei: event.imei,
      cmd: command.type,
      error: msg,
      key,
    });
    await markFailed(env, key, msg);
    const errMessages = buildReply({ body: `Error: ${msg.slice(0, 80)}`, env });
    // Still try to deliver the error reply to the user, but don't mark
    // completed — replay will retry orchestrate.
    await trySendReplyWithCheckpoint(env, key, event.imei, errMessages);
    return;
  }

  // The cost suffix is opt-in; only read the ledger when the flag is on, to
  // save the KV round-trip on every reply. The orchestrator already updated
  // the ledger for !ping et al, so this read sees the just-written total.
  const costUsdMtd = appendCostSuffix(env) ? (await monthlyTotals(env)).usd_cost : undefined;

  const messages = buildReply({
    body: result.body,
    costUsdMtd,
    env,
  });

  const replyOk = await trySendReplyWithCheckpoint(env, key, event.imei, messages);
  if (replyOk) {
    await markCompleted(env, key);
  }
}

/**
 * Wrap the IPC Inbound send in a withCheckpoint so a webhook replay after a
 * successful send (but before markCompleted reached KV) doesn't double-send to
 * the device. Takes a pre-built page array (1 or 2 entries) from buildReply.
 * Returns true on first-call success or cache-hit replay; false on send failure.
 */
async function trySendReplyWithCheckpoint(
  env: Env,
  idemKey: string,
  imei: string,
  messages: string[],
): Promise<boolean> {
  try {
    await withCheckpoint(env, idemKey, "reply", async () => {
      await sendReply(imei, messages, env);
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
 * Message codes that describe a tracking session: 0 position report,
 * 10 Start Track, 11 Track Interval, 12 Stop Track. Free text (3) and SOS (4)
 * are deliberately excluded — they carry no tracking telemetry.
 */
const TRACKING_MESSAGE_CODES = new Set([0, 10, 11, 12]);

function isGarminEnvelope(body: unknown): body is GarminEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { Version?: unknown }).Version === "string" &&
    Array.isArray((body as { Events?: unknown }).Events)
  );
}
