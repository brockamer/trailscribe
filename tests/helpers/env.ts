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
    async get(key: string, _options?: unknown) {
      const rec = store.get(key);
      if (!rec) return null;
      if (rec.expires && Date.now() > rec.expires) {
        store.delete(key);
        return null;
      }
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
    OPENAI_MODEL: "gpt-5-mini",
    OPENAI_INPUT_COST_PER_1K: "0.00",
    OPENAI_OUTPUT_COST_PER_1K: "0.00",
    APPEND_COST_SUFFIX: "false",
    DAILY_TOKEN_BUDGET: "50000",
    IPC_SCHEMA_VERSION: "2",
    RESEND_FROM_EMAIL: "trailscribe@resend.dev",
    RESEND_FROM_NAME: "TrailScribe",
    JOURNAL_POST_PATH_TEMPLATE: "content/posts/{yyyy}-{mm}-{dd}-{slug}.md",

    GARMIN_INBOUND_TOKEN: "test-bearer-token-abcdef0123456789",
    GARMIN_IPC_INBOUND_API_KEY: "test-api-key-abcd",
    GARMIN_IPC_INBOUND_BASE_URL: "https://ipcinbound.inreachapp.com/api",
    IMEI_ALLOWLIST: "123456789012345",
    OPENAI_API_KEY: "sk-test-abcd",
    TODOIST_API_TOKEN: "test-todoist",
    RESEND_API_KEY: "re_test_abcd",
    GITHUB_JOURNAL_TOKEN: "ghp_test_abcd",
    GITHUB_JOURNAL_REPO: "brockamer/trailscribe-journal",
    GITHUB_JOURNAL_BRANCH: "main",
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
