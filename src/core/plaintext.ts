/**
 * Plain-text guards for LLM replies that go to the Garmin device (#271).
 *
 * The device shows Markdown emphasis markers as literal characters, and every
 * marker uses reply budget (320 chars, PRD §6). Opus 5.5 writes `**bold**`
 * unless it is told not to, so the free-text commands do both: ask for plain
 * text in the system prompt, then strip what still gets through.
 */

/**
 * Sentence appended to the `!ai` and `!camp` system prompts. The `!brief`
 * prompt already carries its own "Use plain text only."
 */
export const PLAIN_TEXT_INSTRUCTION =
  "Use plain text only: no Markdown, no asterisks for bold or italics, " +
  "and no heading or bullet markers.";

// A marker pair counts only when text touches both markers, like CommonMark's
// flanking rule. That leaves `a ** b ** c` and a cut-off `**water near` alone.
const BOLD_STARS = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
// `__` also needs a non-word character on the outside, so identifiers and file
// names such as `track__v2.gpx` keep their underscores.
const BOLD_UNDERSCORES = /(?<![A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])/g;

/**
 * Removes paired Markdown bold markers (`**x**`, `__x__`) and keeps the words.
 *
 * Deliberately narrow. A lone `*`, an unpaired `**` and underscores inside a
 * word stay as written, because on a trail device a wrong strip costs more
 * than a stray character. Call it before any length check so the 320-char
 * budget is measured on the text the device will show.
 */
export function stripMarkdownEmphasis(text: string): string {
  return text.replace(BOLD_STARS, "$1").replace(BOLD_UNDERSCORES, "$1");
}
