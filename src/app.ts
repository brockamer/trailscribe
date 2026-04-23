import { Hono } from "hono";
import type { Env } from "./env.js";
import { imeiAllowSet } from "./env.js";
import type { GarminEnvelope, GarminEvent } from "./core/types.js";
import { idempotencyKey, IDEMPOTENCY_TTL_SECONDS } from "./core/idempotency.js";
import type { IdempotencyRecord } from "./core/idempotency.js";
import { putJSON } from "./adapters/storage/kv.js";
import { log } from "./adapters/logging/worker-logs.js";

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
   * Phase 0 responsibilities per PRD §4, §5 + plan P0-11:
   *   1. Verify bearer token (static, configured on Garmin Portal Connect).
   *   2. Parse body as Garmin V2 envelope.
   *   3. Per event: verify IMEI allowlist, compute idempotency key, KV check,
   *      KV write on miss (TTL 48h).
   *   4. Always return 200 OK — avoids triggering Garmin's retry cascade on
   *      app-level errors. Observability lives in structured logs.
   *
   * Phase 1 will add: `// TODO: dispatch to orchestrator` → real orchestrate().
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

  log({
    event: "event_received",
    level: "info",
    imei: event.imei,
    messageCode: event.messageCode,
    freeText: event.freeText ?? null,
    key,
    // TODO: dispatch to orchestrator in Phase 1
  });
}

function isGarminEnvelope(body: unknown): body is GarminEnvelope {
  return (
    typeof body === "object" &&
    body !== null &&
    typeof (body as { Version?: unknown }).Version === "string" &&
    Array.isArray((body as { Events?: unknown }).Events)
  );
}
