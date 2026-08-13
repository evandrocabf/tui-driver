/**
 * Turning a {@link Snapshot} into the text an agent reads.
 *
 * Every capture is framed by a header rule that names the session, its size, the cursor, the
 * process, the mouse modes and how long it has been running — everything needed to tell "the app
 * has not drawn yet" from "the app drew this" without a second command.
 */

import type { Snapshot } from "./capture.js";
import { describeModes } from "./mouse.js";
import { formatElapsed } from "./util.js";

/** How to present a snapshot. */
export interface SnapshotViewOptions {
  /** Print the screen alone, with no header or footer rule. */
  raw?: boolean;
  /** Show the screen with its ANSI escapes rather than as plain text. */
  ansi?: boolean;
  /** Prefix rows and columns with their numbers, for aiming a click. */
  ruler?: boolean;
  /** Files written alongside this capture, listed in the footer. */
  savedPaths?: string[];
  /** An extra note for the footer, such as the session's remaining lease. */
  note?: string;
}

/** A horizontal rule with a label set into it: `── app · 80x24 ──────`. */
function rule(label: string, width: number): string {
  const text = ` ${label} `;
  return `──${text}${"─".repeat(Math.max(0, width - text.length - 2))}`;
}

/**
 * The one-line summary that heads every capture.
 *
 * Reads as `app · 120x32 · cursor 4,10 · vim · mouse button-event(1002)/sgr(1006) · +2.2s`, with
 * `alt-screen` and `EXITED(n)` appended when they apply. Agents are told to check this line first:
 * it answers "is it still running", "does it take the mouse" and "how big is it" at a glance.
 */
export function snapshotHeadline(snapshot: Snapshot): string {
  const parts = [
    snapshot.session,
    `${snapshot.cols}x${snapshot.rows}`,
    `cursor ${snapshot.cursor.x},${snapshot.cursor.y}${snapshot.cursor.visible ? "" : " (hidden)"}`,
    snapshot.command === "" ? "?" : snapshot.command,
    `mouse ${describeModes(snapshot.mouse)}`,
    `+${formatElapsed(snapshot.elapsedMs)}`,
  ];
  if (snapshot.alternateScreen) parts.push("alt-screen");
  if (snapshot.dead) parts.push(`EXITED(${snapshot.exitStatus ?? "?"})`);
  return parts.join(" · ");
}

/**
 * Add row and column numbers around a screen.
 *
 * Two header rows carry the column numbers (tens above ones, so column 34 reads as `3` over `4`)
 * and a left gutter carries the row number. Coordinates are zero-based, matching every other part
 * of the tool.
 */
export function withRuler(text: string, cols: number): string {
  const lines = text.split("\n");
  const gutter = String(Math.max(0, lines.length - 1)).length;
  const pad = " ".repeat(gutter + 1);

  const tens: string[] = [];
  const ones: string[] = [];
  for (let column = 0; column < cols; column += 1) {
    tens.push(column % 10 === 0 ? String(Math.floor(column / 10) % 10) : " ");
    ones.push(String(column % 10));
  }

  const body = lines.map((line, index) => `${String(index).padStart(gutter, " ")} │${line}`);

  return [`${pad}│${tens.join("")}`, `${pad}│${ones.join("")}`, ...body].join("\n");
}

/**
 * Format a snapshot for the terminal: header rule, screen, footer rule.
 *
 * The rules are clamped to a sane width so a very wide or very narrow pane still produces something
 * readable in the caller's own terminal.
 */
export function renderSnapshot(snapshot: Snapshot, options: SnapshotViewOptions = {}): string {
  const body = options.ansi ? snapshot.ansi : snapshot.text;
  if (options.raw) return body;

  const width = Math.max(40, Math.min(snapshot.cols, 200));
  const lines = [rule(snapshotHeadline(snapshot), width)];
  lines.push(options.ruler ? withRuler(body, snapshot.cols) : body);

  const footerParts: string[] = [];
  if (options.savedPaths && options.savedPaths.length > 0) {
    footerParts.push(options.savedPaths.join("  "));
  }
  if (options.note) footerParts.push(options.note);
  lines.push(footerParts.length > 0 ? rule(footerParts.join(" · "), width) : "─".repeat(width));

  return lines.join("\n");
}

/**
 * Serialise a snapshot for `--json`, merging in any command-specific fields.
 *
 * @param extra - Additional keys to include, such as the paths a `snap` wrote.
 */
export function snapshotToJson(snapshot: Snapshot, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...snapshot, ...extra }, null, 2);
}

/**
 * Lay out rows as a column-aligned table, two spaces between columns.
 *
 * The last cell in each row is left unpadded so trailing whitespace never ends up in the output —
 * it would otherwise show up in every `tui ls` and `tui doctor` line.
 */
export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, index) =>
          index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? cell.length),
        )
        .join("  "),
    )
    .join("\n");
}
