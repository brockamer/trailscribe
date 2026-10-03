/**
 * #271 — the device shows Markdown emphasis markers as literal characters, and
 * they use reply budget. `stripMarkdownEmphasis` is the backstop behind the
 * plain-text instruction in the !ai / !camp / !brief system prompts.
 */
import { describe, expect, test } from "vitest";
import { PLAIN_TEXT_INSTRUCTION, stripMarkdownEmphasis } from "../src/core/plaintext.js";

describe("stripMarkdownEmphasis (#271)", () => {
  test("removes paired ** around a phrase, keeping the words", () => {
    expect(stripMarkdownEmphasis("**Yes, likely.** Water at the inlet.")).toBe(
      "Yes, likely. Water at the inlet.",
    );
  });

  test("removes several bold spans in one reply", () => {
    expect(stripMarkdownEmphasis("Go **north** past the **ridge** (JMT).")).toBe(
      "Go north past the ridge (JMT).",
    );
  });

  test("removes paired __ around a phrase", () => {
    expect(stripMarkdownEmphasis("__Uncertain__ about the spring.")).toBe(
      "Uncertain about the spring.",
    );
  });

  test("removes bold that spans a line break", () => {
    expect(stripMarkdownEmphasis("**Line one\nline two** done")).toBe("Line one\nline two done");
  });

  test("leaves a lone * alone (arithmetic, footnote marks)", () => {
    expect(stripMarkdownEmphasis("5*3 is 15; see note*")).toBe("5*3 is 15; see note*");
  });

  test("leaves underscores inside identifiers and file names alone", () => {
    expect(stripMarkdownEmphasis("Saved to track_final__v2.gpx")).toBe(
      "Saved to track_final__v2.gpx",
    );
  });

  test("leaves an unpaired ** alone (cut-off answer)", () => {
    expect(stripMarkdownEmphasis("Maybe **water near")).toBe("Maybe **water near");
  });

  test("does not pair ** across a space-padded gap", () => {
    expect(stripMarkdownEmphasis("a ** b ** c")).toBe("a ** b ** c");
  });

  test("returns plain text unchanged", () => {
    expect(stripMarkdownEmphasis("Granite is an igneous rock.")).toBe(
      "Granite is an igneous rock.",
    );
  });

  test("returns an empty string unchanged", () => {
    expect(stripMarkdownEmphasis("")).toBe("");
  });
});

describe("PLAIN_TEXT_INSTRUCTION (#271)", () => {
  test("names plain text and asterisks", () => {
    expect(PLAIN_TEXT_INSTRUCTION.toLowerCase()).toContain("plain text");
    expect(PLAIN_TEXT_INSTRUCTION).toContain("asterisks");
  });
});
