/**
 * Rendering a captured screen to an image.
 *
 * The pipeline is ANSI → SVG → PNG. The SVG half is self-contained and needs nothing installed; the
 * PNG half shells out to whichever rasterizer is available. That split is why `--svg` always works
 * and a missing rasterizer is only a warning.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { parseAnsiScreen } from "./ansi.js";
import type { CursorState } from "./capture.js";
import { svgToPng, type PngBackend } from "./png.js";
import { DEFAULT_FONT_FAMILY, renderScreenSvg, svgDimensions } from "./svg.js";
import { resolveTheme } from "./theme.js";
import { ensureDir } from "./util.js";

/** Which image format to produce. */
export type RenderFormat = "png" | "svg";

/** How to draw the screen. */
export interface RenderOptions {
  /** Screen width in columns. */
  cols: number;
  /** Screen height in rows. */
  rows: number;
  /** Draw the cursor block here, when the application is showing it. */
  cursor?: CursorState;
  /** Palette name: `dark` (default) or `light`. */
  theme?: string;
  /** Cell font size in px. */
  fontSize?: number;
  /** Border around the screen in px. */
  padding?: number;
  /** Pixel scale factor for PNG output; ignored for SVG, which scales on its own. */
  scale?: number;
  /** Output format. Inferred from the file extension when omitted. */
  format?: RenderFormat;
  /** Monospace font stack for the SVG. */
  fontFamily?: string;
  /** Accessible title embedded in the SVG. */
  title?: string;
}

/** What was written, and how. */
export interface RenderResult {
  /** Where the image was written. */
  path: string;
  format: RenderFormat;
  /** Image width in px, before {@link RenderOptions.scale}. */
  width: number;
  /** Image height in px, before {@link RenderOptions.scale}. */
  height: number;
  /** Which external tool rasterised it. Absent for SVG, which needs none. */
  backend?: PngBackend;
}

/** Cell font size in px when none is given. */
const DEFAULT_FONT_SIZE = 16;

/** Border around the screen in px when none is given. */
const DEFAULT_PADDING = 12;

/**
 * Render captured ANSI to an SVG document.
 *
 * tmux stops capturing after the last row with content, so short screens are padded to the full
 * height first — otherwise the image would be cropped to wherever the application last drew.
 */
export function buildSvg(ansi: string, options: RenderOptions): string {
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  const padding = options.padding ?? DEFAULT_PADDING;
  const screen = parseAnsiScreen(ansi, options.cols);
  while (screen.lines.length < options.rows) screen.lines.push({ runs: [] });

  return renderScreenSvg(screen, {
    theme: resolveTheme(options.theme),
    cols: options.cols,
    rows: options.rows,
    fontSize,
    padding,
    fontFamily: options.fontFamily ?? DEFAULT_FONT_FAMILY,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.title ? { title: options.title } : {}),
  });
}

/**
 * Render captured ANSI and write it to a file, creating the directory if needed.
 *
 * @param outPath - Destination. Its extension picks the format unless
 * {@link RenderOptions.format} says otherwise.
 * @throws {DependencyError} For PNG output when no rasterizer is installed.
 */
export async function renderAnsiToFile(
  ansi: string,
  outPath: string,
  options: RenderOptions,
): Promise<RenderResult> {
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  const padding = options.padding ?? DEFAULT_PADDING;
  const format = options.format ?? (outPath.endsWith(".svg") ? "svg" : "png");
  const scale = options.scale ?? 2;
  const svg = buildSvg(ansi, options);
  const { width, height } = svgDimensions(options.cols, options.rows, fontSize, padding);

  await ensureDir(dirname(outPath));

  if (format === "svg") {
    await Bun.write(outPath, svg);
    return { path: outPath, format, width: Math.round(width), height: Math.round(height) };
  }

  /* A private directory rather than a predictable name in the shared temp dir: the intermediate
     SVG holds whatever was on screen, which is not something to leave world-readable. */
  const tempDir = await mkdtemp(join(tmpdir(), "tui-driver-render-"));
  const tempSvg = join(tempDir, "frame.svg");
  await Bun.write(tempSvg, svg);
  try {
    const png = await svgToPng(tempSvg, outPath, { width, height, scale });
    return {
      path: png.path,
      format: "png",
      width: png.width,
      height: png.height,
      backend: png.backend,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
