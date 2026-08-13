import { describe, expect, test } from "bun:test";

import { charWidth, parseAnsiScreen, stringWidth, stripAnsi } from "../../src/ansi.js";

const ESC = "\u001b";

describe("stripAnsi", () => {
  test("removes SGR sequences", () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m plain`)).toBe("red plain");
  });

  test("removes OSC 8 hyperlinks", () => {
    expect(stripAnsi(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\`)).toBe("link");
  });

  test("removes 256 and truecolor sequences", () => {
    expect(stripAnsi(`${ESC}[38;5;196mA${ESC}[48;2;1;2;3mB${ESC}[0m`)).toBe("AB");
  });
});

describe("charWidth", () => {
  test("ascii is one column", () => {
    expect(charWidth("a".codePointAt(0) ?? 0)).toBe(1);
  });

  test("CJK is two columns", () => {
    expect(charWidth("漢".codePointAt(0) ?? 0)).toBe(2);
  });

  test("combining marks take no space", () => {
    expect(charWidth(0x0301)).toBe(0);
  });

  test("box drawing stays narrow", () => {
    for (const char of "─│┌┐└┘├┤┬┴┼═║╔╗") {
      expect(charWidth(char.codePointAt(0) ?? 0)).toBe(1);
    }
  });

  test("stringWidth sums display columns", () => {
    expect(stringWidth("ab漢")).toBe(4);
  });
});

describe("parseAnsiScreen", () => {
  test("splits runs by style and tracks columns", () => {
    const screen = parseAnsiScreen(`ab${ESC}[31mcd${ESC}[0mef`);
    const runs = screen.lines[0]?.runs ?? [];
    expect(runs.map((run) => run.text)).toEqual(["ab", "cd", "ef"]);
    expect(runs.map((run) => run.col)).toEqual([0, 2, 4]);
    expect(runs[1]?.style.fg).toEqual({ kind: "index", index: 1 });
    expect(runs[2]?.style.fg).toEqual({ kind: "default" });
  });

  test("parses truecolor foreground and background", () => {
    const screen = parseAnsiScreen(`${ESC}[38;2;255;120;0m${ESC}[48;5;17mX`);
    const run = screen.lines[0]?.runs[0];
    expect(run?.style.fg).toEqual({ kind: "rgb", rgb: { r: 255, g: 120, b: 0 } });
    expect(run?.style.bg).toEqual({ kind: "index", index: 17 });
  });

  test("parses colon separated colours and curly underline", () => {
    const screen = parseAnsiScreen(`${ESC}[4:3m${ESC}[38:2::10:20:30mY`);
    const run = screen.lines[0]?.runs[0];
    expect(run?.style.underline).toBe(true);
    expect(run?.style.fg).toEqual({ kind: "rgb", rgb: { r: 10, g: 20, b: 30 } });
  });

  test("39 and 49 reset only the colour they own", () => {
    const screen = parseAnsiScreen(`${ESC}[1;31;44mA${ESC}[39mB`);
    const runs = screen.lines[0]?.runs ?? [];
    expect(runs[1]?.style.fg).toEqual({ kind: "default" });
    expect(runs[1]?.style.bg).toEqual({ kind: "index", index: 4 });
    expect(runs[1]?.style.bold).toBe(true);
  });

  test("style does not leak across lines, matching tmux capture", () => {
    const screen = parseAnsiScreen(`${ESC}[31mred\nplain`);
    expect(screen.lines[1]?.runs[0]?.style.fg).toEqual({ kind: "default" });
  });

  test("wide characters advance two columns", () => {
    const screen = parseAnsiScreen("a漢b");
    const runs = screen.lines[0]?.runs ?? [];
    expect(runs.map((run) => run.col)).toEqual([0, 1, 3]);
    expect(runs[1]?.width).toBe(2);
  });

  test("bright colours map to the high palette slots", () => {
    const screen = parseAnsiScreen(`${ESC}[91;104mZ`);
    const run = screen.lines[0]?.runs[0];
    expect(run?.style.fg).toEqual({ kind: "index", index: 9 });
    expect(run?.style.bg).toEqual({ kind: "index", index: 12 });
  });
});
