/**
 * Parsing captured ANSI into styled cells.
 *
 * This is a screen parser, not a terminal emulator: tmux has already done the emulation, and what
 * arrives is the final rendered grid with SGR escapes on it. So there is no cursor addressing,
 * scrolling or clearing to handle — only styles, and how wide each glyph is.
 *
 * One tmux quirk shapes the whole design: `capture-pane -e` resets SGR at the start of every line,
 * so style never carries across rows and each line can be parsed independently.
 */

/** An 8-bit-per-channel colour. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * A cell colour: the terminal default, a 256-colour palette index, or truecolor.
 *
 * "Default" is kept distinct from any concrete colour on purpose — it is what lets the renderer skip
 * painting a background, and what makes the same capture render correctly in both themes.
 */
export type CellColor =
  { kind: "default" } | { kind: "index"; index: number } | { kind: "rgb"; rgb: Rgb };

/** Every SGR attribute this parser tracks, as it applies to one run of text. */
export interface CellStyle {
  /** Text colour. */
  fg: CellColor;
  /** Background colour. */
  bg: CellColor;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  /** Rendered as reduced opacity, since an image cannot blink. */
  blink: boolean;
  /** Swaps foreground and background. This is how a selected row is usually drawn. */
  reverse: boolean;
  /** Text drawn in the background colour, so it is invisible but still occupies its cells. */
  hidden: boolean;
  strike: boolean;
}

/**
 * A run of adjacent characters sharing one style.
 *
 * Runs rather than cells: a row of 200 identically-styled characters is one run, which keeps both
 * the parse and the generated SVG small.
 */
export interface StyledRun {
  /** Zero-based column where the run starts, in display cells. */
  col: number;
  /** How many cells the run occupies, counting double-width glyphs as two. */
  width: number;
  /** The characters themselves. */
  text: string;
  /** The style they share. */
  style: CellStyle;
}

/** One row of the screen. Gaps between runs are unstyled blank cells. */
export interface ScreenRow {
  runs: StyledRun[];
}

/** A whole screen, parsed into styled runs. */
export interface ParsedScreen {
  /** Width in columns. */
  cols: number;
  /** Height in rows. */
  rows: number;
  /** The rows, top to bottom. */
  lines: ScreenRow[];
}

/** Shared instance for the terminal default colour; treated as immutable. */
const DEFAULT_COLOR: CellColor = { kind: "default" };

/** A fresh style with every attribute off, as SGR 0 leaves it. */
export function defaultStyle(): CellStyle {
  return {
    fg: DEFAULT_COLOR,
    bg: DEFAULT_COLOR,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
    blink: false,
    reverse: false,
    hidden: false,
    strike: false,
  };
}

/** Copy a style, so a run keeps the attributes it had when it was emitted. */
function cloneStyle(style: CellStyle): CellStyle {
  return { ...style };
}

/** Whether two styles are identical, which is what decides if a run can be extended. */
function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return (
    sameColor(a.fg, b.fg) &&
    sameColor(a.bg, b.bg) &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.blink === b.blink &&
    a.reverse === b.reverse &&
    a.hidden === b.hidden &&
    a.strike === b.strike
  );
}

/** Structural comparison of two cell colours. */
function sameColor(a: CellColor, b: CellColor): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "index" && b.kind === "index") return a.index === b.index;
  if (a.kind === "rgb" && b.kind === "rgb") {
    return a.rgb.r === b.rgb.r && a.rgb.g === b.rgb.g && a.rgb.b === b.rgb.b;
  }
  return true;
}

/**
 * Code point ranges that occupy no cells: combining marks, joiners, variation selectors.
 *
 * Sorted ascending, which {@link inRanges} relies on to bail out early.
 */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x05bf, 0x05bf],
  [0x05c1, 0x05c2],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xe0100, 0xe01ef],
];

/**
 * Code point ranges that occupy two cells: CJK, Hangul, emoji and friends.
 *
 * Getting these right is what keeps `find` and `click` aiming at the correct column on a screen
 * containing them. Sorted ascending, as {@link inRanges} requires.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x187f7],
  [0x18800, 0x18cd5],
  [0x1b000, 0x1b2fb],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/** Whether a code point falls in a sorted range list, stopping as soon as it cannot. */
function inRanges(ranges: readonly (readonly [number, number])[], code: number): boolean {
  for (const range of ranges) {
    if (code < range[0]) return false;
    if (code <= range[1]) return true;
  }
  return false;
}

/**
 * How many cells one code point occupies: 0, 1 or 2.
 *
 * Control characters count as zero — they were consumed by the emulator and never took a cell.
 */
export function charWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (inRanges(ZERO_WIDTH_RANGES, codePoint)) return 0;
  if (inRanges(WIDE_RANGES, codePoint)) return 2;
  return 1;
}

/**
 * How many cells a string occupies on screen.
 *
 * This is what makes column coordinates correct rather than string offsets, which is why `locate`
 * measures with it rather than using `String.length`.
 */
export function stringWidth(input: string): number {
  let total = 0;
  for (const char of input) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    total += charWidth(code);
  }
  return total;
}

/**
 * Matches CSI sequences, OSC strings with either terminator, and two-character escapes.
 *
 * The control characters are the point: ESC (\u001b) introduces every sequence and BEL (\u0007)
 * terminates an OSC string, so a pattern for escape sequences cannot avoid them.
 */
/* eslint-disable no-control-regex -- matching control characters is this pattern's whole purpose */
const ANSI_PATTERN =
  /\u001b\[[0-9;:?<>=!]*[ -/]*[@-~]|\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b[ -/]+[0-~]|\u001b[@-Z\\-_]/g;
/* eslint-enable no-control-regex */

/** Remove every escape sequence, leaving the plain text of the screen. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

/**
 * Read an extended colour introduced by SGR 38 or 48.
 *
 * Two forms: `5;<index>` for a palette index, and `2;<r>;<g>;<b>` for truecolor.
 *
 * @returns The colour and the index to resume from, or `undefined` if the sequence is malformed.
 */
function readExtendedColor(
  tokens: readonly string[],
  start: number,
): { color: CellColor; next: number } | undefined {
  const mode = tokens[start + 1];
  if (mode === "5") {
    const index = Number(tokens[start + 2] ?? "");
    if (!Number.isFinite(index)) return undefined;
    return { color: { kind: "index", index: clampByte(index) }, next: start + 2 };
  }
  if (mode === "2") {
    const r = Number(tokens[start + 2] ?? "");
    const g = Number(tokens[start + 3] ?? "");
    const b = Number(tokens[start + 4] ?? "");
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return undefined;
    return {
      color: { kind: "rgb", rgb: { r: clampByte(r), g: clampByte(g), b: clampByte(b) } },
      next: start + 4,
    };
  }
  return undefined;
}

/** Clamp a parsed channel into 0-255, defaulting a malformed one to 0. */
function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Apply a colon-delimited SGR token, the newer form some terminals emit.
 *
 * `38:2::r:g:b` means the same as `38;2;r;g;b`; the parser accepts both because which one arrives
 * depends on the application, not on us.
 */
function applyColonToken(style: CellStyle, token: string): void {
  const parts = token.split(":");
  const head = parts[0] ?? "";
  if (head === "4") {
    style.underline = (parts[1] ?? "1") !== "0";
    return;
  }
  if (head !== "38" && head !== "48") return;
  const mode = parts[1];
  let color: CellColor | undefined;
  if (mode === "5") {
    const index = Number(parts[2] ?? "");
    if (Number.isFinite(index)) color = { kind: "index", index: clampByte(index) };
  } else if (mode === "2") {
    const offset = parts.length >= 6 ? 3 : 2;
    const r = Number(parts[offset] ?? "");
    const g = Number(parts[offset + 1] ?? "");
    const b = Number(parts[offset + 2] ?? "");
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      color = { kind: "rgb", rgb: { r: clampByte(r), g: clampByte(g), b: clampByte(b) } };
    }
  }
  if (!color) return;
  if (head === "38") style.fg = color;
  else style.bg = color;
}

/** Apply one SGR sequence's parameters to a style, mutating it in place. */
function applySgr(style: CellStyle, raw: string): void {
  if (raw === "") {
    Object.assign(style, defaultStyle());
    return;
  }
  const tokens = raw.split(";");
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.includes(":")) {
      applyColonToken(style, token);
      continue;
    }
    const code = token === "" ? 0 : Number(token);
    if (!Number.isFinite(code)) continue;
    if (code === 0) Object.assign(style, defaultStyle());
    else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 3) style.italic = true;
    else if (code === 4) style.underline = true;
    else if (code === 5 || code === 6) style.blink = true;
    else if (code === 7) style.reverse = true;
    else if (code === 8) style.hidden = true;
    else if (code === 9) style.strike = true;
    else if (code === 21 || code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code === 23) style.italic = false;
    else if (code === 24) style.underline = false;
    else if (code === 25) style.blink = false;
    else if (code === 27) style.reverse = false;
    else if (code === 28) style.hidden = false;
    else if (code === 29) style.strike = false;
    else if (code >= 30 && code <= 37) style.fg = { kind: "index", index: code - 30 };
    else if (code === 38) {
      const parsed = readExtendedColor(tokens, index);
      if (parsed) {
        style.fg = parsed.color;
        index = parsed.next;
      }
    } else if (code === 39) style.fg = DEFAULT_COLOR;
    else if (code >= 40 && code <= 47) style.bg = { kind: "index", index: code - 40 };
    else if (code === 48) {
      const parsed = readExtendedColor(tokens, index);
      if (parsed) {
        style.bg = parsed.color;
        index = parsed.next;
      }
    } else if (code === 49) style.bg = DEFAULT_COLOR;
    else if (code === 58) {
      const parsed = readExtendedColor(tokens, index);
      if (parsed) index = parsed.next;
    } else if (code >= 90 && code <= 97) style.fg = { kind: "index", index: code - 90 + 8 };
    else if (code >= 100 && code <= 107) style.bg = { kind: "index", index: code - 100 + 8 };
  }
}

/**
 * Parse captured ANSI into rows of styled runs.
 *
 * Style is reset at the start of every line rather than carried across, mirroring what
 * `capture-pane -e` actually emits — carrying it would bleed the last colour of one row into the
 * start of the next.
 *
 * @param cols - The known screen width. Inferred from the widest row when omitted.
 */
export function parseAnsiScreen(ansi: string, cols?: number): ParsedScreen {
  const rawLines = ansi.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
  const lines: ScreenRow[] = [];
  let widest = 0;

  for (const rawLine of rawLines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const style = defaultStyle();
    const runs: StyledRun[] = [];
    let column = 0;
    let current: StyledRun | undefined;
    let index = 0;

    const flush = (): void => {
      if (current && current.text !== "") runs.push(current);
      current = undefined;
    };

    while (index < line.length) {
      const code = line.charCodeAt(index);
      if (code === 0x1b) {
        const next = line[index + 1];
        if (next === "[") {
          let end = index + 2;
          while (end < line.length) {
            const byte = line.charCodeAt(end);
            if (byte >= 0x40 && byte <= 0x7e) break;
            end += 1;
          }
          if (line[end] === "m") applySgr(style, line.slice(index + 2, end));
          flush();
          index = end + 1;
          continue;
        }
        if (next === "]") {
          let end = index + 2;
          while (end < line.length) {
            if (line.charCodeAt(end) === 0x07) {
              end += 1;
              break;
            }
            if (line.charCodeAt(end) === 0x1b && line[end + 1] === "\\") {
              end += 2;
              break;
            }
            end += 1;
          }
          index = end;
          continue;
        }
        /* An "nF" escape: ESC, one or more intermediate bytes (0x20-0x2F), then a final byte.
           `ESC(B` — select ASCII — is the common one, emitted by ncurses apps and by vim on reset.
           Skipping a blind two bytes would leave its final byte behind as literal screen text, and
           a stray "B" is enough to break a `find` or an `expect`. */
        const nextCode = line.charCodeAt(index + 1);
        if (nextCode >= 0x20 && nextCode <= 0x2f) {
          let end = index + 1;
          while (end < line.length) {
            const byte = line.charCodeAt(end);
            if (byte >= 0x20 && byte <= 0x2f) {
              end += 1;
              continue;
            }
            if (byte >= 0x30 && byte <= 0x7e) end += 1;
            break;
          }
          index = end;
          continue;
        }

        index += 2;
        continue;
      }

      const codePoint = line.codePointAt(index);
      if (codePoint === undefined) break;
      const charLength = codePoint > 0xffff ? 2 : 1;
      const char = line.slice(index, index + charLength);
      const width = charWidth(codePoint);
      index += charLength;

      if (width === 0) {
        if (current) current.text += char;
        continue;
      }
      if (width === 2 || !current || !sameStyle(current.style, style)) {
        flush();
        current = { col: column, width: 0, text: "", style: cloneStyle(style) };
      }
      current.text += char;
      current.width += width;
      column += width;
      if (width === 2) flush();
    }

    flush();
    widest = Math.max(widest, column);
    lines.push({ runs });
  }

  return { cols: cols ?? widest, rows: lines.length, lines };
}
