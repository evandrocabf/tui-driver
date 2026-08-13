/**
 * Row-by-row comparison of two captured screens.
 *
 * A terminal screen is a fixed grid, so rows line up positionally and there is nothing for a
 * Myers-style diff to align — row *n* before is always the counterpart of row *n* after. That makes
 * the comparison exact and cheap, and keeps the output readable as a screen rather than a patch.
 */

/** One row that differs between two screens. */
export interface LineDiff {
  /** Zero-based row index, matching the coordinates used everywhere else. */
  row: number;
  /** The row's content in the earlier screen; empty if that screen was shorter. */
  before: string;
  /** The row's content in the later screen; empty if that screen was shorter. */
  after: string;
}

/** The result of comparing two screens. */
export interface TextDiff {
  /** Only the rows that changed, in top-to-bottom order. */
  changed: LineDiff[];
  /** Row count of the taller of the two screens. */
  totalRows: number;
  /** True when nothing changed, which is what `tui diff` reports as exit code 0. */
  identical: boolean;
}

/**
 * Compare two screens row by row.
 *
 * Screens of different heights are compared to the taller one, with missing rows treated as empty,
 * so a resize shows up as changed rows rather than being silently ignored.
 *
 * @param before - The earlier screen, as plain text with `\n` between rows.
 * @param after - The later screen.
 */
export function diffText(before: string, after: string): TextDiff {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const totalRows = Math.max(beforeLines.length, afterLines.length);
  const changed: LineDiff[] = [];

  for (let row = 0; row < totalRows; row += 1) {
    const left = beforeLines[row] ?? "";
    const right = afterLines[row] ?? "";
    if (left !== right) changed.push({ row, before: left, after: right });
  }

  return { changed, totalRows, identical: changed.length === 0 };
}

/**
 * Render a {@link TextDiff} for the terminal, in the familiar `-`/`+` shape with the row number
 * above each pair.
 */
export function formatDiff(diff: TextDiff): string {
  if (diff.identical) return "screens are identical";
  const lines: string[] = [];
  for (const entry of diff.changed) {
    lines.push(`@ row ${entry.row}`);
    lines.push(`- ${entry.before}`);
    lines.push(`+ ${entry.after}`);
  }
  lines.push(`${diff.changed.length} of ${diff.totalRows} rows differ`);
  return lines.join("\n");
}
