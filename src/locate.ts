/**
 * Finding text on a captured screen and turning it into coordinates.
 *
 * This is what makes `tui click --text "Save"` possible, and it is the preferred way to aim at a
 * TUI: a label survives layout changes that hard-coded row/column numbers do not.
 */

import { stringWidth } from "./ansi.js";
import { UsageError } from "./errors.js";

/** One occurrence of a pattern on the screen, in cell coordinates. */
export interface ScreenMatch {
  /** Zero-based row. */
  row: number;
  /** Zero-based column of the match's first cell. */
  col: number;
  /** How many cells the match occupies, counting double-width glyphs as two. */
  width: number;
  /** The matched text itself. */
  text: string;
  /**
   * Zero-based column of the match's middle cell — where a click lands by default, since the centre
   * of a label is the part most reliably inside a button's hit area.
   */
  centerCol: number;
}

/** How to interpret the pattern and which matches to keep. */
export interface LocateOptions {
  /** Treat the pattern as a regular expression rather than literal text. */
  regex?: boolean;
  /** Match case-insensitively. */
  ignoreCase?: boolean;
  /** Collect every match instead of stopping at the first. */
  all?: boolean;
  /** Select the nth match, negative counting from the end. Implies scanning them all. */
  nth?: number;
}

/**
 * Compile a search pattern into a regular expression.
 *
 * Literal patterns are escaped, so text containing `.` or `(` matches itself rather than quietly
 * behaving as a regex — screens are full of punctuation, and the surprising case is the one that
 * silently matches the wrong cell.
 *
 * @throws {UsageError} If `regex` was requested and the pattern does not compile.
 */
export function buildMatcher(pattern: string, options: LocateOptions): RegExp {
  const flags = options.ignoreCase ? "giu" : "gu";
  if (options.regex) {
    try {
      return new RegExp(pattern, flags);
    } catch (error) {
      throw new UsageError(`invalid regex ${pattern}: ${(error as Error).message}`);
    }
  }
  return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
}

/**
 * Find a pattern on a screen and report where it is drawn.
 *
 * Columns are measured in display cells rather than string offsets, so a row containing CJK or
 * other double-width glyphs still yields coordinates that a mouse event can be aimed at. Matches
 * are returned in reading order, top to bottom then left to right.
 *
 * Scanning stops at the first match unless `all` or `nth` asks for more, because the common case is
 * a single label and there is no reason to walk the rest of the screen for it.
 *
 * @param text - The captured screen, as plain text with `\n` between rows.
 * @param pattern - Literal text, or a regular expression when `options.regex` is set.
 */
export function locate(text: string, pattern: string, options: LocateOptions = {}): ScreenMatch[] {
  const matcher = buildMatcher(pattern, options);
  const matches: ScreenMatch[] = [];
  const lines = text.split("\n");

  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? "";
    matcher.lastIndex = 0;
    let found = matcher.exec(line);
    while (found) {
      const value = found[0];
      const col = stringWidth(line.slice(0, found.index));
      const width = stringWidth(value);
      matches.push({
        row,
        col,
        width,
        text: value,
        centerCol: col + Math.max(0, Math.floor((width - 1) / 2)),
      });
      if (!options.all && options.nth === undefined) return matches;
      /* A zero-length match (an empty regex alternative) would otherwise spin here forever. */
      if (found.index === matcher.lastIndex) matcher.lastIndex += 1;
      found = matcher.exec(line);
    }
  }

  return matches;
}

/**
 * Choose one match from a list, as `--nth` selects it.
 *
 * @param nth - Zero-based index, or negative to count back from the last match. `undefined` takes
 * the first. Returns `undefined` when the index falls outside the list, which the caller reports as
 * "no match" rather than clicking somewhere arbitrary.
 */
export function pickMatch(
  matches: ScreenMatch[],
  nth: number | undefined,
): ScreenMatch | undefined {
  if (matches.length === 0) return undefined;
  if (nth === undefined) return matches[0];
  const index = nth < 0 ? matches.length + nth : nth;
  return matches[index];
}
