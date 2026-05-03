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

  // Vars (non-secret)
  TRAILSCRIBE_ENV: string;
  GOOGLE_MAPS_BASE: string;
  MAPSHARE_BASE: string;
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
}

/**
 * Zod schema for runtime validation of the Env binding.
 * Call `parseEnv(env)` once at the start of each request to assert all required
 * bindings are present. Throws on missing/invalid keys with a clear message.
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

export const EnvSchema = z.object({
  TS_IDEMPOTENCY: KVNamespaceLike,
  TS_LEDGER: KVNamespaceLike,
  TS_CONTEXT: KVNamespaceLike,
  TS_CACHE: KVNamespaceLike,

  TRAILSCRIBE_ENV: z.string().min(1),
  GOOGLE_MAPS_BASE: z.string().url(),
  MAPSHARE_BASE: z.string(),
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
  IMAGE_PROVIDER: z.enum(["replicate"]),
  IMAGE_MODEL: z.string().min(1),
  IMAGE_COST_PER_CALL_USD: z.string(),
  JOURNAL_IMAGE_PATH_TEMPLATE: z.string().min(1),

  GARMIN_INBOUND_TOKEN: z.string().min(16),
  GARMIN_IPC_INBOUND_API_KEY: z.string().min(8),
  GARMIN_IPC_INBOUND_BASE_URL: z.string().url(),
  IMEI_ALLOWLIST: z.string().regex(/^\d{15}(,\d{15})*$/, "comma-separated 15-digit IMEIs"),
  LLM_API_KEY: z.string().min(8),
  TODOIST_API_TOKEN: z.string().min(8),
  RESEND_API_KEY: z.string().min(8),
  GITHUB_JOURNAL_TOKEN: z.string().min(8),
  GITHUB_JOURNAL_REPO: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/repo format"),
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
});

/**
 * Validate and return the typed Env. Throws with a readable message on failure.
 * Call once per request (cheap — zod is fast), near the top of the handler.
 */
export function parseEnv(env: unknown): Env {
  const result = EnvSchema.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid Worker Env bindings:\n${issues}`);
  }
  const parsed = result.data as Env;
  // Prod must never silently mute device sends. Dry-run is a staging/dev-only
  // safety rail; in prod it would hide real delivery failures.
  if (parsed.TRAILSCRIBE_ENV === "production" && ipcInboundDryRun(parsed)) {
    throw new Error(
      "Invalid Worker Env: IPC_INBOUND_DRY_RUN must not be 'true' when TRAILSCRIBE_ENV=production",
    );
  }
  return parsed;
}

/** Parse the comma-separated IMEI allowlist into a Set for O(1) lookup. */
export function imeiAllowSet(env: Env): Set<string> {
  return new Set(env.IMEI_ALLOWLIST.split(",").map((s) => s.trim()));
}

/** Parse the boolean-ish APPEND_COST_SUFFIX var. */
export function appendCostSuffix(env: Env): boolean {
  return env.APPEND_COST_SUFFIX.toLowerCase() === "true";
}

/**
 * Parse IPC_INBOUND_DRY_RUN. When true, `sendReply` short-circuits without
 * calling Garmin IPC Inbound. Used to exercise the full pipeline (parse →
 * orchestrate → narrative → publish → ledger) in staging without delivering
 * real SMS to the operator's device. Forbidden in production (see parseEnv).
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

/** Parse DAILY_TOKEN_BUDGET (0 = unlimited). */
export function dailyTokenBudget(env: Env): number {
  const n = Number.parseInt(env.DAILY_TOKEN_BUDGET, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
