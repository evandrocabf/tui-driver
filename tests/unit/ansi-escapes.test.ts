import { describe, expect, test } from "bun:test";

import { charWidth, parseAnsiScreen, stringWidth, stripAnsi } from "../../src/ansi.js";
import type { ParsedScreen } from "../../src/ansi.js";

const ESC = "";

/**
 * Flatten a parsed screen back to plain text, padding the gaps between runs.
 *
 * Lives here rather than in `src/`: nothing the CLI does needs it, and an export whose only caller
 * is its own test is dead code with an alibi.
 */
function flatten(screen: ParsedScreen): string {
  return screen.lines
    .map((line) => {
      let out = "";
      let column = 0;
      for (const run of line.runs) {
        if (run.col > column) out += " ".repeat(run.col - column);
        out += run.text;
        column = run.col + run.width;
      }
      return out;
    })
    .join("\n");
}

/** The style of the first run on the first row, which is what most of these assert on. */
function firstStyle(ansi: string) {
  const run = parseAnsiScreen(ansi).lines[0]?.runs[0];
  if (!run) throw new Error(`no run parsed from ${JSON.stringify(ansi)}`);
  return run.style;
}

describe("charWidth range scanning", () => {
  test("returns 1 for a code point below every range", () => {
    /* Exercises the early exit in the sorted-range scan: once the code is below a range's start,
       no later range can contain it. */
    expect(charWidth(0x41)).toBe(1);
    expect(charWidth(0x7e)).toBe(1);
  });

  test("returns 0 for control characters and 2 for wide ones", () => {
    expect(charWidth(0x00)).toBe(0);
    expect(charWidth(0x1b)).toBe(0);
    expect(charWidth(0x7f)).toBe(0);
    expect(charWidth(0x4e00)).toBe(2);
  });

  test("returns 1 for a code point past the end of every range", () => {
    expect(charWidth(0x10fffd)).toBe(1);
  });

  test("stringWidth ignores lone surrogates rather than throwing", () => {
    expect(stringWidth("ok")).toBe(2);
  });
});

describe("SGR parsing", () => {
  test("a bare reset clears every attribute", () => {
    /* `ESC[m` with no parameters is a reset, the same as `ESC[0m`. */
    const style = firstStyle(`${ESC}[1;3;4;7m${ESC}[mplain`);
    expect(style.bold).toBe(false);
    expect(style.italic).toBe(false);
    expect(style.underline).toBe(false);
    expect(style.reverse).toBe(false);
  });

  test("21 and 22 clear bold and dim together", () => {
    expect(firstStyle(`${ESC}[1;2m${ESC}[22mx`).bold).toBe(false);
    expect(firstStyle(`${ESC}[1;2m${ESC}[22mx`).dim).toBe(false);
    expect(firstStyle(`${ESC}[1;2m${ESC}[21mx`).bold).toBe(false);
  });

  test("23, 24 and 25 clear italic, underline and blink", () => {
    const style = firstStyle(`${ESC}[3;4;5m${ESC}[23m${ESC}[24m${ESC}[25mx`);
    expect(style.italic).toBe(false);
    expect(style.underline).toBe(false);
    expect(style.blink).toBe(false);
  });

  test("bright foreground and background use the 90/100 ranges", () => {
    expect(firstStyle(`${ESC}[92mx`).fg).toEqual({ kind: "index", index: 10 });
    expect(firstStyle(`${ESC}[102mx`).bg).toEqual({ kind: "index", index: 10 });
  });

  test("49 restores the default background", () => {
    expect(firstStyle(`${ESC}[41m${ESC}[49mx`).bg).toEqual({ kind: "default" });
  });

  test("58 (underline colour) consumes its arguments without corrupting what follows", () => {
    /* The colour itself is not rendered, but its parameters must be skipped or the tokens after it
       are read as unrelated attributes. */
    const style = firstStyle(`${ESC}[58;2;10;20;30;1mx`);
    expect(style.bold).toBe(true);
  });

  test("a malformed extended colour is ignored rather than throwing", () => {
    expect(firstStyle(`${ESC}[38;2;notanumbermx`).fg).toEqual({ kind: "default" });
    expect(firstStyle(`${ESC}[38;9;1mx`).fg).toEqual({ kind: "default" });
  });

  test("colon-delimited extended colours are accepted in both forms", () => {
    /* Some terminals emit `38:5:n` and `38:2::r:g:b` instead of the semicolon form. */
    expect(firstStyle(`${ESC}[38:5:200mx`).fg).toEqual({ kind: "index", index: 200 });
    expect(firstStyle(`${ESC}[38:2::10:20:30mx`).fg).toEqual({
      kind: "rgb",
      rgb: { r: 10, g: 20, b: 30 },
    });
  });

  test("channels outside 0-255 are clamped", () => {
    expect(firstStyle(`${ESC}[38;2;999;-5;30mx`).fg).toEqual({
      kind: "rgb",
      rgb: { r: 255, g: 0, b: 30 },
    });
  });
});

describe("escape sequences that are not SGR", () => {
  test("an OSC string terminated by BEL is skipped whole", () => {
    const screen = parseAnsiScreen(`${ESC}]0;window titlevisible`);
    expect(flatten(screen)).toBe("visible");
  });

  test("an OSC string terminated by ST is skipped whole", () => {
    const screen = parseAnsiScreen(`${ESC}]0;window title${ESC}\\visible`);
    expect(flatten(screen)).toBe("visible");
  });

  test("an unterminated OSC string consumes the rest of the line", () => {
    expect(flatten(parseAnsiScreen(`before${ESC}]0;never ends`))).toBe("before");
  });

  test("a two-character escape is skipped", () => {
    expect(flatten(parseAnsiScreen(`${ESC}(Bplain`))).toBe("plain");
  });

  test("a non-SGR CSI sequence is skipped without applying a style", () => {
    expect(flatten(parseAnsiScreen(`${ESC}[2Jcleared`))).toBe("cleared");
  });

  test("stripAnsi removes each of those forms", () => {
    expect(stripAnsi(`${ESC}[1mbold${ESC}[0m`)).toBe("bold");
    expect(stripAnsi(`${ESC}]0;titletext`)).toBe("text");
    expect(stripAnsi(`${ESC}(Btext`)).toBe("text");
  });
});

describe("cell layout", () => {
  test("zero-width marks attach to the run already in progress", () => {
    /* A combining accent occupies no cell, so it belongs to the preceding character's run rather
       than starting a new one or shifting every column after it. */
    const screen = parseAnsiScreen("éx");
    expect(screen.lines[0]?.runs).toHaveLength(1);
    expect(flatten(screen)).toBe("éx");
    expect(stringWidth("éx")).toBe(2);
  });

  test("a leading zero-width character with no run yet is dropped", () => {
    expect(flatten(parseAnsiScreen("́"))).toBe("");
  });

  test("a double-width glyph starts its own run and advances two columns", () => {
    const runs = parseAnsiScreen("a漢b").lines[0]?.runs ?? [];
    const wide = runs.find((run) => run.text === "漢");
    expect(wide?.width).toBe(2);
    expect(runs.at(-1)?.col).toBe(3);
  });

  test("an astral-plane character is read as one code point", () => {
    const runs = parseAnsiScreen("😀").lines[0]?.runs ?? [];
    expect(runs[0]?.text).toBe("😀");
    expect(runs[0]?.width).toBe(2);
  });

  test("a style change splits a run", () => {
    const runs = parseAnsiScreen(`ab${ESC}[31mcd`).lines[0]?.runs ?? [];
    expect(runs).toHaveLength(2);
    expect(runs[1]?.col).toBe(2);
  });

  test("style does not carry across rows", () => {
    /* capture-pane -e resets SGR at the start of every line, so the parser must too — otherwise
       the last colour of one row bleeds into the start of the next. */
    const screen = parseAnsiScreen(`${ESC}[31mred\nplain`);
    expect(screen.lines[1]?.runs[0]?.style.fg).toEqual({ kind: "default" });
  });

  test("a trailing carriage return is stripped from each row", () => {
    expect(flatten(parseAnsiScreen("one\r\ntwo\r"))).toBe("one\ntwo");
  });

  test("the width is inferred from the widest row when not supplied", () => {
    expect(parseAnsiScreen("ab\nabcd").cols).toBe(4);
  });

  test("an explicit width overrides the inferred one", () => {
    expect(parseAnsiScreen("ab", 80).cols).toBe(80);
  });

  test("a trailing blank line is dropped", () => {
    expect(parseAnsiScreen("one\n").rows).toBe(1);
  });
});
