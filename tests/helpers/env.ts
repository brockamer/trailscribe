import type { Env } from "../../src/env.js";

interface MemKV extends KVNamespace {
  _size: () => number;
  _keys: () => string[];
  _has: (key: string) => boolean;
}

/**
 * Minimal in-memory KV mock that implements the slice of KVNamespace the app
 * actually uses (get/put/delete/list). TTL is honored via a per-key expiry.
 * Exposes `_size` / `_keys` / `_has` for test assertions.
 */
export function makeMemKV(): MemKV {
  const store = new Map<string, { value: string; expires?: number }>();

  const ns = {
    async get(key: string, options?: unknown) {
      const rec = store.get(key);
      if (!rec) return null;
      if (rec.expires && Date.now() > rec.expires) {
        store.delete(key);
        return null;
      }
      // Mirror Cloudflare KV's get(key, "json") parse-on-read behavior.
      const type =
        typeof options === "string" ? options : (options as { type?: string } | undefined)?.type;
      if (type === "json") return JSON.parse(rec.value);
      return rec.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      const expires = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined;
      store.set(key, { value: String(value), expires });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return {
        keys: Array.from(store.keys()).map((name) => ({ name })),
        list_complete: true,
      };
    },
    async getWithMetadata(key: string) {
      const v = await ns.get(key);
      return { value: v, metadata: null };
    },
    _size: () => store.size,
    _keys: () => Array.from(store.keys()),
    _has: (key: string) => store.has(key),
  };

  return ns as unknown as MemKV;
}

/** Build a fully populated Env for tests. */
export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  const base: Env = {
    TS_IDEMPOTENCY: makeMemKV(),
    TS_LEDGER: makeMemKV(),
    TS_CONTEXT: makeMemKV(),
    TS_CACHE: makeMemKV(),

    TRAILSCRIBE_ENV: "test",
    GOOGLE_MAPS_BASE: "https://www.google.com/maps/search/?api=1&query=",
    MAPSHARE_BASE: "",
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
    LLM_MODEL: "anthropic/claude-sonnet-4-6",
    LLM_INPUT_COST_PER_1K: "0.00",
    LLM_OUTPUT_COST_PER_1K: "0.00",
    LLM_PROVIDER_HEADERS_JSON: "",
    APPEND_COST_SUFFIX: "false",
    DAILY_TOKEN_BUDGET: "50000",
    IPC_SCHEMA_VERSION: "2",
    IPC_INBOUND_SENDER: "trailscribe@resend.dev",
    IPC_INBOUND_DRY_RUN: "false",
    RESEND_FROM_EMAIL: "trailscribe@resend.dev",
    RESEND_FROM_NAME: "TrailScribe",
    JOURNAL_POST_PATH_TEMPLATE: "_posts/{yyyy}-{mm}-{dd}-{slug}.md",
    JOURNAL_URL_TEMPLATE: "https://brockamer.github.io/trailscribe-journal/{yyyy}/{mm}/{dd}/{slug}.html",
    JOURNAL_BASEURL: "/trailscribe-journal",
    IMAGE_PROVIDER: "replicate",
    IMAGE_MODEL: "black-forest-labs/flux-schnell",
    IMAGE_COST_PER_CALL_USD: "0.003",
    JOURNAL_IMAGE_PATH_TEMPLATE: "assets/images/{yyyy}-{mm}-{dd}-{slug}.{ext}",

    GARMIN_INBOUND_TOKEN: "test-bearer-token-abcdef0123456789",
    GARMIN_IPC_INBOUND_API_KEY: "test-api-key-abcd",
    GARMIN_IPC_INBOUND_BASE_URL: "https://ipcinbound.inreachapp.com/api",
    IMEI_ALLOWLIST: "123456789012345",
    LLM_API_KEY: "sk-test-abcd",
    TODOIST_API_TOKEN: "test-todoist",
    RESEND_API_KEY: "re_test_abcd",
    GITHUB_JOURNAL_TOKEN: "ghp_test_abcd",
    GITHUB_JOURNAL_REPO: "brockamer/trailscribe-journal",
    GITHUB_JOURNAL_BRANCH: "main",
    ADDRESS_BOOK_JSON: "",
    IMAGE_API_KEY: "test-image-api-key",
  };
  return { ...base, ...overrides };
}

/** Read the memKV's internal size (test-only). */
export function kvSize(ns: KVNamespace): number {
  return (ns as unknown as MemKV)._size();
}

/** Read the memKV's current key list (test-only). */
export function kvKeys(ns: KVNamespace): string[] {
  return (ns as unknown as MemKV)._keys();
}
