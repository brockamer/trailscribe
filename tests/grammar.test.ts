import { describe, test, expect } from "vitest";
import { parseCommand } from "../src/core/grammar.js";

describe("parseCommand — α-MVP commands", () => {
  test("parses !ping", () => {
    expect(parseCommand("!ping")).toEqual({ type: "ping" });
  });

  test("parses !help", () => {
    expect(parseCommand("!help")).toEqual({ type: "help" });
  });

  test("parses !cost", () => {
    expect(parseCommand("!cost")).toEqual({ type: "cost" });
  });

  test("parses !post <note>", () => {
    expect(parseCommand("!post Day 3 at Treasure Lakes, clear skies")).toEqual({
      type: "post",
      note: "Day 3 at Treasure Lakes, clear skies",
    });
  });

  test("parses !todo <task>", () => {
    expect(parseCommand("!todo Buy milk")).toEqual({
      type: "todo",
      task: "Buy milk",
    });
  });

  test("parses !mail with simple subject", () => {
    expect(parseCommand("!mail to:test@example.com subj:Hello body:Hi there")).toEqual({
      type: "mail",
      to: "test@example.com",
      subj: "Hello",
      body: "Hi there",
    });
  });

  test("parses !mail subject containing spaces (regression: subj regex bug)", () => {
    expect(
      parseCommand("!mail to:lab@university.edu subj:Specimen Question body:Found at 11k ft"),
    ).toEqual({
      type: "mail",
      to: "lab@university.edu",
      subj: "Specimen Question",
      body: "Found at 11k ft",
    });
  });

  test("case-insensitive verb", () => {
    expect(parseCommand("!PING")).toEqual({ type: "ping" });
    expect(parseCommand("!Todo wash dishes")).toEqual({ type: "todo", task: "wash dishes" });
  });
});

describe("parseCommand — rejects unknown / malformed input", () => {
  test("returns undefined for non-! text", () => {
    expect(parseCommand("hello world")).toBeUndefined();
  });

  test("returns undefined for unknown verb", () => {
    expect(parseCommand("!foo bar")).toBeUndefined();
  });

  test("returns undefined for !post without a note", () => {
    expect(parseCommand("!post")).toBeUndefined();
  });

  test("returns undefined for !todo without a task", () => {
    expect(parseCommand("!todo  ")).toBeUndefined();
  });

  test("returns undefined for malformed !mail", () => {
    expect(parseCommand("!mail to:a@b.com subj:Hi")).toBeUndefined(); // missing body:
    expect(parseCommand("!mail just some text")).toBeUndefined();
  });

  test("returns undefined for deferred Phase 2+ commands (!ai, !where, !drop, etc.)", () => {
    expect(parseCommand("!ai what is the capital of France")).toBeUndefined();
    expect(parseCommand("!where")).toBeUndefined();
    expect(parseCommand("!drop saw a bear")).toBeUndefined();
    expect(parseCommand("!brief")).toBeUndefined();
    expect(parseCommand("!camp hot springs nearby")).toBeUndefined();
    expect(parseCommand("!blast check-in day 5")).toBeUndefined();
    expect(parseCommand("!share to:a@b.com on summit")).toBeUndefined();
    expect(parseCommand("!weather")).toBeUndefined();
  });
});
