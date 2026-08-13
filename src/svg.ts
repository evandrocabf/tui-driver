/**
 * Drawing a parsed screen as SVG.
 *
 * Self-contained and dependency-free, which is what makes `--svg` work anywhere and gives the PNG
 * path something to rasterise. Text is positioned per run with an explicit `textLength`, so the
 * grid stays aligned whatever font the viewer actually resolves.
 */

import type { ParsedScreen, StyledRun } from "./ansi.js";
import { resolveStyleColors, type Theme } from "./theme.js";

/** Where to draw the cursor block. */
export interface CursorPosition {
  /** Zero-based column. */
  x: number;
  /** Zero-based row. */
  y: number;
  /** When false, nothing is drawn. */
  visible: boolean;
}

/** Everything the renderer needs beyond the screen itself. */
export interface SvgOptions {
  /** Palette to resolve colours against. */
  theme: Theme;
  /** Screen width in columns. */
  cols: number;
  /** Screen height in rows. */
  rows: number;
  /** Cell font size in px. */
  fontSize: number;
  /** Font stack to request. */
  fontFamily: string;
  /** Border around the screen in px. */
  padding: number;
  /** Cursor to draw, if the application is showing one. */
  cursor?: CursorPosition;
  /** Accessible title element for the document. */
  title?: string;
}

/**
 * The monospace stack requested by default.
 *
 * Ordered to find a real monospace face on Linux, macOS and Windows in turn, ending at the generic
 * keyword so something always resolves.
 */
export const DEFAULT_FONT_FAMILY =
  "'Noto Sans Mono','DejaVu Sans Mono','Liberation Mono','Menlo','Consolas',monospace";

/**
 * Cell geometry as fractions of the font size.
 *
 * Fixed rather than measured, because there is no font metrics engine here and the rasterizers
 * disagree about which face they resolve. `textLength` on each run makes the actual glyphs fit the
 * grid these ratios define, so alignment holds even when the font does not match.
 */
const ADVANCE_RATIO = 0.6;
const LINE_HEIGHT_RATIO = 1.2;
const BASELINE_RATIO = 0.79;

/** The image size a screen of this shape will occupy, before any scale factor. */
export function svgDimensions(
  cols: number,
  rows: number,
  fontSize: number,
  padding: number,
): { width: number; height: number } {
  return {
    width: cols * fontSize * ADVANCE_RATIO + padding * 2,
    height: rows * fontSize * LINE_HEIGHT_RATIO + padding * 2,
  };
}

/** Escape text for an XML attribute or text node. */
export function escapeXml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Format a coordinate compactly: integers bare, everything else to two decimals with no trailing zeros. */
function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Render a parsed screen as a complete SVG document.
 *
 * Drawn in layers so overlaps come out right: backgrounds first, then the cursor block, then text,
 * then underline and strikethrough rules on top. Backgrounds that are the theme default are skipped
 * entirely rather than painted, which is most of what keeps the document small.
 */
export function renderScreenSvg(screen: ParsedScreen, options: SvgOptions): string {
  const { theme, cols, rows, fontSize, fontFamily, padding } = options;
  const cellWidth = fontSize * ADVANCE_RATIO;
  const cellHeight = fontSize * LINE_HEIGHT_RATIO;
  const width = cols * cellWidth + padding * 2;
  const height = rows * cellHeight + padding * 2;

  const backgrounds: string[] = [];
  const decorations: string[] = [];
  const texts: string[] = [];

  for (let row = 0; row < rows; row += 1) {
    const line = screen.lines[row];
    if (!line) continue;
    const top = padding + row * cellHeight;
    const baseline = top + cellHeight * BASELINE_RATIO;

    let pendingBg: { start: number; end: number; color: string } | undefined;
    const flushBg = (): void => {
      if (!pendingBg) return;
      const x = padding + pendingBg.start * cellWidth;
      const boxWidth = (pendingBg.end - pendingBg.start) * cellWidth;
      backgrounds.push(
        `<rect x="${round(x)}" y="${round(top)}" width="${round(boxWidth)}" height="${round(cellHeight)}" fill="${pendingBg.color}"/>`,
      );
      pendingBg = undefined;
    };

    for (const run of line.runs) {
      const colors = resolveStyleColors(run.style, theme);
      if (!colors.bgIsDefault) {
        if (pendingBg?.end === run.col && pendingBg.color === colors.bg) {
          pendingBg.end = run.col + run.width;
        } else {
          flushBg();
          pendingBg = { start: run.col, end: run.col + run.width, color: colors.bg };
        }
      } else {
        flushBg();
      }

      if (run.text.trim() !== "" && !run.style.hidden) {
        texts.push(textElement(run, colors.fg, padding, cellWidth, baseline, options));
      }
      if (run.style.underline) {
        decorations.push(
          lineElement(run, colors.fg, padding, cellWidth, top + cellHeight * 0.92, fontSize),
        );
      }
      if (run.style.strike) {
        decorations.push(
          lineElement(run, colors.fg, padding, cellWidth, top + cellHeight * 0.55, fontSize),
        );
      }
    }
    flushBg();
  }

  const cursor = renderCursor(screen, options, cellWidth, cellHeight, padding);
  const titleTag = options.title ? `<title>${escapeXml(options.title)}</title>` : "";

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(width)} ${round(height)}" font-family="${escapeXml(fontFamily)}" font-size="${round(fontSize)}">`,
    titleTag,
    `<rect width="100%" height="100%" fill="${theme.background}"/>`,
    ...backgrounds,
    ...cursor.behind,
    ...decorations,
    ...texts,
    ...cursor.above,
    "</svg>",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

/**
 * One run of text.
 *
 * `textLength` with `lengthAdjust="spacingAndGlyphs"` forces the run into exactly the cells it
 * occupies, which is what keeps columns aligned when the rasterizer picks a different font.
 */
function textElement(
  run: StyledRun,
  fill: string,
  padding: number,
  cellWidth: number,
  baseline: number,
  options: SvgOptions,
): string {
  const x = padding + run.col * cellWidth;
  const attributes = [
    `x="${round(x)}"`,
    `y="${round(baseline)}"`,
    `fill="${fill}"`,
    `xml:space="preserve"`,
    `textLength="${round(run.width * cellWidth)}"`,
    `lengthAdjust="spacingAndGlyphs"`,
  ];
  if (run.style.bold) attributes.push(`font-weight="bold"`);
  if (run.style.italic) attributes.push(`font-style="italic"`);
  if (run.style.blink) attributes.push(`opacity="0.75"`);
  void options;
  return `<text ${attributes.join(" ")}>${escapeXml(run.text)}</text>`;
}

/** A thin rule across a run, used for both underline and strikethrough. */
function lineElement(
  run: StyledRun,
  fill: string,
  padding: number,
  cellWidth: number,
  y: number,
  fontSize: number,
): string {
  const x = padding + run.col * cellWidth;
  const thickness = Math.max(1, fontSize / 14);
  return `<rect x="${round(x)}" y="${round(y)}" width="${round(run.width * cellWidth)}" height="${round(thickness)}" fill="${fill}"/>`;
}

/**
 * The cursor block, and the character beneath it redrawn in the background colour.
 *
 * A solid block would otherwise hide whatever it sits on; a real terminal inverts that cell, and
 * this is the equivalent. Positions outside the screen are ignored rather than clamped, since a
 * cursor reported out of bounds means the capture and the metadata disagree.
 */
function renderCursor(
  screen: ParsedScreen,
  options: SvgOptions,
  cellWidth: number,
  cellHeight: number,
  padding: number,
): { behind: string[]; above: string[] } {
  const cursor = options.cursor;
  if (!cursor?.visible) return { behind: [], above: [] };
  if (cursor.y < 0 || cursor.y >= options.rows) return { behind: [], above: [] };
  if (cursor.x < 0 || cursor.x >= options.cols) return { behind: [], above: [] };

  const x = padding + cursor.x * cellWidth;
  const top = padding + cursor.y * cellHeight;
  const box = `<rect x="${round(x)}" y="${round(top)}" width="${round(cellWidth)}" height="${round(cellHeight)}" fill="${options.theme.cursor}" opacity="0.85"/>`;

  const char = characterAt(screen, cursor.x, cursor.y);
  if (char === undefined || char.trim() === "") return { behind: [], above: [box] };

  const baseline = top + cellHeight * BASELINE_RATIO;
  const glyph = `<text x="${round(x)}" y="${round(baseline)}" fill="${options.theme.background}" xml:space="preserve" textLength="${round(cellWidth)}" lengthAdjust="spacingAndGlyphs">${escapeXml(char)}</text>`;
  return { behind: [], above: [box, glyph] };
}

/** The character drawn at a cell, or `undefined` if that cell is blank. */
function characterAt(screen: ParsedScreen, x: number, y: number): string | undefined {
  const line = screen.lines[y];
  if (!line) return undefined;
  for (const run of line.runs) {
    if (x < run.col || x >= run.col + run.width) continue;
    const characters = [...run.text];
    const offset = x - run.col;
    return characters[offset] ?? characters[0];
  }
  return undefined;
}
