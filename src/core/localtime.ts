/**
 * The civil-time facts this Worker can know for a position, all from the
 * Open-Meteo call every `!post`/`!postimg` already makes (`timezone=auto`).
 * `sunrise`/`sunset` are local `"HH:MM"` for the cached day.
 */
export interface CivilTimeInfo {
  utcOffsetSeconds: number;
  sunrise?: string;
  sunset?: string;
}

/**
 * Local time of day for a message — one derivation grounds both the image
 * prompt's lighting and the narrative's time of day, so a bare post's text and
 * picture agree (#240).
 *
 * With `civil` (the DST-aware UTC offset Open-Meteo returns) the text is the
 * clock time the operator's watch shows, e.g. `"03:28 — night"` (#274). There is
 * still no timezone database in this Worker; the offset comes from the weather
 * call. Night is decided by that day's sunrise and sunset when known — cached
 * times of day, not Open-Meteo's `is_day`, which describes the moment of the
 * fetch and goes stale in the hour-long weather cache.
 *
 * Without `civil` (weather failed, or a cache entry written before #274) the
 * only estimate is mean solar time from longitude, which can be an hour or more
 * off the clock. It is good enough to pick the period of the day, so the text
 * is the period alone (`"night"`) and `clockKnown` is false: the narrative must
 * not state a clock time it does not have. Before #274 the mean-solar clock
 * time reached the narrative and was written as fact ("2:33" at 03:28 PDT).
 */
export function localTimeOfDay(
  timeStampMs: number,
  lon: number,
  civil?: CivilTimeInfo,
): { text: string; isNight: boolean; clockKnown: boolean } {
  if (civil === undefined) {
    const solar = new Date(timeStampMs + (lon / 15) * 3_600_000);
    const band = clockBand(solar.getUTCHours());
    return { text: band, isNight: band === "night", clockKnown: false };
  }

  const d = new Date(timeStampMs + civil.utcOffsetSeconds * 1000);
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  const sunrise = minutesOfDay(civil.sunrise);
  const sunset = minutesOfDay(civil.sunset);
  const now = hh * 60 + mm;
  const sunDown =
    sunrise !== undefined && sunset !== undefined ? now < sunrise || now >= sunset : undefined;
  // The sun, when known, overrides the clock bands both ways: dark at 18:45 in
  // October, light at 22:30 in an Icelandic June.
  const clock = clockBand(hh);
  const band =
    sunDown === true
      ? "night"
      : sunDown === false && clock === "night"
        ? hh < 5
          ? "early morning"
          : "evening"
        : clock;
  return {
    text: `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} — ${band}`,
    isNight: band === "night",
    clockKnown: true,
  };
}

function clockBand(hh: number): string {
  if (hh < 5) return "night";
  if (hh < 8) return "early morning";
  if (hh < 11) return "morning";
  if (hh < 14) return "midday";
  if (hh < 17) return "afternoon";
  if (hh < 20) return "evening";
  return "night";
}

/** `"HH:MM"` → minutes after midnight; undefined for anything else. */
function minutesOfDay(hhmm: string | undefined): number | undefined {
  const m = hhmm === undefined ? null : /^(\d{2}):(\d{2})$/.exec(hhmm);
  return m === null ? undefined : Number(m[1]) * 60 + Number(m[2]);
}
