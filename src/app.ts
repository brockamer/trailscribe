import { Hono } from "hono";
import type { Env } from "./env.js";
import { appendCostSuffix, imeiAllowSet, ipcInboundDryRun } from "./env.js";
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

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      log({ event: "bad_json", level: "warn" });
      return c.text("ok", 200);
    }

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
    if (event.messageCode === 4) {
      log({ event: "sos_received_ignored", level: "warn", imei: event.imei, key });
    } else {
      log({
        event: "non_free_text",
        level: "info",
        imei: event.imei,
        messageCode: event.messageCode,
        key,
      });
    }
    return;
  }

  const point = event.point;
  const hasFix =
    !!point &&
    point.gpsFix !== 0 &&
    !(point.latitude === 0 && point.longitude === 0);
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
  const costUsdMtd = appendCostSuffix(env)
    ? (await monthlyTotals(env)).usd_cost
    : undefined;

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

function isGarminEnvelope(body: unknown): body is GarminEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { Version?: unknown }).Version === "string" &&
    Array.isArray((body as { Events?: unknown }).Events)
  );
}
