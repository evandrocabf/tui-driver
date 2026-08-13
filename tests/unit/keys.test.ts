import { describe, expect, test } from "bun:test";

import { UsageError } from "../../src/errors.js";
import { normalizeKey } from "../../src/input.js";

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
