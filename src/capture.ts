/**
 * Reading the current screen out of a tmux pane.
 *
 * Metadata and screen content are fetched in a *single* tmux invocation
 * (`display-message … ';' capture-pane`), so the cursor position, mouse modes and exit status
 * always describe the exact screen that came back with them. Two calls would let the TUI redraw in
 * between and quietly desynchronise the two halves.
 */

import { stripAnsi } from "./ansi.js";
import { SessionError } from "./errors.js";
import { readMeta } from "./meta.js";
import type { MouseModes } from "./mouse.js";
import { exactTarget, tmux } from "./tmux.js";
import { hashText } from "./util.js";

/** Where the terminal cursor is, and whether the application is showing it. */
export interface CursorState {
  /** Zero-based column. */
  x: number;
  /** Zero-based row. */
  y: number;
  /** False when the application has hidden the cursor, as full-screen TUIs usually do. */
  visible: boolean;
}

/**
 * One complete reading of a pane: what is on screen, plus everything true about it at that instant.
 *
 * This is the unit the whole tool is built on — frames store it, `--json` serialises it, the
 * renderer draws from its `ansi`, and every assertion reads its `text`.
 */
export interface Snapshot {
  /** The session this was captured from. */
  session: string;
  /** Capture time as an ISO-8601 string. */
  capturedAt: string;
  /** Capture time in milliseconds since the epoch. */
  capturedAtMs: number;
  /** How long the session had been running when this was captured. Shown in the header as `+2.2s`. */
  elapsedMs: number;
  /** Pane width in columns. */
  cols: number;
  /** Pane height in rows. */
  rows: number;
  /** Cursor position and visibility. */
  cursor: CursorState;
  /** True once the pane's process has exited. The pane survives it, thanks to `remain-on-exit`. */
  dead: boolean;
  /** The process's exit status, or `undefined` while it is still running. */
  exitStatus: number | undefined;
  /** The command tmux reports as running in the pane, e.g. `vim` or `python3`. */
  command: string;
  /** The pane process's pid. */
  panePid: number;
  /** True when the application is on the alternate screen, as full-screen TUIs are. */
  alternateScreen: boolean;
  /** How many lines of scrollback exist above the visible screen. */
  historySize: number;
  /** Which mouse reporting modes the application has turned on. */
  mouse: MouseModes;
  /** The screen with its ANSI escapes intact. The source of truth, and what images render from. */
  ansi: string;
  /** The screen as plain text, trailing whitespace stripped. What `find`, `wait` and `expect` read. */
  text: string;
  /** Content hash of {@link Snapshot.ansi}, used to tell whether the screen actually changed. */
  hash: string;
}

/** How much of the pane to capture. */
export interface CaptureOptions {
  /** Include this many lines of scrollback above the visible screen. */
  scrollback?: number;
  /** Capture the alternate screen instead of the normal one. */
  alternate?: boolean;
}

/** Field separator for the metadata line. Chosen to be something no tmux format expands to. */
const SEPARATOR = "<|>";

/** Marks the metadata line, so a surprise in tmux's output is detected rather than misparsed. */
const META_SENTINEL = "TUIMETA";

/**
 * The tmux format string that yields everything in a {@link Snapshot} except the screen itself.
 *
 * Field order here is load-bearing: {@link capture} reads the result back by index.
 */
const META_FORMAT = [
  META_SENTINEL,
  "#{pane_width}",
  "#{pane_height}",
  "#{cursor_x}",
  "#{cursor_y}",
  "#{cursor_flag}",
  "#{pane_dead}",
  "#{pane_dead_status}",
  "#{pane_current_command}",
  "#{pane_pid}",
  "#{alternate_on}",
  "#{history_size}",
  "#{mouse_any_flag}",
  "#{mouse_standard_flag}",
  "#{mouse_button_flag}",
  "#{mouse_all_flag}",
  "#{mouse_sgr_flag}",
  "#{mouse_utf8_flag}",
  "#{session_created}",
].join(SEPARATOR);

/** Read one of tmux's boolean format fields. */
function flag(value: string | undefined): boolean {
  return value === "1";
}

/** Read one of tmux's numeric format fields, falling back when it is absent or unparseable. */
function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Capture a session's current screen along with everything true about it at that moment.
 *
 * @param name - The session name.
 * @throws {SessionError} If the session is gone, or tmux answers with something unrecognisable.
 */
export async function capture(name: string, options: CaptureOptions = {}): Promise<Snapshot> {
  const target = `${exactTarget(name)}:`;
  const captureArgs = ["capture-pane", "-p", "-e", "-N", "-t", target];
  if (options.alternate) captureArgs.push("-a");
  if (options.scrollback !== undefined && options.scrollback > 0) {
    captureArgs.push("-S", `-${options.scrollback}`);
  }

  const result = await tmux([
    "display-message",
    "-p",
    "-t",
    target,
    META_FORMAT,
    ";",
    ...captureArgs,
  ]);

  if (result.code !== 0) {
    const detail = result.stderr.trim() || `exit ${result.code}`;
    throw new SessionError(`session "${name}" is not available: ${detail}`);
  }

  const newlineIndex = result.stdout.indexOf("\n");
  const metaLine = newlineIndex >= 0 ? result.stdout.slice(0, newlineIndex) : result.stdout;
  const body = newlineIndex >= 0 ? result.stdout.slice(newlineIndex + 1) : "";
  const fields = metaLine.split(SEPARATOR);

  if (fields[0] !== META_SENTINEL) {
    throw new SessionError(`unexpected tmux metadata for session "${name}"`);
  }

  const capturedAtMs = Date.now();
  const meta = await readMeta(name);
  const sessionCreatedMs = toInt(fields[18], 0) * 1000;
  const startedAtMs = meta?.startedAtMs ?? (sessionCreatedMs > 0 ? sessionCreatedMs : capturedAtMs);

  const ansi = body.endsWith("\n") ? body.slice(0, -1) : body;
  const text = stripAnsi(ansi)
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .join("\n");

  const deadStatus = fields[7] ?? "";

  return {
    session: name,
    capturedAt: new Date(capturedAtMs).toISOString(),
    capturedAtMs,
    elapsedMs: Math.max(0, capturedAtMs - startedAtMs),
    cols: toInt(fields[1], 80),
    rows: toInt(fields[2], 24),
    cursor: {
      x: toInt(fields[3], 0),
      y: toInt(fields[4], 0),
      visible: flag(fields[5]),
    },
    dead: flag(fields[6]),
    exitStatus: deadStatus === "" ? undefined : toInt(deadStatus, 0),
    command: fields[8] ?? "",
    panePid: toInt(fields[9], 0),
    alternateScreen: flag(fields[10]),
    historySize: toInt(fields[11], 0),
    mouse: {
      any: flag(fields[12]),
      standard: flag(fields[13]),
      button: flag(fields[14]),
      all: flag(fields[15]),
      sgr: flag(fields[16]),
      utf8: flag(fields[17]),
    },
    ansi,
    text,
    hash: hashText(ansi),
  };
}
