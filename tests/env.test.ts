import { describe, test, expect } from "vitest";
import { parseEnv, ipcInboundDryRun } from "../src/env.js";
import { makeTestEnv } from "./helpers/env.js";

describe("parseEnv — IPC_INBOUND_DRY_RUN production guard", () => {
  test("throws when TRAILSCRIBE_ENV=production AND IPC_INBOUND_DRY_RUN=true", () => {
    const bad = makeTestEnv({
      TRAILSCRIBE_ENV: "production",
      IPC_INBOUND_DRY_RUN: "true",
    });
    expect(() => parseEnv(bad)).toThrow(/IPC_INBOUND_DRY_RUN must not be 'true'/);
  });

  test("allows TRAILSCRIBE_ENV=production with IPC_INBOUND_DRY_RUN=false", () => {
    const ok = makeTestEnv({
      TRAILSCRIBE_ENV: "production",
      IPC_INBOUND_DRY_RUN: "false",
    });
    expect(() => parseEnv(ok)).not.toThrow();
  });

  test("allows IPC_INBOUND_DRY_RUN=true on staging (and any non-production env)", () => {
    for (const envName of ["staging", "development", "test"]) {
      const ok = makeTestEnv({
        TRAILSCRIBE_ENV: envName,
        IPC_INBOUND_DRY_RUN: "true",
      });
      expect(() => parseEnv(ok)).not.toThrow();
    }
  });
});

describe("ipcInboundDryRun helper", () => {
  test("returns true for 'true' (case-insensitive), false otherwise", () => {
    expect(ipcInboundDryRun(makeTestEnv({ IPC_INBOUND_DRY_RUN: "true" }))).toBe(true);
    expect(ipcInboundDryRun(makeTestEnv({ IPC_INBOUND_DRY_RUN: "TRUE" }))).toBe(true);
    expect(ipcInboundDryRun(makeTestEnv({ IPC_INBOUND_DRY_RUN: "True" }))).toBe(true);
    expect(ipcInboundDryRun(makeTestEnv({ IPC_INBOUND_DRY_RUN: "false" }))).toBe(false);
    expect(ipcInboundDryRun(makeTestEnv({ IPC_INBOUND_DRY_RUN: "" }))).toBe(false);
    expect(ipcInboundDryRun(makeTestEnv({ IPC_INBOUND_DRY_RUN: "yes" }))).toBe(false);
  });
});
