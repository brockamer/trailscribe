import type { Env } from "../env.js";
import { appendCostSuffix } from "../env.js";

/**
 * Iridium SBD hard limit per message — Garmin IPC Inbound returns 422
 * `InvalidMessageError` on overage (PRD §3, Garmin IPC Inbound v3.1.1).
 */
export const SMS_MAX = 160;

/** Page marker: 5 chars, glued to the end of each page (no leading space). */
const MARKER_LEN = 5;

export interface BuildReplyArgs {
  body: string;
  costUsdMtd?: number;
  env: Env;
}

/**
 * Build a 1- or 2-string reply respecting the 320-char total budget and the
 * 160-char per-SMS hard cap (PRD §3 + plan P1-15).
 *
 * The cost suffix `· $X.XX` is appended to the *last* page when
 * `APPEND_COST_SUFFIX=true` and `costUsdMtd` is provided. On overflow
 * (body + suffix + markers > 320), `body` is truncated; the suffix and
 * markers are preserved (caller's choice to enable cost suffix takes
 * precedence over body completeness).
 *
 * The on-device reply does not include map links — the user is offline in
 * the field and a URL is unusable. Location stays in the journal post's
 * YAML frontmatter (see `src/adapters/publish/github-pages.ts`).
 *
 * Throws if any output page exceeds {@link SMS_MAX} — that's a caller bug
 * (logic mistake here, not a runtime input error).
 */
export function buildReply({ body, costUsdMtd, env }: BuildReplyArgs): string[] {
  const tail =
    appendCostSuffix(env) && typeof costUsdMtd === "number"
      ? ` · $${costUsdMtd.toFixed(2)}`
      : "";

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

  if (page2BodyBudget < 0) {
    throw new Error(
      `buildReply: cost suffix (${tail.length} chars) leaves no room for body on page 2 ` +
        `(SMS_MAX=${SMS_MAX}, marker=${MARKER_LEN}).`,
    );
  }

  const page1 = head + "(1/2)";

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
