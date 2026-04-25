import { Hono } from "hono";
import type { Env } from "./env.js";
import { imeiAllowSet } from "./env.js";
import type { GarminEnvelope, GarminEvent } from "./core/types.js";
import { idempotencyKey, IDEMPOTENCY_TTL_SECONDS } from "./core/idempotency.js";
import type { IdempotencyRecord } from "./core/idempotency.js";
import { putJSON } from "./adapters/storage/kv.js";
import { log } from "./adapters/logging/worker-logs.js";
import { parseCommand } from "./core/grammar.js";
import { orchestrate } from "./core/orchestrator.js";
import { sendReply } from "./adapters/outbound/garmin-ipc-inbound.js";

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
    }),
  );

  /**
   * Garmin IPC Outbound receiver.
   *
   * Per PRD §4, §5 + plan P1-01:
   *   1. Verify bearer token (static, configured on Garmin Portal Connect).
   *   2. Parse body as Garmin V2 envelope.
   *   3. Per event: verify IMEI allowlist; compute idempotency key;
   *      short-circuit on replay; write `received` record on first delivery.
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
    const auth = c.req.header("authorization");
    const expected = `Bearer ${c.env.GARMIN_INBOUND_TOKEN}`;
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
  const kvKey = `idem:${key}`;

  const existing = await env.TS_IDEMPOTENCY.get(kvKey);
  if (existing !== null) {
    log({
      event: "idempotent_replay",
      level: "info",
      imei: event.imei,
      messageCode: event.messageCode,
      key,
    });
    return;
  }

  const record: IdempotencyRecord = {
    status: "received",
    receivedAt: Date.now(),
  };
  await putJSON(env.TS_IDEMPOTENCY, kvKey, record, {
    expirationTtl: IDEMPOTENCY_TTL_SECONDS,
  });

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

  const command = parseCommand(event.freeText ?? "");
  if (!command) {
    log({
      event: "parse_unknown",
      level: "info",
      imei: event.imei,
      freeText: event.freeText ?? null,
      key,
    });
    await trySendReply(event.imei, "Unknown command. Try !help", env);
    return;
  }

  let body: string;
  try {
    const result = await orchestrate(command, { env, imei: event.imei, lat, lon });
    body = result.body;
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
    body = `Error: ${msg.slice(0, 80)}`;
  }

  const replyOk = await trySendReply(event.imei, body, env);
  if (replyOk) {
    const completed: IdempotencyRecord = {
      status: "completed",
      receivedAt: record.receivedAt,
      completedAt: Date.now(),
    };
    await putJSON(env.TS_IDEMPOTENCY, kvKey, completed, {
      expirationTtl: IDEMPOTENCY_TTL_SECONDS,
    });
  }
}

async function trySendReply(imei: string, message: string, env: Env): Promise<boolean> {
  try {
    await sendReply(imei, [message], env);
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
