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

  test("parses !mail with all short keys", () => {
    expect(parseCommand("!mail t:x@y.com s:hello b:from the trail")).toEqual({
      type: "mail",
      to: "x@y.com",
      subj: "hello",
      body: "from the trail",
    });
  });

  test("parses !mail with mixed long + short keys", () => {
    expect(parseCommand("!mail t:x@y.com subj:Hello b:msg")).toEqual({
      type: "mail",
      to: "x@y.com",
      subj: "Hello",
      body: "msg",
    });
  });

  test("parses !mail to-only (subj + body omitted)", () => {
    expect(parseCommand("!mail to:x@y.com")).toEqual({
      type: "mail",
      to: "x@y.com",
    });
    expect(parseCommand("!mail t:x@y.com")).toEqual({
      type: "mail",
      to: "x@y.com",
    });
  });

  test("parses !mail with subj only (body omitted)", () => {
    expect(parseCommand("!mail to:x@y.com subj:hi there")).toEqual({
      type: "mail",
      to: "x@y.com",
      subj: "hi there",
    });
    expect(parseCommand("!mail t:x@y.com s:hi")).toEqual({
      type: "mail",
      to: "x@y.com",
      subj: "hi",
    });
  });

  test("parses !mail with body only (subj omitted)", () => {
    expect(parseCommand("!mail to:x@y.com body:from the trail")).toEqual({
      type: "mail",
      to: "x@y.com",
      body: "from the trail",
    });
    expect(parseCommand("!mail t:x@y.com b:msg")).toEqual({
      type: "mail",
      to: "x@y.com",
      body: "msg",
    });
  });

  test("case-insensitive verb", () => {
    expect(parseCommand("!PING")).toEqual({ type: "ping" });
    expect(parseCommand("!Todo wash dishes")).toEqual({ type: "todo", task: "wash dishes" });
  });
});

describe("parseCommand — Phase 2 commands", () => {
  test("parses !where (no args)", () => {
    expect(parseCommand("!where")).toEqual({ type: "where" });
  });

  test("parses !weather (no args)", () => {
    expect(parseCommand("!weather")).toEqual({ type: "weather" });
  });

  test("parses !drop <note>", () => {
    expect(parseCommand("!drop Saw a black bear cub at 10,200 ft")).toEqual({
      type: "drop",
      note: "Saw a black bear cub at 10,200 ft",
    });
  });

  test("parses !brief with default window", () => {
    expect(parseCommand("!brief")).toEqual({ type: "brief" });
  });

  test("parses !brief Nd window override", () => {
    expect(parseCommand("!brief 7d")).toEqual({ type: "brief", windowDays: 7 });
    expect(parseCommand("!brief 30d")).toEqual({ type: "brief", windowDays: 30 });
  });

  test("rejects !brief with malformed window", () => {
    expect(parseCommand("!brief 7days")).toBeUndefined();
    expect(parseCommand("!brief 1w")).toBeUndefined();
    expect(parseCommand("!brief foo")).toBeUndefined();
  });

  test("parses !ai <question>", () => {
    expect(parseCommand("!ai what altitude do alpine larches grow")).toEqual({
      type: "ai",
      question: "what altitude do alpine larches grow",
    });
  });

  test("parses !camp <query>", () => {
    expect(parseCommand("!camp water sources near Onion Valley")).toEqual({
      type: "camp",
      query: "water sources near Onion Valley",
    });
  });

  test("parses !share with literal email", () => {
    expect(parseCommand("!share to:lab@university.edu specimen on summit ridge")).toEqual({
      type: "share",
      to: "lab@university.edu",
      note: "specimen on summit ridge",
    });
  });

  test("parses !share with alias", () => {
    expect(parseCommand("!share to:home day 5, all good")).toEqual({
      type: "share",
      to: "home",
      note: "day 5, all good",
    });
  });

  test("parses !blast <note>", () => {
    expect(parseCommand("!blast check-in day 5, north ridge")).toEqual({
      type: "blast",
      note: "check-in day 5, north ridge",
    });
  });

  test("parses !postimg <caption>", () => {
    expect(parseCommand("!postimg dawn light on the cirque")).toEqual({
      type: "postimg",
      caption: "dawn light on the cirque",
    });
  });

  test("case-insensitive Phase 2 verbs", () => {
    expect(parseCommand("!WHERE")).toEqual({ type: "where" });
    expect(parseCommand("!Drop note here")).toEqual({ type: "drop", note: "note here" });
    expect(parseCommand("!Brief 3D")).toEqual({ type: "brief", windowDays: 3 });
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
    expect(parseCommand("!mail just some text")).toBeUndefined();
    expect(parseCommand("!mail subj:no-to-key body:msg")).toBeUndefined(); // missing to:/t:
    expect(parseCommand("!mail to:")).toBeUndefined(); // empty to value
    expect(parseCommand("!mail tt:x@y.com")).toBeUndefined(); // unknown key
  });

  test("returns undefined for Phase 2 commands missing required args", () => {
    expect(parseCommand("!drop")).toBeUndefined();
    expect(parseCommand("!ai")).toBeUndefined();
    expect(parseCommand("!camp")).toBeUndefined();
    expect(parseCommand("!blast")).toBeUndefined();
    expect(parseCommand("!postimg")).toBeUndefined();
  });

  test("returns undefined for malformed !share", () => {
    expect(parseCommand("!share lab@university.edu note")).toBeUndefined(); // missing to:
    expect(parseCommand("!share to:home")).toBeUndefined(); // missing note
    expect(parseCommand("!share to:")).toBeUndefined(); // empty alias
  });
});
