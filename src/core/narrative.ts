import { z } from "zod";
import type { Env } from "../env.js";
import { chatCompletion } from "../adapters/ai/openrouter.js";
import { log } from "../adapters/logging/worker-logs.js";

/**
 * Narrative module — composes a `!post` event into a structured blog post via
 * the configured LLM (P1-04: model + base URL come from env, defaulting to
 * `anthropic/claude-sonnet-4-6` on OpenRouter).
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
const NARRATIVE_SCHEMA = {
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

const NarrativeContentSchema = z.object({
  title: z.string().min(1).max(60),
  haiku: z.string().min(1).max(110),
  body: z.string().min(1).max(500),
});

/**
 * The system prompt drives tone and the hard caps. The schema enforces the
 * length caps server-side; the prompt is what makes the model actually *try*
 * to stay within them and to match the user's voice.
 */
const SYSTEM_PROMPT_WITH_NOTE = [
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
 * weather, time). Tone is observational rather than first-person, and the
 * model is explicitly forbidden from inventing activities, feelings, or
 * specifics not present in the metadata — a stronger constraint than the
 * with-note prompt because there's no anchoring caption to ground it.
 */
const SYSTEM_PROMPT_NO_NOTE = [
  "You write short field-journal entries from a backcountry traveller's location and weather snapshot. The traveller did not provide a caption — describe what is true about this position and moment, in observational third-person, from the metadata alone.",
  "Always return valid JSON matching the schema. No prose outside the JSON.",
  "Constraints:",
  '- "title": ≤ 60 characters, evocative, no clickbait, no emoji. Anchor to the place name or weather, not to invented activities.',
  '- "haiku": exactly three lines separated by newlines, in 5/7/5 syllables, ≤ 110 characters total (count strictly — including spaces and newlines). Plain English. No formatting marks. Anchor to observable detail (place, weather, time, terrain).',
  '- "body": ≤ 500 characters. Observational voice. Do not invent activities, feelings, companions, or specifics that are not present in the location or weather context. If context is sparse, keep the body short rather than padding.',
].join("\n");

export class NarrativeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NarrativeError";
  }
}

export async function generateNarrative(input: NarrativeInput): Promise<NarrativeOutput> {
  const userPrompt = buildUserPrompt(input);
  const model = input.env.LLM_MODEL || "anthropic/claude-sonnet-4-6";
  const systemPrompt =
    input.note !== undefined && input.note.trim().length > 0
      ? SYSTEM_PROMPT_WITH_NOTE
      : SYSTEM_PROMPT_NO_NOTE;

  const response = await chatCompletion({
    req: {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_schema", json_schema: NARRATIVE_SCHEMA },
      temperature: 0.7,
      max_tokens: 600,
    },
    env: input.env,
  });

  const content = response.choices[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    const choice0 = response.choices[0];
    log({
      event: "narrative_diag",
      level: "warn",
      diag: {
        model,
        choicesLen: response.choices.length,
        finishReason: choice0?.finish_reason ?? null,
        messageKeys: choice0?.message ? Object.keys(choice0.message) : [],
        contentType: typeof choice0?.message?.content,
        contentLen:
          typeof choice0?.message?.content === "string" ? choice0.message.content.length : 0,
        usage: response.usage ?? null,
      },
    });
    throw new NarrativeError("LLM returned no content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new NarrativeError(`LLM returned non-JSON content: ${content.slice(0, 120)}`, {
      cause: e,
    });
  }

  const validated = NarrativeContentSchema.safeParse(parsed);
  if (!validated.success) {
    const issues = validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new NarrativeError(`LLM output failed schema: ${issues}`);
  }

  return {
    title: validated.data.title,
    haiku: validated.data.haiku,
    body: validated.data.body,
    usage: {
      prompt_tokens: response.usage.prompt_tokens,
      completion_tokens: response.usage.completion_tokens,
    },
  };
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

  if (input.note !== undefined && input.note.trim().length > 0) {
    lines.push(`Note: ${input.note}`);
  }

  if (
    input.placeName !== undefined &&
    input.lat !== undefined &&
    input.lon !== undefined
  ) {
    lines.push(`Location: ${input.placeName} (${input.lat.toFixed(4)}, ${input.lon.toFixed(4)})`);
  }

  if (input.weather !== undefined) {
    lines.push(`Weather: ${input.weather}`);
  }

  return lines.join("\n");
}
