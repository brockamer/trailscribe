import { z } from "zod";
import { journalLocationPrecision, type Env } from "../env.js";
import { chatCompletion } from "../adapters/ai/openrouter.js";
import { log } from "../adapters/logging/worker-logs.js";
import type { SamplingAssessment, TrackMetrics } from "./track-metrics.js";
import { kmhToMph, kmToMi, mToFt } from "./units.js";

/**
 * Narrative module — composes a `!post` event into a structured blog post via
 * the configured LLM (P1-04: model + base URL come from env, defaulting to
 * `anthropic/claude-opus-5.5` on OpenRouter, #263).
 *
 * The orchestrator (P1-16) calls `generateNarrative(input)` once per `!post`,
 * gets back `{ title, haiku, body, usage }`, and:
 *   - feeds `title` + a short summary into the device reply (≤ 160 chars);
 *   - feeds the full `body` (+ frontmatter using title/haiku) into the journal
 *     publish (P1-08).
 *
 * Token usage from the OpenRouter response is propagated as-is — we never use
 * character-count proxies (drift over time, undercounts on multi-byte text).
 */
export interface NarrativeInput {
  /**
   * The user's note text from `!post <note>`. Omitted for bare `!post` (#124),
   * in which case the LLM constructs the narrative purely from enrichment
   * context (lat/lon/placeName/weather) and is given a no-note system prompt
   * that explicitly forbids inventing activities or feelings.
   */
  note?: string;
  lat?: number;
  lon?: number;
  /** Reverse-geocoded place name (P1-09). Optional — omitted prompt when absent. */
  placeName?: string;
  /** Weather summary (P1-10). Optional — omitted prompt when absent. */
  weather?: string;
  /**
   * Local time of day from `localTimeOfDay()`: the civil clock time, e.g.
   * `"03:28 — night"`, or the period alone (`"night"`) when no UTC offset is
   * known (#274). Must be the same value the image prompt receives, so a bare
   * post's text and its image agree on the hour (#240). Omitted prompt line
   * when absent.
   */
  localTime?: string;
  /** True when `localTime` is in the night band; adds an explicit darkness line. */
  isNight?: boolean;
  /**
   * False when `localTime` is a period only. The prompt line then tells the
   * model no clock time is known, so it cannot invent one (#274).
   */
  clockKnown?: boolean;
  env: Env;
}

export interface NarrativeOutput {
  title: string;
  haiku: string;
  body: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

/** JSON-schema enforced by the LLM provider's structured-output mode. */
const POST_NARRATIVE_SCHEMA = {
  name: "narrative",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 60 },
      haiku: { type: "string", maxLength: 110 },
      body: { type: "string", maxLength: 500 },
    },
    required: ["title", "haiku", "body"],
    additionalProperties: false,
  },
} as const;

const PostContentSchema = z.object({
  title: z.string().min(1).max(60),
  haiku: z.string().min(1).max(110),
  body: z.string().min(1).max(500),
});

/**
 * The system prompt drives tone and the hard caps. The schema enforces the
 * length caps server-side; the prompt is what makes the model actually *try*
 * to stay within them and to match the user's voice.
 */
const SYSTEM_PROMPT_POST_WITH_NOTE = [
  "You write short field-journal entries from a backcountry traveller's brief notes.",
  "Always return valid JSON matching the schema. No prose outside the JSON.",
  "Constraints:",
  '- "title": ≤ 60 characters, evocative, no clickbait, no emoji.',
  '- "haiku": exactly three lines separated by newlines, in 5/7/5 syllables, ≤ 110 characters total (count strictly — including spaces and newlines). Plain English. No formatting marks.',
  '- "body": ≤ 500 characters. Match the voice and tone of the input note. First-person if the note is first-person; observational if observational. Do not invent specifics not implied by the note, place, or weather context.',
].join("\n");

/**
 * No-note variant for bare `!post` (#124). The operator sent no caption, so the
 * LLM must construct the narrative purely from enrichment context (location,
 * weather, time). It is the operator's own journal, so the voice is first-person
 * present and sparse (#240) — never a third-person bulletin about "a traveller".
 * The model is explicitly forbidden from inventing activities, feelings, or
 * specifics not present in the metadata — a stronger constraint than the
 * with-note prompt because there's no anchoring caption to ground it. Do not
 * reintroduce words like "traveller" or "observational": the model echoes the
 * prompt's own vocabulary into the post.
 */
const SYSTEM_PROMPT_POST_NO_NOTE = [
  "You write short field-journal entries in the operator's own voice: first-person, present tense, plain and sparse. The operator did not provide a caption — say what is true about this place and moment from the metadata alone, as the operator would note it in their own journal.",
  "Always return valid JSON matching the schema. No prose outside the JSON.",
  "Constraints:",
  '- "title": ≤ 60 characters, evocative, no clickbait, no emoji. Anchor to the place name or weather, not to invented activities.',
  '- "haiku": exactly three lines separated by newlines, in 5/7/5 syllables, ≤ 110 characters total (count strictly — including spaces and newlines). Plain English. No formatting marks. Anchor to observable detail (place, weather, time, terrain).',
  '- "body": ≤ 500 characters. First-person present, like a private journal line, not a weather report. Do not invent activities, feelings, companions, or specifics that are not present in the location or weather context. If context is sparse, keep the body short rather than padding.',
  "- Do not open with coordinates. Describe this moment, not what is typical for the region or season.",
  '- A "Local time" line, when present, fixes the time of day: make the light and sky agree with it, and never describe daylight, sunset or evening when it says night. State a clock time only when the Local time line gives one; otherwise name only the part of the day.',
].join("\n");

/** Model used when `LLM_MODEL` is empty (#263). */
const DEFAULT_MODEL = "anthropic/claude-opus-5.5";

/**
 * Output caps (#263). The model is a reasoning model: its hidden reasoning tokens
 * (180–560 per narrative call, measured) count against `max_tokens`, and a call
 * that hits the cap returns truncated, non-JSON content. At 600, 3 of 16 post
 * calls failed that way. The largest observed post completion was 725 tokens; a
 * track completion was 974, and a full 3,000-character body adds about 750 more.
 * No `reasoning` parameter is sent, so the caps stay harmless on a non-reasoning
 * model and a rollback is `LLM_MODEL` alone. Do not lower these.
 */
const POST_MAX_TOKENS = 2000;
const TRACK_MAX_TOKENS = 3000;

export class NarrativeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NarrativeError";
  }
}

interface RunNarrativeCallOpts<T> {
  env: Env;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: { name: string; strict: true; schema: object };
  zodSchema: z.ZodType<T>;
  maxTokens: number;
  diagKind: "post" | "track";
}

/**
 * Shared OpenRouter call + response handling for both `!post` and tracking
 * narrative variants. Owns: chatCompletion invocation, missing-content
 * diagnostics, JSON.parse error wrapping, zod validation, usage extraction.
 *
 * Callers supply variant-specific prompts, schemas, and `diagKind` literal so
 * a failed call can be traced back to the originating pipeline in logs.
 */
async function runNarrativeCall<T>(
  opts: RunNarrativeCallOpts<T>,
): Promise<{ data: T; usage: NarrativeOutput["usage"] }> {
  const response = await chatCompletion({
    req: {
      model: opts.model,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.userPrompt },
      ],
      response_format: { type: "json_schema", json_schema: opts.responseSchema },
      temperature: 0.7,
      max_tokens: opts.maxTokens,
    },
    env: opts.env,
  });

  const content = response.choices[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    const choice0 = response.choices[0];
    log({
      event: "narrative_diag",
      level: "warn",
      diag: {
        kind: opts.diagKind,
        model: opts.model,
        choicesLen: response.choices.length,
        finishReason: choice0?.finish_reason ?? null,
        messageKeys: choice0?.message ? Object.keys(choice0.message) : [],
        contentType: typeof choice0?.message?.content,
        contentLen:
          typeof choice0?.message?.content === "string" ? choice0.message.content.length : 0,
        usage: response.usage ?? null,
      },
    });
    throw new NarrativeError(
      opts.diagKind === "track"
        ? "LLM returned no content for track narrative"
        : "LLM returned no content",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new NarrativeError(`LLM returned non-JSON content: ${content.slice(0, 120)}`, {
      cause: e,
    });
  }

  const validated = opts.zodSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new NarrativeError(
      opts.diagKind === "track"
        ? `Track narrative failed schema: ${issues}`
        : `LLM output failed schema: ${issues}`,
    );
  }

  return {
    data: validated.data,
    usage: {
      prompt_tokens: response.usage.prompt_tokens,
      completion_tokens: response.usage.completion_tokens,
    },
  };
}

export async function generateNarrative(input: NarrativeInput): Promise<NarrativeOutput> {
  const userPrompt = buildUserPrompt(input);
  const systemPrompt = hasNote(input) ? SYSTEM_PROMPT_POST_WITH_NOTE : SYSTEM_PROMPT_POST_NO_NOTE;

  const { data, usage } = await runNarrativeCall({
    env: input.env,
    model: input.env.LLM_MODEL || DEFAULT_MODEL,
    systemPrompt,
    userPrompt,
    responseSchema: POST_NARRATIVE_SCHEMA,
    zodSchema: PostContentSchema,
    maxTokens: POST_MAX_TOKENS,
    diagKind: "post",
  });

  return { title: data.title, haiku: data.haiku, body: data.body, usage };
}

/** True when the operator supplied a non-blank caption (bare posts have none). */
function hasNote(input: NarrativeInput): boolean {
  return input.note !== undefined && input.note.trim().length > 0;
}

/**
 * Compose the user-facing prompt. When lat/lon/placeName/weather are absent
 * (no GPS fix or geocode/weather lookup failed upstream), those lines are
 * omitted entirely — no "(unknown)" or "(0,0)" placeholders that would steer
 * the model toward synthesising location-specific detail.
 *
 * Bare `!post` (#124) supplies no `note` — the `Note:` line is omitted and the
 * model relies on the no-note system prompt + enrichment lines below.
 */
function buildUserPrompt(input: NarrativeInput): string {
  const lines: string[] = [];

  if (hasNote(input)) {
    lines.push(`Note: ${input.note}`);
  }

  if (input.placeName !== undefined && input.lat !== undefined && input.lon !== undefined) {
    // The body is published, so the model never sees finer coordinates than the frontmatter carries.
    // A bare post (#240) sees the place name only: given raw lat/lon the model opens the body on
    // them. The captioned post keeps them — the caption anchors its voice.
    const p = journalLocationPrecision(input.env);
    lines.push(
      p === "omit" || !hasNote(input)
        ? `Location: ${input.placeName}`
        : `Location: ${input.placeName} (${input.lat.toFixed(p)}, ${input.lon.toFixed(p)})`,
    );
  }

  if (input.weather !== undefined) {
    lines.push(`Weather: ${input.weather}`);
  }

  if (input.localTime !== undefined && input.localTime.length > 0) {
    lines.push(
      input.clockKnown === false
        ? `Local time: ${input.localTime} (clock time unknown — state no clock time)`
        : `Local time: ${input.localTime}`,
    );
    if (input.isNight) lines.push("It is dark outside: no daylight, sunset or evening light.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Track-session narrative (Task 3.3)
// ---------------------------------------------------------------------------

export interface TrackNarrativeInput {
  metrics: TrackMetrics;
  /** When `undersampled`, the prompt marks distance as a lower bound (#230). */
  sampling?: SamplingAssessment;
  startPlace?: string;
  endPlace?: string;
  midpointPlace?: string;
  weatherSummary?: string;
  env: Env;
}

const TRACK_NARRATIVE_SCHEMA = {
  name: "track_narrative",
  strict: true,
  schema: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 60 },
      haiku: { type: "string", maxLength: 110 },
      body: { type: "string", maxLength: 3000 },
    },
    required: ["title", "haiku", "body"],
    additionalProperties: false,
  },
} as const;

const TrackContentSchema = z.object({
  title: z.string().min(1).max(60),
  haiku: z.string().min(1).max(110),
  body: z.string().min(1).max(3000),
});

/**
 * Third system-prompt variant alongside SYSTEM_PROMPT_POST_WITH_NOTE and
 * SYSTEM_PROMPT_POST_NO_NOTE. Used for closed Garmin tracking sessions.
 * Body cap is 3000 chars (vs 500 for !post). Explicitly forbids inventing
 * specifics not present in metrics or place names.
 */
const SYSTEM_PROMPT_TRACK = [
  "You write field-journal entries from a backcountry tracking session. Given metrics, start/end places, and weather, produce a polished post.",
  "Always return valid JSON matching the schema. No prose outside the JSON.",
  "Constraints:",
  '- "title": ≤60 characters, evocative, anchored to place + activity. No clickbait, no emoji.',
  '- "haiku": exactly three lines separated by newlines, in 5/7/5 syllables, ≤110 characters total. Plain English, observational.',
  '- "body": ≤3000 characters. Describe the route, place, conditions, and pace. Use long stops as paragraph breaks. Do not invent companions, motivations, or destinations not present in the metrics or place names.',
  '- If the input carries a "Data quality" note, obey it: it means the recorded fixes are sparse, so gaps in the data are not events in the field.',
  "- Use US customary units exclusively in the body: miles, feet, °F, mph. Never kilometers, meters, °C, or km/h. The numbers in the input are already imperial — render them in the body using the same units shown.",
].join("\n");

/**
 * Generate a structured journal-post narrative from a closed tracking session.
 * Returns the same `NarrativeOutput` shape as `generateNarrative` so the
 * publish layer can treat all three variants uniformly.
 */
export async function generateTrackNarrative(input: TrackNarrativeInput): Promise<NarrativeOutput> {
  const { data, usage } = await runNarrativeCall({
    env: input.env,
    model: input.env.LLM_MODEL || DEFAULT_MODEL,
    systemPrompt: SYSTEM_PROMPT_TRACK,
    userPrompt: buildTrackPrompt(input),
    responseSchema: TRACK_NARRATIVE_SCHEMA,
    zodSchema: TrackContentSchema,
    maxTokens: TRACK_MAX_TOKENS,
    diagKind: "track",
  });

  return { title: data.title, haiku: data.haiku, body: data.body, usage };
}

function buildTrackPrompt(input: TrackNarrativeInput): string {
  const m = input.metrics;
  const lines: string[] = [];
  lines.push("Tracking session metrics:");
  const sparse = input.sampling?.undersampled ? input.sampling : undefined;
  if (sparse) {
    lines.push(
      `- Distance: at least ${kmToMi(m.distanceKm).toFixed(2)} mi (LOWER BOUND; the device's own speeds imply about ${kmToMi(sparse.estimatedDistanceKm).toFixed(2)} mi)`,
    );
  } else {
    lines.push(`- Distance: ${kmToMi(m.distanceKm).toFixed(2)} mi`);
  }
  lines.push(`- Duration: ${(m.durationSeconds / 60).toFixed(0)} minutes`);
  lines.push(`- Elevation gain: ${mToFt(m.elevation.gainM).toFixed(0)} ft`);
  lines.push(`- Activity: ${m.activityHint}, route shape: ${m.routeShape}`);
  lines.push(
    `- Average speed: ${kmhToMph(m.pace.avgKmh).toFixed(1)} mph, p95: ${kmhToMph(m.pace.p95Kmh).toFixed(1)} mph`,
  );
  if (sparse) {
    lines.push(
      `Data quality: the tracker recorded only ${m.pingCount} fixes, up to ${Math.round(sparse.maxGapSeconds / 60)} minutes apart. The distance above is a lower bound and gaps between fixes are recording artifacts, not pauses. Do not infer stopping, resting, or standing still from the duration or the short distance, and do not present the distance as exact. Say plainly that the track is sparse.`,
    );
  }
  if (input.startPlace) lines.push(`Start: ${input.startPlace}`);
  if (input.endPlace) lines.push(`End: ${input.endPlace}`);
  if (input.midpointPlace) lines.push(`Midpoint: ${input.midpointPlace}`);
  if (input.weatherSummary) lines.push(`Weather: ${input.weatherSummary}`);
  return lines.join("\n");
}
