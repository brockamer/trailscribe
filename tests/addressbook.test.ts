import { describe, test, expect } from "vitest";
import {
  parseAddressBookJson,
  resolve,
  isValidEmail,
} from "../src/core/addressbook.js";
import { parseEnv } from "../src/env.js";
import { makeTestEnv } from "./helpers/env.js";

describe("isValidEmail", () => {
  test("accepts well-formed addresses", () => {
    expect(isValidEmail("a@b.co")).toBe(true);
    expect(isValidEmail("first.last+tag@sub.example.com")).toBe(true);
    expect(isValidEmail("  spaces@trimmed.com  ")).toBe(true);
  });

  test("rejects malformed addresses", () => {
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("noat.example.com")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
    expect(isValidEmail("@b.com")).toBe(false);
    expect(isValidEmail("a@.com")).toBe(false);
  });
});

describe("parseAddressBookJson — empty / no aliases configured", () => {
  test("empty string returns an empty alias map (valid)", () => {
    expect(parseAddressBookJson("")).toEqual({ aliases: {} });
  });

  test("whitespace-only is treated as empty", () => {
    expect(parseAddressBookJson("   \n  ")).toEqual({ aliases: {} });
  });
});

describe("parseAddressBookJson — happy path", () => {
  test("parses single-email aliases", () => {
    const raw = JSON.stringify({
      aliases: { home: "me@home.com", editor: "ed@magazine.com" },
    });
    expect(parseAddressBookJson(raw)).toEqual({
      aliases: { home: "me@home.com", editor: "ed@magazine.com" },
    });
  });

  test("parses comma-separated 'all' alias for !blast", () => {
    const raw = JSON.stringify({ aliases: { all: "a@x.com,b@y.com,c@z.com" } });
    expect(parseAddressBookJson(raw).aliases.all).toBe("a@x.com,b@y.com,c@z.com");
  });
});

describe("parseAddressBookJson — rejection paths", () => {
  test("malformed JSON throws", () => {
    expect(() => parseAddressBookJson("{aliases:")).toThrow(/not valid JSON/);
  });

  test("non-object root throws", () => {
    expect(() => parseAddressBookJson('"a string"')).toThrow(/JSON object/);
    expect(() => parseAddressBookJson("[]")).toThrow(/JSON object/);
    expect(() => parseAddressBookJson("null")).toThrow(/JSON object/);
  });

  test("missing aliases key throws", () => {
    expect(() => parseAddressBookJson("{}")).toThrow(/aliases/);
  });

  test("aliases is not an object", () => {
    expect(() => parseAddressBookJson('{"aliases":"home"}')).toThrow(/aliases/);
    expect(() => parseAddressBookJson('{"aliases":[]}')).toThrow(/aliases/);
  });

  test("alias value is non-string", () => {
    expect(() =>
      parseAddressBookJson('{"aliases":{"home":42}}'),
    ).toThrow(/alias 'home'/);
  });

  test("alias value is empty string", () => {
    expect(() =>
      parseAddressBookJson('{"aliases":{"home":""}}'),
    ).toThrow(/alias 'home'/);
  });

  test("alias value contains an invalid email", () => {
    expect(() =>
      parseAddressBookJson('{"aliases":{"home":"not-an-email"}}'),
    ).toThrow(/invalid email/);
  });

  test("comma-list with one bad email rejects the whole alias", () => {
    expect(() =>
      parseAddressBookJson('{"aliases":{"all":"a@x.com,bad,c@z.com"}}'),
    ).toThrow(/invalid email/);
  });
});

describe("resolve — alias lookup", () => {
  test("single-email alias returns a one-element list", () => {
    const env = makeTestEnv({
      ADDRESS_BOOK_JSON: JSON.stringify({ aliases: { home: "me@home.com" } }),
    });
    expect(resolve(env, "home")).toEqual(["me@home.com"]);
  });

  test("'all' alias returns the comma-list as separate addresses", () => {
    const env = makeTestEnv({
      ADDRESS_BOOK_JSON: JSON.stringify({ aliases: { all: "a@x.com,b@y.com,c@z.com" } }),
    });
    expect(resolve(env, "all")).toEqual(["a@x.com", "b@y.com", "c@z.com"]);
  });

  test("unknown alias throws", () => {
    const env = makeTestEnv({
      ADDRESS_BOOK_JSON: JSON.stringify({ aliases: { home: "me@home.com" } }),
    });
    expect(() => resolve(env, "stranger")).toThrow(/unknown alias: stranger/);
  });

  test("empty address book throws on any lookup", () => {
    const env = makeTestEnv({ ADDRESS_BOOK_JSON: "" });
    expect(() => resolve(env, "home")).toThrow(/unknown alias/);
  });
});

describe("env validation — ADDRESS_BOOK_JSON refinement", () => {
  test("empty string is accepted", () => {
    const env = makeTestEnv({ ADDRESS_BOOK_JSON: "" });
    expect(() => parseEnv(env)).not.toThrow();
  });

  test("well-formed JSON is accepted", () => {
    const env = makeTestEnv({
      ADDRESS_BOOK_JSON: JSON.stringify({ aliases: { home: "me@home.com" } }),
    });
    expect(() => parseEnv(env)).not.toThrow();
  });

  test("malformed JSON fails parseEnv", () => {
    const env = makeTestEnv({ ADDRESS_BOOK_JSON: "{not json" });
    expect(() => parseEnv(env)).toThrow(/ADDRESS_BOOK_JSON/);
  });

  test("non-email value fails parseEnv", () => {
    const env = makeTestEnv({
      ADDRESS_BOOK_JSON: JSON.stringify({ aliases: { home: "nope" } }),
    });
    expect(() => parseEnv(env)).toThrow(/ADDRESS_BOOK_JSON/);
  });
});
