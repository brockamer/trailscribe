export interface ImagePromptInputs {
  /** Operator caption from `!postimg <caption>`. Absent for bare `!postimg`. */
  caption?: string;
  /**
   * Fallback subject for bare `!postimg` (#150) — the narrative the LLM just
   * wrote from telemetry. Used only when `caption` is absent; a caption always
   * wins, since it is what the operator actually asked for.
   */
  narrativeSubject?: string;
  /** Reverse-geocoded place name (no specific landmark naming required). */
  place?: string;
  altitudeM?: number;
  /** Free-form local time string, e.g. "07:42 — early morning". */
  localTime?: string;
  /**
   * Raw WMO weather code from Open-Meteo, mapped here to a light-quality
   * phrase. Deliberately not the display string: "74°F, 8mph" is data a
   * diffusion model cannot render, whereas "crisp, well-defined shadows" is.
   */
  weatherCode?: number;
  /**
   * True when `localTime` falls in the night band. Without it a clear sky at
   * 02:00 rendered "bright, clear sunlight" alongside "night" in the same
   * prompt (#235 review).
   */
  isNight?: boolean;
}

/**
 * Opening clause. Leads with the medium we actually want.
 *
 * The pre-#235 lead was "Photographic field journal illustration:" — which
 * asked for a photograph and an illustration in the same breath, and reliably
 * got the illustration. Verified against real generations on 2026-09-14:
 * removing the word flipped flux-schnell from cartoon output to photographic
 * output with no other change.
 */
const PHOTO_LEAD = "A photorealistic photograph from a backcountry field journal.";

/**
 * Frames the operator's caption as mood and setting rather than a literal
 * object list.
 *
 * Without this, "crushing tasks and heavy sticky note kanban" rendered as
 * actual sticky notes covered in actual lettering — in a prompt whose own
 * guard clause forbids readable text. Stronger models follow the caption
 * *more* faithfully, so this qualifier matters more as model quality rises,
 * not less. It is a no-op for captions that already describe a scene.
 */
const CAPTION_FRAME =
  "Render the mood and setting evoked by this note, not a literal depiction of the objects or words in it:";

/** Format/quality anchor. Goes last, where format stamps carry most weight. */
const CAMERA_ANCHOR =
  "Shot on a real camera: natural imperfections, true-to-life color and texture, no illustration or painterly style.";

/**
 * Negative-space guard, kept as its own constant.
 *
 * None of the current flagship Replicate models expose a `negative_prompt`
 * input (checked across the Flux 1.1/2 families, Imagen 4, Ideogram v3 and
 * Seedream 4 on 2026-09-14, validated against a control model that does have
 * one), so this has to ride inline. Keeping it separate means it can move to
 * a real field the day a model supports it, without unpicking the template.
 */
const NEGATIVE_GUARD =
  "No readable text, signage, or watermarks; do not invent or label specific named landmarks beyond what is given.";

/**
 * WMO code → renderable light quality.
 *
 * Bucket boundaries mirror `wmoLabel()` in the weather adapter. Wind and
 * temperature are deliberately dropped: neither has a visual referent a model
 * can act on, and "8mph" invites an invented motion cue.
 */
function lightQuality(code: number, isNight = false): string {
  if (isNight) return nightLightQuality(code);
  if (code === 0) return "Bright, clear sunlight with crisp, well-defined shadows.";
  if (code >= 1 && code <= 3)
    return "Soft, filtered daylight with scattered clouds and gently diffused shadows.";
  if (code === 45 || code === 48)
    return "Flat, diffused light through fog, muted colors and low-contrast edges.";
  if (code >= 51 && code <= 57)
    return "Damp overcast light, wet surfaces, soft reflections and weak shadows.";
  if (code >= 61 && code <= 67)
    return "Grey rain light, wet ground, heavy diffuse shadows and saturated darks.";
  if (code >= 71 && code <= 77)
    return "Cold bright snow light, high ambient bounce, pale blue shadows.";
  if (code >= 80 && code <= 82)
    return "Broken shower light, patches of bright sun between dark cloud.";
  if (code >= 95 && code <= 99)
    return "Dark dramatic storm light, heavy cloud, low contrast and flat shadow.";
  return "Natural outdoor daylight.";
}

/** Night-band parallel to lightQuality(). Same WMO buckets, no sun. */
function nightLightQuality(code: number): string {
  if (code === 0) return "Clear night sky, stars visible, cool blue-black ambient shadows.";
  if (code >= 1 && code <= 3) return "Broken cloud at night, dim ambient sky glow, soft darkness.";
  if (code === 45 || code === 48) return "Night fog, heavy diffusion, near-zero contrast.";
  if (code >= 51 && code <= 67)
    return "Wet night, dark saturated surfaces, scattered specular highlights.";
  if (code >= 71 && code <= 77) return "Snow at night, pale ground glow against a black sky.";
  if (code >= 80 && code <= 82) return "Night showers, dark cloud, wet reflective ground.";
  if (code >= 95 && code <= 99) return "Night storm, very dark, occasional lightning cast.";
  return "Natural night darkness, low ambient light.";
}

/**
 * Build a deterministic prompt grounding the image in device telemetry.
 *
 * Clause order is: photographic lead → caption (framed as mood) → place →
 * light quality → time → altitude → camera anchor → negative guard. Earlier
 * tokens carry more weight, so the caption stays near the front; what changed
 * in #235 is how it is *framed*, not where it sits.
 *
 * Optional axes are omitted gracefully — a no-GPS-fix `!postimg` still
 * produces a usable prompt from the caption alone. In particular the
 * lighting-matches-time clause is emitted only when `localTime` is actually
 * present; before #235 it was unconditional boilerplate, and the data to
 * ground it never reached this function at all.
 *
 * Raw coordinates are deliberately absent. They consumed prompt budget a
 * diffusion model cannot use; the place name does that work.
 */
export function buildImagePrompt(inputs: ImagePromptInputs): string {
  const parts: string[] = [PHOTO_LEAD];

  const caption = inputs.caption?.trim();
  const narrative = inputs.narrativeSubject?.trim();
  if (caption !== undefined && caption.length > 0) {
    // A human caption may name objects it does not want drawn, so it gets the
    // mood-framing qualifier.
    parts.push(`${CAPTION_FRAME} ${caption}.`);
  } else if (narrative !== undefined && narrative.length > 0) {
    // The narrative is already prose describing a scene — framing it as "mood,
    // not objects" would fight a problem that isn't present.
    parts.push(narrative.endsWith(".") ? narrative : `${narrative}.`);
  }

  if (inputs.place !== undefined && inputs.place.length > 0) {
    parts.push(`Location: ${inputs.place}.`);
  }
  if (inputs.weatherCode !== undefined) {
    parts.push(lightQuality(inputs.weatherCode, inputs.isNight));
  }
  if (inputs.localTime !== undefined && inputs.localTime.length > 0) {
    parts.push(`Local time: ${inputs.localTime}; lighting and shadows match that time of day.`);
  }
  if (inputs.altitudeM !== undefined) {
    parts.push(`Altitude: ${Math.round(inputs.altitudeM)} m.`);
  }

  parts.push(CAMERA_ANCHOR, NEGATIVE_GUARD);
  return parts.join(" ");
}
