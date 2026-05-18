/**
 * Unit conversion helpers. Internal source-of-truth in TrackMetrics and KV
 * records stays canonical metric (haversine math is naturally km/m); these
 * convert at the user-facing display layer — SMS reply, journal frontmatter,
 * LLM prompt input. See #195 for the operator-preference rationale.
 *
 * Weather is already imperial at the source (`adapters/location/weather.ts`
 * passes `temperature_unit=fahrenheit&wind_speed_unit=mph` to Open-Meteo).
 */

const KM_PER_MI = 1.609344;
const M_PER_FT = 0.3048;

export function kmToMi(km: number): number {
  return km / KM_PER_MI;
}

export function mToFt(m: number): number {
  return m / M_PER_FT;
}

export function kmhToMph(kmh: number): number {
  return kmh / KM_PER_MI;
}

/**
 * Convert a multi-line haiku (lines separated by `\n`) into CommonMark with
 * soft-breaks — two trailing spaces before each newline — so the published
 * HTML renders three visually distinct lines instead of collapsing into a
 * single paragraph. The final line gets no trailing spaces.
 */
export function formatHaiku(haiku: string): string {
  const lines = haiku.split("\n");
  if (lines.length <= 1) return haiku;
  const head = lines.slice(0, -1).map((l) => `${l}  `);
  return [...head, lines[lines.length - 1]].join("\n");
}
