import type { Env } from "../env.js";
import { appendCostSuffix } from "../env.js";
import { buildGoogleMapsLink, buildMapShareLink } from "./links.js";

/**
 * Iridium SBD hard limit per message — Garmin IPC Inbound returns 422
 * `InvalidMessageError` on overage (PRD §3, Garmin IPC Inbound v3.1.1).
 */
export const SMS_MAX = 160;

/** Page marker: 5 chars, glued to the end of each page (no leading space). */
const MARKER_LEN = 5;

export interface BuildReplyArgs {
  body: string;
  lat?: number;
  lon?: number;
  costUsdMtd?: number;
  env: Env;
}

/**
 * Build a 1- or 2-string reply respecting the 320-char total budget and the
 * 160-char per-SMS hard cap (PRD §3 + plan P1-15).
 *
 * - Map links are appended to the page that has room when `lat`/`lon` are
 *   defined. When undefined (no GPS fix), no link is emitted — including no
 *   `?q=0,0` placeholder.
 * - The cost suffix `· $X.XX` is appended to the *last* page when
 *   `APPEND_COST_SUFFIX=true` and `costUsdMtd` is provided.
 * - On overflow (body + extras + markers > 320), `body` is truncated; the
 *   extras and markers are preserved (caller's choice to enable cost suffix /
 *   GPS-rich reply takes precedence over body completeness).
 *
 * Throws if any output page exceeds {@link SMS_MAX} — that's a caller bug
 * (logic mistake here, not a runtime input error).
 */
export function buildReply({ body, lat, lon, costUsdMtd, env }: BuildReplyArgs): string[] {
  const hasGps = lat !== undefined && lon !== undefined;
  const mapsLink = hasGps ? buildGoogleMapsLink(lat, lon, env) : "";
  const mapShareLink = hasGps ? buildMapShareLink(lat, lon, env) : "";
  const costSuffix =
    appendCostSuffix(env) && typeof costUsdMtd === "number"
      ? ` · $${costUsdMtd.toFixed(2)}`
      : "";

  // Tail composition: leading-space-separated tokens. Empty pieces drop out.
  const tailPieces = [mapsLink, mapShareLink].filter((s) => s.length > 0);
  const linksTail = tailPieces.length > 0 ? " " + tailPieces.join(" ") : "";
  const tail = linksTail + costSuffix;

  // Single-page case: body + tail fits within 160 with no marker overhead.
  if (body.length + tail.length <= SMS_MAX) {
    const single = body + tail;
    assertWithinLimit(single);
    return [single];
  }

  // Two-page case. Page 1 carries body only; page 2 carries body remainder
  // + tail + marker. Markers are 5 chars each.
  const page1Budget = SMS_MAX - MARKER_LEN; // 155
  const page2BodyBudget = SMS_MAX - MARKER_LEN - tail.length;

  const head = body.slice(0, page1Budget);
  let remainder = body.slice(page1Budget);

  // If the remainder + tail still won't fit on page 2, truncate the remainder
  // (preserving tail per spec).
  if (remainder.length > page2BodyBudget) {
    remainder = remainder.slice(0, Math.max(0, page2BodyBudget));
  }

  // If page2BodyBudget is negative (tail alone > 155), the tail is too big
  // to fit even with markers — that's a configuration bug (e.g. enormous
  // MAPSHARE_BASE URL). Fail loudly so we catch it in tests, not in the
  // field where Garmin would 422 the send.
  if (page2BodyBudget < 0) {
    throw new Error(
      `buildReply: extras tail (${tail.length} chars) leaves no room for body on page 2 ` +
        `(SMS_MAX=${SMS_MAX}, marker=${MARKER_LEN}). Shorten MAPSHARE_BASE or disable links.`,
    );
  }

  const page1 = head + "(1/2)";

  // If remainder is empty and tail starts with a space, strip it — avoids
  // "  https://..." with a leading double-space when body fully fits page 1.
  const page2Body = remainder.length > 0 ? remainder + tail : tail.trimStart();
  const page2 = page2Body + "(2/2)";

  assertWithinLimit(page1);
  assertWithinLimit(page2);
  return [page1, page2];
}

function assertWithinLimit(s: string): void {
  if (s.length > SMS_MAX) {
    throw new Error(
      `buildReply produced a ${s.length}-char page (limit ${SMS_MAX}). Caller bug.`,
    );
  }
}
