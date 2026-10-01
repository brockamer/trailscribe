/**
 * Mean solar time from longitude — a zero-dependency approximation of local
 * time of day. One derivation grounds both the image prompt's lighting and the
 * narrative's time of day, so a bare post's text and picture agree (#240).
 *
 * Deliberately NOT civil time: there is no timezone database in this Worker
 * and adding one would need PRD justification. Mean solar time ignores
 * political timezone boundaries and DST, so it can differ from the clock on
 * the operator's wrist by an hour or more. That is acceptable for its only
 * purpose — telling the models roughly where the sun is.
 */
export function approximateLocalTime(
  timeStampMs: number,
  lon: number,
): { text: string; isNight: boolean } {
  const d = new Date(timeStampMs + (lon / 15) * 3_600_000);
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  const band =
    hh < 5
      ? "night"
      : hh < 8
        ? "early morning"
        : hh < 11
          ? "morning"
          : hh < 14
            ? "midday"
            : hh < 17
              ? "afternoon"
              : hh < 20
                ? "evening"
                : "night";
  return {
    text: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} — ${band}`,
    isNight: band === "night",
  };
}
