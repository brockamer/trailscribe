import { describe, test, expect } from "vitest";
import { parseEnv, ipcInboundDryRun, journalLocationPrecision } from "../src/env.js";
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

describe("journalLocationPrecision helper (#223)", () => {
  const precision = (v: string | undefined) =>
    journalLocationPrecision(makeTestEnv({ JOURNAL_LOCATION_PRECISION: v }));

  test("integer 0–6 → that many decimal places", () => {
    expect(precision("0")).toBe(0);
    expect(precision("3")).toBe(3);
    expect(precision("6")).toBe(6);
  });

  test("'omit' (case-insensitive, trimmed) → omit", () => {
    expect(precision("omit")).toBe("omit");
    expect(precision("OMIT")).toBe("omit");
    expect(precision(" omit ")).toBe("omit");
  });

  // parseEnv() is not on the request path, so a missing [vars] entry reaches
  // this helper as undefined. It must fall back to the coarse default, never
  // to full precision.
  test("unset → default 3", () => {
    expect(precision(undefined)).toBe(3);
  });

  test("out-of-range or malformed → default 3", () => {
    for (const bad of ["", "7", "-1", "3.5", "full", "omitt"]) {
      expect(precision(bad)).toBe(3);
    }
  });

  test("parseEnv accepts 0–6 and 'omit', rejects anything else", () => {
    for (const ok of ["0", "3", "6", "omit"]) {
      expect(() => parseEnv(makeTestEnv({ JOURNAL_LOCATION_PRECISION: ok }))).not.toThrow();
    }
    expect(() => parseEnv(makeTestEnv({ JOURNAL_LOCATION_PRECISION: "7" }))).toThrow(
      /JOURNAL_LOCATION_PRECISION/,
    );
  });
});
