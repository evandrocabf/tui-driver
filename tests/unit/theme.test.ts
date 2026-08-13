import { describe, expect, test } from "bun:test";

import { defaultStyle } from "../../src/ansi.js";
import { UsageError } from "../../src/errors.js";
import {
  DARK_THEME,
  LIGHT_THEME,
  paletteColor,
  resolveStyleColors,
  resolveTheme,
  toHex,
} from "../../src/theme.js";

describe("resolveTheme", () => {
  test("defaults to dark and accepts light", () => {
    expect(resolveTheme(undefined)).toBe(DARK_THEME);
    expect(resolveTheme("")).toBe(DARK_THEME);
    expect(resolveTheme("dark")).toBe(DARK_THEME);
    expect(resolveTheme("light")).toBe(LIGHT_THEME);
  });

  test("rejects anything else", () => {
    expect(() => resolveTheme("solarized")).toThrow(UsageError);
  });
});

describe("paletteColor", () => {
  test("uses the theme for the first sixteen entries", () => {
    expect(paletteColor(DARK_THEME, 1)).toBe(DARK_THEME.ansi[1]!);
    expect(paletteColor(LIGHT_THEME, 15)).toBe(LIGHT_THEME.ansi[15]!);
  });

  test("maps the 6x6x6 colour cube", () => {
    expect(paletteColor(DARK_THEME, 16)).toBe("#000000");
    expect(paletteColor(DARK_THEME, 231)).toBe("#ffffff");
    expect(paletteColor(DARK_THEME, 196)).toBe("#ff0000");
  });

  test("maps the grayscale ramp", () => {
    expect(paletteColor(DARK_THEME, 232)).toBe("#080808");
    expect(paletteColor(DARK_THEME, 255)).toBe("#eeeeee");
  });
});

describe("toHex", () => {
  test("clamps and pads each channel", () => {
    expect(toHex({ r: 0, g: 128, b: 255 })).toBe("#0080ff");
    expect(toHex({ r: -20, g: 300, b: 8 })).toBe("#00ff08");
  });
});

describe("resolveStyleColors", () => {
  test("falls back to the theme's own foreground and background", () => {
    const colors = resolveStyleColors(defaultStyle(), DARK_THEME);
    expect(colors.fg).toBe(DARK_THEME.foreground);
    expect(colors.bg).toBe(DARK_THEME.background);
    expect(colors.bgIsDefault).toBe(true);
  });

  test("reverse swaps the pair and makes the background explicit", () => {
    const colors = resolveStyleColors({ ...defaultStyle(), reverse: true }, DARK_THEME);
    expect(colors.fg).toBe(DARK_THEME.background);
    expect(colors.bg).toBe(DARK_THEME.foreground);
    expect(colors.bgIsDefault).toBe(false);
  });

  test("dim darkens the foreground", () => {
    const plain = resolveStyleColors(defaultStyle(), DARK_THEME);
    const dim = resolveStyleColors({ ...defaultStyle(), dim: true }, DARK_THEME);
    expect(dim.fg).not.toBe(plain.fg);
    expect(Number.parseInt(dim.fg.slice(1, 3), 16)).toBeLessThan(
      Number.parseInt(plain.fg.slice(1, 3), 16),
    );
  });

  test("hidden paints the text in the background colour", () => {
    const colors = resolveStyleColors({ ...defaultStyle(), hidden: true }, DARK_THEME);
    expect(colors.fg).toBe(colors.bg);
  });

  test("resolves indexed and truecolor styles", () => {
    const indexed = resolveStyleColors(
      { ...defaultStyle(), fg: { kind: "index", index: 2 } },
      DARK_THEME,
    );
    expect(indexed.fg).toBe(DARK_THEME.ansi[2]!);

    const rgb = resolveStyleColors(
      { ...defaultStyle(), bg: { kind: "rgb", rgb: { r: 18, g: 52, b: 86 } } },
      DARK_THEME,
    );
    expect(rgb.bg).toBe("#123456");
    expect(rgb.bgIsDefault).toBe(false);
  });
});
