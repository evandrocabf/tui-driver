import { describe, expect, test } from "bun:test";

import {
  clickSequence,
  describeModes,
  encodeMouseEvent,
  legacyOutOfRange,
  NO_MODIFIERS,
  parseButton,
  parseModifiers,
  pickEncoding,
  toHexArgs,
  type MouseModes,
} from "../../src/mouse.js";

const ESC = 0x1b;

function decode(bytes: number[]): string {
  return Buffer.from(bytes).toString("utf8");
}

const MODES_OFF: MouseModes = {
  any: false,
  standard: false,
  button: false,
  all: false,
  sgr: false,
  utf8: false,
};

describe("sgr encoding", () => {
  test("press and release use 1-based coordinates and M/m finals", () => {
    const press = encodeMouseEvent(
      { x: 10, y: 5, button: "left", action: "press", modifiers: NO_MODIFIERS },
      "sgr",
    );
    const release = encodeMouseEvent(
      { x: 10, y: 5, button: "left", action: "release", modifiers: NO_MODIFIERS },
      "sgr",
    );
    expect(press[0]).toBe(ESC);
    expect(decode(press)).toBe("\u001b[<0;11;6M");
    expect(decode(release)).toBe("\u001b[<0;11;6m");
  });

  test("buttons map to 0, 1 and 2", () => {
    const middle = encodeMouseEvent(
      { x: 0, y: 0, button: "middle", action: "press", modifiers: NO_MODIFIERS },
      "sgr",
    );
    const right = encodeMouseEvent(
      { x: 0, y: 0, button: "right", action: "press", modifiers: NO_MODIFIERS },
      "sgr",
    );
    expect(decode(middle)).toBe("\u001b[<1;1;1M");
    expect(decode(right)).toBe("\u001b[<2;1;1M");
  });

  test("modifiers add shift 4, alt 8 and ctrl 16", () => {
    const event = encodeMouseEvent(
      {
        x: 3,
        y: 3,
        button: "left",
        action: "press",
        modifiers: { shift: true, alt: true, ctrl: true },
      },
      "sgr",
    );
    expect(decode(event)).toBe("\u001b[<28;4;4M");
  });

  test("motion adds 32 and reports button 3 when nothing is held", () => {
    const event = encodeMouseEvent(
      { x: 20, y: 6, button: "none", action: "motion", modifiers: NO_MODIFIERS },
      "sgr",
    );
    expect(decode(event)).toBe("\u001b[<35;21;7M");
  });

  test("wheel up is 64 and wheel down is 65 with no release", () => {
    const up = encodeMouseEvent(
      { x: 5, y: 5, button: "wheel-up", action: "press", modifiers: NO_MODIFIERS },
      "sgr",
    );
    expect(decode(up)).toBe("\u001b[<64;6;6M");
    expect(clickSequence(5, 5, "wheel-down", NO_MODIFIERS, "sgr")).toHaveLength(1);
    expect(clickSequence(5, 5, "left", NO_MODIFIERS, "sgr")).toHaveLength(2);
  });
});

describe("legacy x10 encoding", () => {
  test("uses ESC [ M with values offset by 32", () => {
    const event = encodeMouseEvent(
      { x: 10, y: 5, button: "left", action: "press", modifiers: NO_MODIFIERS },
      "x10",
    );
    expect(event).toEqual([0x1b, 0x5b, 0x4d, 32, 43, 38]);
  });

  test("release reports button 3", () => {
    const event = encodeMouseEvent(
      { x: 0, y: 0, button: "left", action: "release", modifiers: NO_MODIFIERS },
      "x10",
    );
    expect(event[3]).toBe(35);
  });

  test("flags coordinates beyond the single byte range", () => {
    const spec = {
      x: 200,
      y: 1,
      button: "left" as const,
      action: "press" as const,
      modifiers: NO_MODIFIERS,
    };
    expect(legacyOutOfRange(spec, "x10")).toBe(true);
    expect(legacyOutOfRange(spec, "sgr")).toBe(false);
  });
});

describe("protocol selection", () => {
  test("prefers sgr, then utf8, then x10", () => {
    expect(pickEncoding({ ...MODES_OFF, any: true, sgr: true })).toBe("sgr");
    expect(pickEncoding({ ...MODES_OFF, any: true, utf8: true })).toBe("utf8");
    expect(pickEncoding({ ...MODES_OFF, any: true, standard: true })).toBe("x10");
  });

  test("describes what the TUI enabled", () => {
    expect(describeModes(MODES_OFF)).toBe("off");
    expect(describeModes({ ...MODES_OFF, any: true, button: true, sgr: true })).toBe(
      "button-event(1002)/sgr(1006)",
    );
  });
});

describe("parsing helpers", () => {
  test("accepts friendly button names", () => {
    expect(parseButton(undefined)).toBe("left");
    expect(parseButton("r")).toBe("right");
    expect(parseButton("wheel-up")).toBe("wheel-up");
    expect(() => parseButton("thumb")).toThrow();
  });

  test("accepts comma or plus separated modifiers", () => {
    expect(parseModifiers("ctrl+shift")).toEqual({ shift: true, alt: false, ctrl: true });
    expect(parseModifiers("alt, shift")).toEqual({ shift: true, alt: true, ctrl: false });
    expect(() => parseModifiers("hyper")).toThrow();
  });

  test("renders bytes as two digit hex for tmux send-keys -H", () => {
    expect(toHexArgs([0x1b, 0x5b, 0x00])).toEqual(["1b", "5b", "00"]);
  });
});
