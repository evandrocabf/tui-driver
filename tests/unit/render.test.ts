import { describe, expect, test } from "bun:test";

import { buildSvg } from "../../src/render.js";
import { escapeXml, svgDimensions } from "../../src/svg.js";
import { DARK_THEME, LIGHT_THEME } from "../../src/theme.js";

describe("svgDimensions", () => {
  test("derives the canvas from cell metrics and padding", () => {
    const { width, height } = svgDimensions(80, 24, 16, 12);
    expect(width).toBe(792); /* 80 cells * 16px * 0.6 advance + 2 * 12 padding */
    expect(height).toBeCloseTo(484.8, 5); /* 24 rows * 16px * 1.2 line height + 2 * 12 padding */
    expect(svgDimensions(0, 0, 16, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("escapeXml", () => {
  test("escapes the characters that would break the document", () => {
    expect(escapeXml(`a & b < c > d "e"`)).toBe("a &amp; b &lt; c &gt; d &quot;e&quot;");
  });
});

describe("buildSvg", () => {
  const options = { cols: 12, rows: 2 };

  test("emits a sized document with the theme background", () => {
    const svg = buildSvg("hello", options);
    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg).toContain(`fill="${DARK_THEME.background}"`);
    expect(svg).toContain(">hello</text>");
    expect(svg.endsWith("</svg>")).toBe(true);
  });

  test("honours the light theme", () => {
    expect(buildSvg("hello", { ...options, theme: "light" })).toContain(
      `fill="${LIGHT_THEME.background}"`,
    );
  });

  test("escapes screen content instead of injecting markup", () => {
    const svg = buildSvg("<script>&", options);
    expect(svg).toContain("&lt;script&gt;&amp;");
    expect(svg).not.toContain("<script>");
  });

  test("paints a block for a visible cursor and nothing for a hidden one", () => {
    const visible = buildSvg("hi", { ...options, cursor: { x: 1, y: 0, visible: true } });
    const hidden = buildSvg("hi", { ...options, cursor: { x: 1, y: 0, visible: false } });
    expect(visible).toContain(DARK_THEME.cursor);
    expect(visible.length).toBeGreaterThan(hidden.length);
  });

  test("ignores a cursor parked outside the screen", () => {
    const outside = buildSvg("hi", { ...options, cursor: { x: 99, y: 99, visible: true } });
    const none = buildSvg("hi", options);
    expect(outside).toBe(none);
  });

  test("renders sgr colours, bold, underline and strikethrough", () => {
    const svg = buildSvg("[1;4;9;31mstyled[0m", options);
    expect(svg).toContain(`font-weight="bold"`);
    expect(svg).toContain(DARK_THEME.ansi[1]!);
    /* underline and strike are drawn as thin rects over the run */
    expect(svg.match(/<rect /g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("keeps truecolor backgrounds as written", () => {
    expect(buildSvg("[48;2;18;52;86mbg", options)).toContain(`fill="#123456"`);
  });

  test("pads short screens up to the requested row count", () => {
    const tall = buildSvg("one", { cols: 12, rows: 10 });
    const short = buildSvg("one", { cols: 12, rows: 2 });
    expect(tall).toContain(`height="216"`);
    expect(short).toContain(`height="62.4"`);
  });

  test("carries a title through to the document", () => {
    expect(buildSvg("x", { ...options, title: "app @ now" })).toContain("<title>app @ now</title>");
  });
});
