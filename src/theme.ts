/**
 * Colour palettes for rendering, and the rules for turning a parsed cell style into concrete colours.
 *
 * The palettes match VS Code's terminal defaults, so a rendered image looks like the terminal most
 * people are already reading their TUIs in.
 */

import type { CellColor, CellStyle, Rgb } from "./ansi.js";
import { UsageError } from "./errors.js";

/** A palette: the page colours plus the sixteen named ANSI colours. */
export interface Theme {
  /** The name this theme is selected by, as passed to `--theme`. */
  name: string;
  /** The page background, used for cells with no explicit background. */
  background: string;
  /** The default text colour. */
  foreground: string;
  /** Fill colour for the cursor block. */
  cursor: string;
  /** The sixteen ANSI colours: 0-7 normal, 8-15 bright. */
  ansi: readonly string[];
}

/** The default palette. */
export const DARK_THEME: Theme = {
  name: "dark",
  background: "#1e1e1e",
  foreground: "#cccccc",
  cursor: "#cccccc",
  ansi: [
    "#000000",
    "#cd3131",
    "#0dbc79",
    "#e5e510",
    "#2472c8",
    "#bc3fbc",
    "#11a8cd",
    "#e5e5e5",
    "#666666",
    "#f14c4c",
    "#23d18b",
    "#f5f543",
    "#3b8eea",
    "#d670d6",
    "#29b8db",
    "#ffffff",
  ],
};

/** The palette for `--theme light`, for images destined for a white page. */
export const LIGHT_THEME: Theme = {
  name: "light",
  background: "#ffffff",
  foreground: "#333333",
  cursor: "#333333",
  ansi: [
    "#000000",
    "#cd3131",
    "#00bc00",
    "#949800",
    "#0451a5",
    "#bc05bc",
    "#0598bc",
    "#555555",
    "#666666",
    "#cd3131",
    "#14ce14",
    "#b5ba00",
    "#0451a5",
    "#bc05bc",
    "#0598bc",
    "#a5a5a5",
  ],
};

/** The six intensity steps of the 256-colour cube (indices 16-231). */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/**
 * Resolve a `--theme` value, defaulting to dark.
 *
 * @throws {UsageError} On any name other than `dark` or `light`.
 */
export function resolveTheme(name: string | undefined): Theme {
  if (name === undefined || name === "" || name === "dark") return DARK_THEME;
  if (name === "light") return LIGHT_THEME;
  throw new UsageError(`unknown theme: ${name} (use dark or light)`);
}

/**
 * Resolve a 256-colour palette index to a hex colour.
 *
 * The palette is three ranges: 0-15 are the theme's named colours, 16-231 are a 6x6x6 RGB cube, and
 * 232-255 are a 24-step greyscale ramp.
 */
export function paletteColor(theme: Theme, index: number): string {
  if (index < 16) return theme.ansi[index] ?? theme.foreground;
  if (index < 232) {
    const offset = index - 16;
    const r = CUBE_LEVELS[Math.floor(offset / 36) % 6] ?? 0;
    const g = CUBE_LEVELS[Math.floor(offset / 6) % 6] ?? 0;
    const b = CUBE_LEVELS[offset % 6] ?? 0;
    return toHex({ r, g, b });
  }
  const level = 8 + (index - 232) * 10;
  return toHex({ r: level, g: level, b: level });
}

/** Format an RGB triple as `#rrggbb`, clamping and rounding each channel. */
export function toHex(rgb: Rgb): string {
  const part = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

/** Parse `#rrggbb` back into channels, so a resolved colour can be dimmed. */
function hexToRgb(hex: string): Rgb {
  const value = hex.replace("#", "");
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  };
}

/** Resolve one cell colour — default, palette index or truecolor — against a theme. */
function colorToHex(color: CellColor, theme: Theme, fallback: string): string {
  if (color.kind === "default") return fallback;
  if (color.kind === "index") return paletteColor(theme, color.index);
  return toHex(color.rgb);
}

/** Concrete colours for one run of text, after every style attribute has been applied. */
export interface ResolvedColors {
  /** Text colour. */
  fg: string;
  /** Background colour. */
  bg: string;
  /**
   * True when the background is the page default and so need not be painted. The renderer uses this
   * to skip emitting a rectangle per cell, which keeps the SVG small.
   */
  bgIsDefault: boolean;
}

/**
 * Turn a parsed cell style into the two colours to draw with.
 *
 * Order matters and follows the terminal's own: reverse swaps first, then dim darkens whatever
 * foreground resulted, then hidden collapses it onto the background. Applying dim before reverse
 * would darken the wrong half of the pair.
 *
 * Reverse also forces the background to be painted — after a swap it is no longer the page colour,
 * which is exactly how a selected row shows up in a rendered image.
 */
export function resolveStyleColors(style: CellStyle, theme: Theme): ResolvedColors {
  let fg = colorToHex(style.fg, theme, theme.foreground);
  let bg = colorToHex(style.bg, theme, theme.background);
  let bgIsDefault = style.bg.kind === "default";

  if (style.reverse) {
    const swap = fg;
    fg = bg;
    bg = swap;
    bgIsDefault = false;
  }
  if (style.dim) {
    const rgb = hexToRgb(fg);
    fg = toHex({ r: rgb.r * 0.65, g: rgb.g * 0.65, b: rgb.b * 0.65 });
  }
  if (style.hidden) fg = bg;

  return { fg, bg, bgIsDefault };
}
