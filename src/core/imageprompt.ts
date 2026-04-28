export interface ImagePromptInputs {
  caption: string;
  /** Reverse-geocoded place name (no specific landmark naming required). */
  place?: string;
  lat?: number;
  lon?: number;
  altitudeM?: number;
  /** Free-form local time string, e.g. "07:42 — early morning". */
  localTime?: string;
  /** Free-form weather summary, e.g. "scattered clouds, 9C, light wind". */
  weather?: string;
}

const REALISM_GUARDS = [
  "Realistic, plausible scene grounded in the telemetry above.",
  "Lighting and shadows match the local time of day.",
  "No text, captions, watermarks, signs, or readable lettering anywhere in the image.",
  "Do not invent or label specific named landmarks unless explicitly stated above.",
];

/**
 * Build a deterministic, paragraph-style prompt grounding the image in the
 * device telemetry. Inputs are described in the order Place → Coords →
 * Altitude → Time → Weather so the output is stable across runs (the
 * snapshot tests assert exact strings, since prompt drift = image drift).
 *
 * Optional axes are omitted gracefully — a no-GPS-fix `!postimg` should still
 * produce a usable prompt off the caption + (maybe) weather + (maybe) time.
 *
 * Realism guards (no-text, no-fake-landmarks, lighting-matches-time) are
 * always appended; they encode the constraints from #125's body and are the
 * difference between a journal-illustration prompt and a generic stock-image
 * prompt.
 */
export function buildImagePrompt(inputs: ImagePromptInputs): string {
  const parts: string[] = [`Photographic field journal illustration: ${inputs.caption.trim()}.`];

  if (inputs.place !== undefined && inputs.place.length > 0) {
    parts.push(`Location: ${inputs.place}.`);
  }
  if (inputs.lat !== undefined && inputs.lon !== undefined) {
    parts.push(`Coordinates: ${formatCoord(inputs.lat)}, ${formatCoord(inputs.lon)}.`);
  }
  if (inputs.altitudeM !== undefined) {
    parts.push(`Altitude: ${Math.round(inputs.altitudeM)} m.`);
  }
  if (inputs.localTime !== undefined && inputs.localTime.length > 0) {
    parts.push(`Local time: ${inputs.localTime}.`);
  }
  if (inputs.weather !== undefined && inputs.weather.length > 0) {
    parts.push(`Weather: ${inputs.weather}.`);
  }

  parts.push(...REALISM_GUARDS);
  return parts.join(" ");
}

function formatCoord(n: number): string {
  return n.toFixed(4);
}
