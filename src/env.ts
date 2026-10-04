import { z } from "zod";
import { parseAddressBookJson } from "./core/addressbook.js";

/**
 * Worker `Env` binding shape. Mirrors `wrangler.toml` KV namespaces, vars, and secrets.
 * Every field listed here must have a corresponding `[[kv_namespaces]]`, `[vars]`, or
 * `wrangler secret put` entry.
 */
export interface Env {
  // KV namespaces
  TS_IDEMPOTENCY: KVNamespace;
  TS_LEDGER: KVNamespace;
  TS_CONTEXT: KVNamespace;
  TS_CACHE: KVNamespace;
  TS_TRACKS: KVNamespace;

  // Vars (non-secret)
  TRAILSCRIBE_ENV: string;
  GOOGLE_MAPS_BASE: string;
  MAPSHARE_BASE: string;
  TRACK_LOOKBACK_HOURS: string;
  TRACK_NARRATIVE_BODY_MAX: string;
  LLM_BASE_URL: string;
  LLM_MODEL: string;
  LLM_INPUT_COST_PER_1K: string;
  LLM_OUTPUT_COST_PER_1K: string;
  LLM_PROVIDER_HEADERS_JSON: string;
  APPEND_COST_SUFFIX: string;
  DAILY_TOKEN_BUDGET: string;
  IPC_SCHEMA_VERSION: string;
  IPC_INBOUND_SENDER: string;
  IPC_INBOUND_DRY_RUN: string;
  LOG_TRACK_PAYLOADS: string;
  RESEND_FROM_EMAIL: string;
  RESEND_FROM_NAME: string;
  JOURNAL_POST_PATH_TEMPLATE: string;
  JOURNAL_URL_TEMPLATE: string;
  JOURNAL_BASEURL: string;
  JOURNAL_LOCATION_PRECISION: string;
  IMAGE_PROVIDER: string;
  IMAGE_MODEL: string;
  IMAGE_COST_PER_CALL_USD: string;
  JOURNAL_IMAGE_PATH_TEMPLATE: string;

  // Secrets (Wrangler Secrets)
  GARMIN_INBOUND_TOKEN: string;
  GARMIN_IPC_INBOUND_API_KEY: string;
  GARMIN_IPC_INBOUND_BASE_URL: string;
  IMEI_ALLOWLIST: string;
  LLM_API_KEY: string;
  TODOIST_API_TOKEN: string;
  RESEND_API_KEY: string;
  GITHUB_JOURNAL_TOKEN: string;
  GITHUB_JOURNAL_REPO: string;
  GITHUB_JOURNAL_BRANCH: string;
  ADDRESS_BOOK_JSON: string;
  IMAGE_API_KEY: string;
  MAPSHARE_KEY: string;
  MAPSHARE_PASSWORD: string;
}

/**
 * Zod schema for runtime validation of the Env binding.
 * `/garmin/ipc` runs `checkEnv(env)` on every authenticated request (#212);
 * `parseEnv(env)` is the throwing form. Both reject missing/invalid keys.
 *
 * KV namespaces are validated structurally (have `get`/`put` methods) rather than
 * by instanceof check — keeps the schema testable with mock bindings.
 */
const KVNamespaceLike = z.object({
  get: z.function(),
  put: z.function(),
  delete: z.function(),
  list: z.function(),
});

/**
 * Check a secret after trimming surrounding whitespace. The gate must not be
 * stricter than the value's consumer (#212): a trailing newline from a pasted
 * secret that works today must not stop every request.
 */
function trimmed<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (typeof v === "string" ? v.trim() : v), schema);
}

export const EnvSchema = z.object({
  TS_IDEMPOTENCY: KVNamespaceLike,
  TS_LEDGER: KVNamespaceLike,
  TS_CONTEXT: KVNamespaceLike,
  TS_CACHE: KVNamespaceLike,
  TS_TRACKS: KVNamespaceLike,

  TRAILSCRIBE_ENV: z.string().min(1),
  GOOGLE_MAPS_BASE: z.string().url(),
  MAPSHARE_BASE: z.string(),
  TRACK_LOOKBACK_HOURS: z.string(),
  TRACK_NARRATIVE_BODY_MAX: z.string(),
  LLM_BASE_URL: z.string().url(),
  LLM_MODEL: z.string().min(1),
  LLM_INPUT_COST_PER_1K: z.string(),
  LLM_OUTPUT_COST_PER_1K: z.string(),
  // Empty string = no headers (consumers must check before JSON.parse).
  LLM_PROVIDER_HEADERS_JSON: z.string(),
  APPEND_COST_SUFFIX: z.string(),
  DAILY_TOKEN_BUDGET: z.string(),
  IPC_SCHEMA_VERSION: z.enum(["2", "3", "4"]),
  IPC_INBOUND_SENDER: z.string().min(1),
  IPC_INBOUND_DRY_RUN: z.string(),
  LOG_TRACK_PAYLOADS: z.string(),
  RESEND_FROM_EMAIL: z.string().email(),
  RESEND_FROM_NAME: z.string().min(1),
  JOURNAL_POST_PATH_TEMPLATE: z.string().min(1),
  JOURNAL_URL_TEMPLATE: z.string().min(1),
  // Path prefix prepended to rendered image URLs in markdown so Jekyll project
  // pages (served under `/<repo-name>/`) resolve correctly. Empty string for
  // sites at the domain root.
  JOURNAL_BASEURL: z.string(),
  // Decimal places for coordinates in published posts, or "omit" (#223).
  JOURNAL_LOCATION_PRECISION: z.string().regex(/^([0-6]|omit)$/i, "0–6 or 'omit'"),
  IMAGE_PROVIDER: z.enum(["replicate"]),
  IMAGE_MODEL: z.string().min(1),
  IMAGE_COST_PER_CALL_USD: z.string(),
  JOURNAL_IMAGE_PATH_TEMPLATE: z.string().min(1),

  GARMIN_INBOUND_TOKEN: z.string().min(16),
  GARMIN_IPC_INBOUND_API_KEY: z.string().min(8),
  GARMIN_IPC_INBOUND_BASE_URL: z.string().url(),
  // Trim each entry first, exactly as imeiAllowSet() does: the gate must not be
  // stricter than its consumer, or a value that works today (a trailing
  // newline from a pasted secret) would stop every request (#212).
  IMEI_ALLOWLIST: z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((s) => s.trim())
            .join(",")
        : v,
    z.string().regex(/^\d{15}(,\d{15})*$/, "comma-separated 15-digit IMEIs"),
  ),
  LLM_API_KEY: z.string().min(8),
  TODOIST_API_TOKEN: z.string().min(8),
  RESEND_API_KEY: z.string().min(8),
  GITHUB_JOURNAL_TOKEN: z.string().min(8),
  GITHUB_JOURNAL_REPO: trimmed(z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo format")),
  GITHUB_JOURNAL_BRANCH: z.string().min(1),
  // Empty string = no aliases configured (resolve() will throw on lookup).
  // Non-empty must parse via parseAddressBookJson — single source of truth for
  // shape + email-shape validation, shared with src/core/addressbook.ts.
  ADDRESS_BOOK_JSON: z.string().superRefine((s, ctx) => {
    try {
      parseAddressBookJson(s);
    } catch (e) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }),
  IMAGE_API_KEY: z.string().min(8),
  MAPSHARE_KEY: z.string().min(1),
  // MapShare access code (Basic Auth password). Empty string allowed for
  // unprotected feeds; non-empty value triggers `Authorization: Basic` header
  // construction in fetchMapShareKml. Set via Garmin Explore portal → MapShare
  // → Access Code.
  MAPSHARE_PASSWORD: z.string(),
});

/** One failed env check, named by variable and rule only — never by value (#212). */
export interface EnvProblem {
  /** Variable name (or binding path, e.g. `TS_CACHE.get`). */
  variable: string;
  /** zod rule (`regex`, `url`, `invalid_type`, `too_small`, …) or `forbidden_in_production`. */
  rule: string;
}

export type EnvCheck =
  | { ok: true; env: Env }
  | {
      ok: false;
      /** Safe to log: names only. */
      problems: EnvProblem[];
      /** zod's readable messages. Not safe to log: an enum message echoes the received value. */
      detail: string;
    };

/**
 * Validate the Env without throwing. Reports every problem at once, including
 * the production dry-run rule, so one fix pass covers them all.
 */
export function checkEnv(env: unknown): EnvCheck {
  const problems: EnvProblem[] = [];
  const details: string[] = [];

  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const variable = issue.path.join(".") || "(env)";
      const rule =
        "validation" in issue && typeof issue.validation === "string"
          ? issue.validation
          : issue.code;
      problems.push({ variable, rule });
      details.push(`  - ${variable}: ${issue.message}`);
    }
  }

  // Prod must never silently mute device sends. Dry-run is a staging/dev-only
  // safety rail; in prod it would hide real delivery failures. Read raw so it
  // is reported even when the schema also failed.
  const raw = (env ?? {}) as Record<string, unknown>;
  if (
    raw.TRAILSCRIBE_ENV === "production" &&
    typeof raw.IPC_INBOUND_DRY_RUN === "string" &&
    raw.IPC_INBOUND_DRY_RUN.toLowerCase() === "true"
  ) {
    problems.push({ variable: "IPC_INBOUND_DRY_RUN", rule: "forbidden_in_production" });
    details.push("  - IPC_INBOUND_DRY_RUN must not be 'true' when TRAILSCRIBE_ENV=production");
  }

  if (problems.length > 0) {
    return { ok: false, problems, detail: `Invalid Worker Env bindings:\n${details.join("\n")}` };
  }
  // Return the input, not zod's output: zod rebuilds each object (dropping
  // keys it does not know, e.g. KV `getWithMetadata`) and wraps each function,
  // so a KV method would run with the wrong `this` — workerd's bindings throw
  // "Illegal invocation" on that.
  return { ok: true, env: env as Env };
}

/**
 * Validate and return the typed Env. Throws with a readable message on failure.
 * The message may contain values; never log it — log `checkEnv().problems`.
 */
export function parseEnv(env: unknown): Env {
  const result = checkEnv(env);
  if (!result.ok) throw new Error(result.detail);
  return result.env;
}

/** Parse the comma-separated IMEI allowlist into a Set for O(1) lookup. */
export function imeiAllowSet(env: Env): Set<string> {
  return new Set(env.IMEI_ALLOWLIST.split(",").map((s) => s.trim()));
}

/**
 * The one IMEI an IPC Outbound event came from, or `null` when none of its
 * IMEIs is allowlisted. Since Outbound v2.0.9 a message sent via Internet from
 * a multi-device account carries every account IMEI, comma-separated; the
 * first allowlisted one is taken as the sender and reply recipient (decision
 * on #282). The allowlist is defense in depth behind the bearer token, so one
 * match is enough.
 */
export function resolveSenderImei(imei: string, allow: Set<string>): string | null {
  for (const candidate of imei.split(",")) {
    const trimmed = candidate.trim();
    if (allow.has(trimmed)) return trimmed;
  }
  return null;
}

/** Parse the boolean-ish APPEND_COST_SUFFIX var. */
export function appendCostSuffix(env: Env): boolean {
  return env.APPEND_COST_SUFFIX.toLowerCase() === "true";
}

/**
 * Parse IPC_INBOUND_DRY_RUN. When true, `sendReply` short-circuits without
 * calling Garmin IPC Inbound. Used to exercise the full pipeline (parse →
 * orchestrate → narrative → publish → ledger) in staging without delivering
 * real SMS to the operator's device. Forbidden in production (see checkEnv).
 */
export function ipcInboundDryRun(env: Env): boolean {
  return env.IPC_INBOUND_DRY_RUN.toLowerCase() === "true";
}

/**
 * Parse LOG_TRACK_PAYLOADS. When true, `non_free_text` log lines for tracking
 * events (messageCode 0/10/11/12) carry the full event JSON so a fixture can
 * be reconstructed from logs during a real device session. Default off; the
 * silent-drop policy is unchanged either way.
 */
export function logTrackPayloads(env: Env): boolean {
  return env.LOG_TRACK_PAYLOADS.toLowerCase() === "true";
}

/** Decimal places for published coordinates, or "omit" to publish the place name only. */
export type LocationPrecision = number | "omit";

const DEFAULT_LOCATION_PRECISION = 3;

/**
 * Parse JOURNAL_LOCATION_PRECISION (#223). Unset or malformed falls back to 3
 * decimal places (~100 m) — never to full precision.
 */
export function journalLocationPrecision(env: Env): LocationPrecision {
  // The /garmin/ipc gate (#212) stops a request with a missing [vars] entry, but
  // other callers can still pass undefined.
  const raw = (env.JOURNAL_LOCATION_PRECISION ?? "").trim().toLowerCase();
  if (raw === "omit") return "omit";
  if (/^[0-6]$/.test(raw)) return Number(raw);
  return DEFAULT_LOCATION_PRECISION;
}

/** Parse DAILY_TOKEN_BUDGET (0 = unlimited). */
export function dailyTokenBudget(env: Env): number {
  const n = Number.parseInt(env.DAILY_TOKEN_BUDGET, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
