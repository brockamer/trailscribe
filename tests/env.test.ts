import { describe, test, expect } from "vitest";
import { checkEnv, parseEnv, ipcInboundDryRun, journalLocationPrecision } from "../src/env.js";
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

describe("checkEnv — problems by variable and rule, never by value (#212)", () => {
  test("valid env → ok with the typed env", () => {
    const env = makeTestEnv();
    const result = checkEnv(env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.IMEI_ALLOWLIST).toBe(env.IMEI_ALLOWLIST);
  });

  test("returns the bindings it was given, not zod's rebuilt copies", () => {
    const env = makeTestEnv();
    const result = checkEnv(env);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.env.TS_CACHE).toBe(env.TS_CACHE);
    expect(parseEnv(env).TS_IDEMPOTENCY).toBe(env.TS_IDEMPOTENCY);
  });

  test("IMEI_ALLOWLIST tolerates exactly the whitespace imeiAllowSet trims", () => {
    for (const ok of ["123456789012345\n", " 123456789012345 , 123456789012346\r\n"]) {
      expect(checkEnv(makeTestEnv({ IMEI_ALLOWLIST: ok })).ok).toBe(true);
    }
  });

  test("GITHUB_JOURNAL_REPO tolerates surrounding whitespace, not a bad shape", () => {
    // The REST publish path builds a URL, which drops a trailing newline, so a
    // pasted value works today; the gate must not reject it (#212).
    expect(checkEnv(makeTestEnv({ GITHUB_JOURNAL_REPO: "owner/repo\n" })).ok).toBe(true);
    const bad = checkEnv(makeTestEnv({ GITHUB_JOURNAL_REPO: "owner repo" }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems).toEqual([{ variable: "GITHUB_JOURNAL_REPO", rule: "regex" }]);
  });

  test("malformed IMEI_ALLOWLIST → one problem naming the variable", () => {
    for (const bad of [
      "",
      "12345678901234",
      "123456789012345,",
      "123456789012345;123456789012346",
      "1234567 89012345",
    ]) {
      const result = checkEnv(makeTestEnv({ IMEI_ALLOWLIST: bad }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.problems).toEqual([{ variable: "IMEI_ALLOWLIST", rule: "regex" }]);
      }
    }
  });

  test("missing variable → rule invalid_type", () => {
    const env = makeTestEnv() as unknown as Record<string, unknown>;
    delete env.GARMIN_IPC_INBOUND_API_KEY;
    const result = checkEnv(env);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([
        { variable: "GARMIN_IPC_INBOUND_API_KEY", rule: "invalid_type" },
      ]);
    }
  });

  test("production dry-run is reported alongside schema problems, not instead of them", () => {
    const result = checkEnv(
      makeTestEnv({
        TRAILSCRIBE_ENV: "production",
        IPC_INBOUND_DRY_RUN: "TRUE",
        IMEI_ALLOWLIST: "",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems).toEqual([
        { variable: "IMEI_ALLOWLIST", rule: "regex" },
        { variable: "IPC_INBOUND_DRY_RUN", rule: "forbidden_in_production" },
      ]);
    }
  });

  test("a non-object env does not throw", () => {
    const result = checkEnv(undefined);
    expect(result.ok).toBe(false);
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

  // The /garmin/ipc gate (#212) stops a request with a missing [vars] entry,
  // but other routes and direct callers can still pass undefined. It must
  // fall back to the coarse default, never to full precision.
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
