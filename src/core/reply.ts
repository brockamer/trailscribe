import type { Env } from "../env.js";
import { appendCostSuffix } from "../env.js";

/**
 * Iridium SBD hard limit per message — Garmin IPC Inbound returns 422
 * `InvalidMessageError` on overage (PRD §3, Garmin IPC Inbound v3.1.1).
 */
export const SMS_MAX = 160;

/** Page marker: 5 chars, glued to the end of each page (no leading space). */
const MARKER_LEN = 5;

/**
 * Glued to every journal URL (#249). GitHub Pages builds the site 30–143 s
 * after the commit, so a link tapped the moment the reply lands can 404.
 */
export const JOURNAL_LIVE_HINT = " (live in ~1 min)";

export interface BuildReplyArgs {
  body: string;
  /**
   * A just-committed journal post URL. Kept whole in one page with
   * {@link JOURNAL_LIVE_HINT}; only `body` is ever truncated around it.
   */
  journalUrl?: string;
  /**
   * Other links (#261), e.g. the `!where` Maps and MapShare URLs. Atomic like
   * `journalUrl`, and placed after it.
   */
  links?: string[];
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
 * This function adds no map links of its own; location stays in the journal
 * post's YAML frontmatter (see `src/adapters/publish/github-pages.ts`). It
 * places only the links the caller passes — `journalUrl` and `links` — via
 * {@link buildLinkReply}.
 *
 * Throws if any output page exceeds {@link SMS_MAX} — that's a caller bug
 * (logic mistake here, not a runtime input error).
 */
export function buildReply({
  body,
  journalUrl,
  links = [],
  costUsdMtd,
  env,
}: BuildReplyArgs): string[] {
  const tail =
    appendCostSuffix(env) && typeof costUsdMtd === "number" ? ` · $${costUsdMtd.toFixed(2)}` : "";

  const allLinks = journalUrl !== undefined ? [journalUrl + JOURNAL_LIVE_HINT, ...links] : links;
  if (allLinks.length > 0) return buildLinkReply(body, allLinks, tail);

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

/**
 * Reply that carries links (#249, #261). Each link is atomic: a URL cut across
 * two pages, or with a `(1/2)` marker glued inside it, cannot be tapped. One
 * page when everything fits; otherwise page 1 is the (possibly truncated) body
 * and page 2 is the links and cost suffix. Worst cases for page 2: a 117-char
 * journal URL + 17 hint + 8 suffix + 5 marker = 147; `!where` with an 86-char
 * Maps URL + 1 + 36-char MapShare URL + 8 + 5 = 136.
 *
 * A link that does not fit on page 2 with the ones before it is dropped whole,
 * never split. Only a per-tenant `MAPSHARE_KEY` far longer than `trailscribe`
 * can trigger that; every current caller's first link fits.
 */
function buildLinkReply(body: string, links: string[], tail: string): string[] {
  const single = `${body}\n${links.join(" ")}${tail}`;
  if (single.length <= SMS_MAX) return [single];

  const page1 = body.slice(0, SMS_MAX - MARKER_LEN) + "(1/2)";
  const linkLine = fitLinks(links, SMS_MAX - MARKER_LEN - tail.length);
  const page2 = (linkLine === "" ? tail.trimStart() : linkLine + tail) + "(2/2)";
  assertWithinLimit(page1);
  assertWithinLimit(page2);
  return [page1, page2];
}

/** Space-joins `links` in order, stopping before the first one that would pass `budget`. */
function fitLinks(links: string[], budget: number): string {
  let line = "";
  for (const link of links) {
    const next = line === "" ? link : `${line} ${link}`;
    if (next.length > budget) break;
    line = next;
  }
  return line;
}

function assertWithinLimit(s: string): void {
  if (s.length > SMS_MAX) {
    throw new Error(`buildReply produced a ${s.length}-char page (limit ${SMS_MAX}). Caller bug.`);
  }
}
