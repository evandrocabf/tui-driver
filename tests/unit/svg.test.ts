import { describe, expect, test } from "bun:test";

import { buildSvg } from "../../src/render.js";
import { svgDimensions } from "../../src/svg.js";
import { paletteColor, resolveTheme } from "../../src/theme.js";

const ESC = "\u001b";

describe("svgDimensions", () => {
  test("derives the pixel box from the cell grid", () => {
    expect(svgDimensions(80, 24, 16, 12)).toEqual({
      width: 80 * 16 * 0.6 + 24,
      height: 24 * 16 * 1.2 + 24,
    });
  });
});

describe("palette", () => {
  test("resolves the 6x6x6 cube and the grey ramp", () => {
    const theme = resolveTheme("dark");
    expect(paletteColor(theme, 1)).toBe(theme.ansi[1] ?? "");
    expect(paletteColor(theme, 16)).toBe("#000000");
    expect(paletteColor(theme, 231)).toBe("#ffffff");
    expect(paletteColor(theme, 232)).toBe("#080808");
  });

  test("rejects unknown themes", () => {
    expect(() => resolveTheme("neon")).toThrow();
  });
});

describe("buildSvg", () => {
  test("emits a sized svg with the theme background", () => {
    const svg = buildSvg("hello", { cols: 10, rows: 2 });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('fill="#1e1e1e"');
    expect(svg).toContain(">hello</text>");
  });

  test("paints background rectangles for coloured cells", () => {
    const svg = buildSvg(`${ESC}[41mAB`, { cols: 4, rows: 1 });
    expect(svg).toContain('fill="#cd3131"');
  });

  test("escapes xml-hostile characters", () => {
    const svg = buildSvg("a<b>&c", { cols: 10, rows: 1 });
    expect(svg).toContain("a&lt;b&gt;&amp;c");
  });

  test("draws the cursor block when visible", () => {
    const withCursor = buildSvg("hi", {
      cols: 4,
      rows: 1,
      cursor: { x: 1, y: 0, visible: true },
    });
    const withoutCursor = buildSvg("hi", {
      cols: 4,
      rows: 1,
      cursor: { x: 1, y: 0, visible: false },
    });
    expect(withCursor.length).toBeGreaterThan(withoutCursor.length);
    expect(withCursor).toContain('opacity="0.85"');
  });

  test("honours the light theme", () => {
    expect(buildSvg("x", { cols: 2, rows: 1, theme: "light" })).toContain('fill="#ffffff"');
  });
});
