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
  /**
   * Local time from `localTimeOfDay()`: the civil clock time, e.g.
   * "07:42 — early morning", or the period alone ("night") when no UTC offset
   * is known (#274).
   */
  localTime?: string;
  /**
   * Raw WMO weather code from Open-Meteo, mapped here to a light-quality
   * phrase. Deliberately not the display string: "74°F, 8mph" is data a
   * diffusion model cannot render, whereas "crisp, well-defined shadows" is.
   */
  weatherCode?: number;
  /**
   * True when it is dark: the sun is down by that day's sunrise/sunset, or
   * `localTime` falls in the night band when those are unknown (#274). Without it a clear sky at
   * 02:00 rendered "bright, clear sunlight" alongside "night" in the same
   * prompt (#235 review).
   */
  isNight?: boolean;
}

/**
 * Opening clause. Leads with the medium we actually want: a casual snapshot,
 * not a composed photograph.
 *
 * The pre-#235 lead was "Photographic field journal illustration:" — which
 * asked for a photograph and an illustration in the same breath, and reliably
 * got the illustration. Verified against real generations on 2026-09-14:
 * removing the word flipped flux-schnell from cartoon output to photographic
 * output with no other change.
 *
 * #235's replacement, "A photorealistic photograph from a backcountry field
 * journal.", drew the journal: an open notebook filled the frame, and on
 * 2026-09-30 a woman sat writing in it (#267). An interim "…while out on the
 * trail" put a trail down the middle of every render, lake camps and city
 * streets included — the operator is not always on a trail. So the lead
 * names the medium and nothing about the setting.
 */
const PHOTO_LEAD = "An ordinary, unposed phone photo taken handheld at eye level.";

/**
 * Who may appear in the picture: nobody, by default (#267).
 *
 * This sits second, straight after the lead. Real flux-2-max renders on
 * 2026-10-01 showed that a "no people" clause at the end of the prompt still
 * let distant hikers and beachgoers through in about one image in four; the
 * same rule at the front held on mountain, lake and fog scenes. It is phrased
 * as a property of the scene ("deserted") because a diffusion model reads a
 * prompt as concepts, not logic, and a bare "no people" also names people.
 *
 * The final clause covers captions that mention someone: "met a hiker at the
 * pass" drew that hiker on the trail until it existed.
 */
const PEOPLE_RULE =
  "Nobody poses and nobody is the subject. The place is deserted, with no one else in sight, near or far, all the way to the horizon; anyone the note mentions has already gone, so draw only the place.";

/**
 * Whose eyes the picture is seen through (#267).
 *
 * Without it the model drew the journal keeper as the subject. Naming body
 * parts that may enter the frame ("knees, boots, hands") put them in every
 * render, and "holds the camera" drew a camera in the hand — so neither is
 * named. The "I" sentence is for bare `!postimg`, whose narrative has been
 * first-person since #240.
 */
const POINT_OF_VIEW =
  'Seen first-person, from where the photographer stands, looking at the view as they saw it; the photographer is behind the camera, not in the picture. Any "I" in the text below is the photographer.';

/**
 * The only places where other people may appear (operator decisions,
 * 2026-10-01): an empty city street looks wrong, and a popular public beach
 * is treated like a town.
 *
 * Placed after the location, never at the front. With this exception at the
 * front, the model applied it to mountain passes as well and drew hikers on
 * the ridge in half the mountain renders; after the location it judges the
 * exception against the actual place. Reverse geocoding cannot make this
 * call instead: Malibu's city limits cover its wild bluffs and beaches, so
 * the address says "city" for exactly the scenes that failed.
 */
const PEOPLE_EXCEPTION =
  "The only exceptions are a busy town or city street and a popular public beach: there, a few ordinary people far in the background are normal, small and not facing the camera.";

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

/**
 * Format/quality anchor. Goes last, where format stamps carry most weight.
 *
 * Asks for an everyday phone picture rather than a "real camera" shot, which
 * came out as polished, wide-angle stock photography (#267, operator: "like a
 * casual photo… a believable photo").
 */
const CAMERA_ANCHOR =
  "It looks like a real, unedited phone picture: natural exposure, true-to-life color, ordinary everyday framing, slight softness and sensor noise in the shadows. Not cinematic, not a staged stock photo, no HDR glow, no illustration or painterly style.";

/**
 * Negative-space guard, kept as its own constant.
 *
 * None of the current flagship Replicate models expose a `negative_prompt`
 * input (checked across the Flux 1.1/2 families, Imagen 4, Ideogram v3 and
 * Seedream 4 on 2026-09-14, validated against a control model that does have
 * one), so this has to ride inline. Keeping it separate means it can move to
 * a real field the day a model supports it, without unpicking the template.
 * The people clause here is a backstop only; the rule that works is
 * PEOPLE_RULE at the front (#267).
 */
const NEGATIVE_GUARD =
  "No posed people, no close-up faces, no figure as the subject. No readable text, signage, or watermarks; do not invent or label specific named landmarks beyond what is given.";

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
 * Clause order is: photographic lead → people rule → point of view → caption
 * (framed as mood) → place → people exception → light quality → time →
 * altitude → camera anchor → negative guard. Earlier tokens carry more
 * weight, so the caption stays near the front; what changed in #235 is how it
 * is *framed*, not where it sits. The people rule and point of view precede
 * it because, measured on real renders, they only hold there (#267).
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
  const parts: string[] = [PHOTO_LEAD, PEOPLE_RULE, POINT_OF_VIEW];

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
    parts.push(`Location: ${inputs.place}; show it the way it really looks there.`);
  }
  // Always present: with no place name the model judges the exception from
  // the note alone, which is still better than an empty city street.
  parts.push(PEOPLE_EXCEPTION);
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
