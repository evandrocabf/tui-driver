import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";

import { UsageError } from "../../src/errors.js";
import {
  kittyKeySequence,
  mouseClick,
  normalizeKey,
  parseMouseEncoding,
  sendRawBytes,
} from "../../src/input.js";

describe("normalizeKey", () => {
  test("passes single characters through untouched", () => {
    expect(normalizeKey("a")).toBe("a");
    expect(normalizeKey("Q")).toBe("Q");
    expect(normalizeKey("/")).toBe("/");
  });

  test("accepts every spelling of a control chord", () => {
    for (const spelling of ["^c", "C-c", "ctrl+c", "ctrl-c", "control+c", "Ctrl + C"]) {
      expect(normalizeKey(spelling).toLowerCase()).toBe("c-c");
    }
  });

  test("maps alt and shift chords to tmux prefixes", () => {
    expect(normalizeKey("alt+x")).toBe("M-x");
    expect(normalizeKey("meta+x")).toBe("M-x");
    expect(normalizeKey("shift+tab")).toBe("S-Tab");
  });

  test("translates friendly names to tmux key names", () => {
    expect(normalizeKey("esc")).toBe("Escape");
    expect(normalizeKey("enter")).toBe("Enter");
    expect(normalizeKey("backspace")).toBe("BSpace");
    expect(normalizeKey("del")).toBe("DC");
    expect(normalizeKey("pgup")).toBe("PPage");
    expect(normalizeKey("pagedown")).toBe("NPage");
    expect(normalizeKey("space")).toBe("Space");
    expect(normalizeKey("down")).toBe("Down");
    expect(normalizeKey("backtab")).toBe("BTab");
  });

  test("normalises function keys", () => {
    expect(normalizeKey("f5")).toBe("F5");
    expect(normalizeKey("F12")).toBe("F12");
  });

  test("leaves unrecognised tmux key names alone", () => {
    expect(normalizeKey("KP1")).toBe("KP1");
    expect(normalizeKey("Home")).toBe("Home");
  });

  test("trims surrounding whitespace and rejects an empty key", () => {
    expect(normalizeKey("  Tab  ")).toBe("Tab");
    expect(() => normalizeKey("   ")).toThrow(UsageError);
  });
});

describe("exact input protocols", () => {
  test("encodes Kitty press, repeat and release with modifiers", () => {
    expect(Buffer.from(kittyKeySequence(65, ["shift", "ctrl"], "repeat")).toString()).toBe(
      "\u001b[65;6:2u",
    );
    expect(Buffer.from(kittyKeySequence(65, [], "release")).toString()).toBe("\u001b[65;1:3u");
  });

  test("validates key modifiers, code points and mouse encodings", () => {
    expect(() => kittyKeySequence(-1)).toThrow();
    expect(() => kittyKeySequence(65, ["banana"])).toThrow();
    expect(parseMouseEncoding("sgr")).toBe("sgr");
    expect(() => parseMouseEncoding("guess")).toThrow();
  });

  test("rejects malformed raw input and mouse gestures before contacting tmux", async () => {
    await assert.rejects(sendRawBytes("unused", [[]]), /cannot be empty/);
    await assert.rejects(sendRawBytes("unused", [[256]]), /0 to 255/);
    await assert.rejects(
      mouseClick("unused", -1, 0, "left", { ctrl: false, alt: false, shift: false }),
      /non-negative integers/,
    );
    await assert.rejects(
      mouseClick(
        "unused",
        0,
        0,
        "left",
        { ctrl: false, alt: false, shift: false },
        {
          count: 0,
          force: true,
          modes: {
            any: false,
            standard: false,
            button: false,
            all: false,
            sgr: false,
            utf8: false,
          },
        },
      ),
      /positive integer/,
    );
  });
});
