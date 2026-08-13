import { describe, expect, test } from "bun:test";

import { renderSnapshot, snapshotHeadline, table, withRuler } from "../../src/format.js";
import { makeSnapshot as snapshot } from "../helpers/tui.js";

describe("snapshotHeadline", () => {
  test("summarises size, cursor, command, mouse mode and age", () => {
    expect(snapshotHeadline(snapshot())).toBe(
      "app · 64x3 · cursor 4,1 · python3 · mouse button-event(1002)/sgr(1006) · +2.2s",
    );
  });

  test("flags a hidden cursor, the alternate screen and a dead pane", () => {
    const headline = snapshotHeadline(
      snapshot({
        cursor: { x: 0, y: 0, visible: false },
        alternateScreen: true,
        dead: true,
        exitStatus: 2,
      }),
    );
    expect(headline).toContain("cursor 0,0 (hidden)");
    expect(headline).toContain("alt-screen");
    expect(headline).toContain("EXITED(2)");
  });

  test("says mouse off when the TUI never enabled reporting", () => {
    const headline = snapshotHeadline(
      snapshot({
        mouse: { any: false, standard: false, button: false, all: false, sgr: false, utf8: false },
      }),
    );
    expect(headline).toContain("mouse off");
  });
});

describe("withRuler", () => {
  test("prefixes column and row numbers", () => {
    const lines = withRuler("ab\ncd", 3).split("\n");
    expect(lines[0]).toBe("  │0  ");
    expect(lines[1]).toBe("  │012");
    expect(lines[2]).toBe("0 │ab");
    expect(lines[3]).toBe("1 │cd");
  });

  test("widens the gutter for screens with more than ten rows", () => {
    const lines = withRuler(Array.from({ length: 12 }, (_, row) => `r${row}`).join("\n"), 2);
    expect(lines.split("\n")[2]).toBe(" 0 │r0");
    expect(lines.split("\n").at(-1)).toBe("11 │r11");
  });
});

describe("renderSnapshot", () => {
  test("wraps the screen in a header and footer rule", () => {
    const rendered = renderSnapshot(snapshot());
    expect(rendered.split("\n")[0]).toContain("app · 64x3");
    expect(rendered).toContain("hello");
  });

  test("raw drops the rules entirely", () => {
    expect(renderSnapshot(snapshot(), { raw: true })).toBe("hello");
  });

  test("notes and saved paths land in the footer", () => {
    const rendered = renderSnapshot(snapshot(), { note: "clicked", savedPaths: ["/tmp/a.txt"] });
    expect(rendered).toContain("clicked");
    expect(rendered).toContain("/tmp/a.txt");
  });

  test("ansi prints the escape-bearing body instead of the plain text", () => {
    const rendered = renderSnapshot(snapshot({ ansi: "[31mred" }), { ansi: true });
    expect(rendered).toContain("[31mred");
  });
});

describe("table", () => {
  test("pads every column but the last", () => {
    expect(
      table([
        ["NAME", "SIZE"],
        ["a", "64x14"],
        ["longer", "80x24"],
      ]),
    ).toBe(["NAME    SIZE", "a       64x14", "longer  80x24"].join("\n"));
  });

  test("returns an empty string for no rows", () => {
    expect(table([])).toBe("");
  });
});
