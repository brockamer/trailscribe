import type { Env } from "../env.js";

export interface AddressBook {
  aliases: Record<string, string>;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Liberal email-shape check — parity with Resend's expectations, no MX lookup. */
export function isValidEmail(addr: string): boolean {
  return EMAIL_REGEX.test(addr.trim());
}

/**
 * Parse and validate `ADDRESS_BOOK_JSON`. Empty string is valid (no aliases
 * configured yet — `resolve` will throw on lookup). Throws with a readable
 * message on malformed JSON, wrong shape, or non-email values.
 *
 * The "all" key may map to a comma-separated list of emails for `!blast`;
 * other aliases are typically a single email but the same comma syntax works.
 */
export function parseAddressBookJson(raw: string): AddressBook {
  if (raw.trim().length === 0) {
    return { aliases: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`ADDRESS_BOOK_JSON: not valid JSON (${detail})`, { cause: e });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("ADDRESS_BOOK_JSON: must be a JSON object");
  }
  const aliases = (parsed as { aliases?: unknown }).aliases;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    throw new Error("ADDRESS_BOOK_JSON: must have shape { aliases: { name: email } }");
  }

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(aliases as Record<string, unknown>)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`ADDRESS_BOOK_JSON: alias '${name}' must be a non-empty string`);
    }
    const parts = splitAddresses(value);
    if (parts.length === 0) {
      throw new Error(`ADDRESS_BOOK_JSON: alias '${name}' has no addresses`);
    }
    for (const p of parts) {
      if (!isValidEmail(p)) {
        throw new Error(`ADDRESS_BOOK_JSON: alias '${name}' contains invalid email '${p}'`);
      }
    }
    out[name] = value;
  }
  return { aliases: out };
}

/**
 * Resolve an alias to one or more email addresses. Throws on unknown alias.
 * Used by `!share` (P2-10) for a single recipient and `!blast` (P2-11) for
 * the `all` group.
 */
export function resolve(env: Env, alias: string): string[] {
  const book = parseAddressBookJson(env.ADDRESS_BOOK_JSON);
  const value = book.aliases[alias];
  if (value === undefined) {
    throw new Error(`unknown alias: ${alias}`);
  }
  return splitAddresses(value);
}

function splitAddresses(value: string): string[] {
  return value
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
