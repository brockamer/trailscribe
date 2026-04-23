import { defineConfig } from "vitest/config";

/**
 * Phase 0 test config: plain node pool for pure-logic tests (grammar, env).
 * Phase 1 will add `@cloudflare/vitest-pool-workers` for tests that exercise
 * Worker handlers with bound KV / fetch mocks.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globals: true,
    environment: "node",
  },
});
