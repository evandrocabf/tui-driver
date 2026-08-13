/**
 * The command-line surface: every command, its options, and the dispatcher.
 *
 * Each command is a one-shot operation that prints its result and exits, which is what lets an
 * agent drive a TUI through nothing but a `Bash` tool. There is no long-lived process to hold and
 * no state to thread between calls — the session in tmux is the state.
 */

import { rm } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";

import packageJson from "../package.json" with { type: "json" };

import { Args, formatOptions, parseArgs, type OptionSpecs } from "./args.js";
import { capture, type Snapshot } from "./capture.js";
import { diffText, formatDiff } from "./diff.js";
import { CliError, ConditionError, UsageError } from "./errors.js";
import { renderSnapshot, snapshotToJson, table, withRuler } from "./format.js";
import {
  assertLabel,
  listFrames,
  readFrameAnsi,
  readFrameText,
  resolveFrame,
  saveFrame,
} from "./frames.js";
import {
  mouseClick,
  mouseDrag,
  mouseMove,
  mouseScroll,
  pasteText,
  queryMouseModes,
  sendKeys,
  sendText,
} from "./input.js";
import { DEFAULT_TTL_MS, NEVER, reap, resolveTtlMs, sweep } from "./lifetime.js";
import { locate, pickMatch, type LocateOptions, type ScreenMatch } from "./locate.js";
import {
  describeModes,
  legacyOutOfRange,
  NO_MODIFIERS,
  parseButton,
  parseModifiers,
  type MouseEncoding,
} from "./mouse.js";
import { framesDir, rootDir, sessionDir, socketPath } from "./paths.js";
import { detectBackends } from "./png.js";
import { renderAnsiToFile, type RenderFormat } from "./render.js";
import { runScenario, formatScenarioReport } from "./scenario.js";
import {
  assertName,
  attachCommand,
  keepAlive,
  listSessions,
  requireSession,
  resizeSession,
  startSession,
  stopSession,
} from "./session.js";
import { listSessionNames, tmuxVersion } from "./tmux.js";
import { formatElapsed, parseDuration, parseSize, sleep, stampFor } from "./util.js";
import { runWatchLoop, readWatcher, startWatcher, stopWatcher } from "./watch.js";
import { waitFor, waitUntilDrawn } from "./wait.js";

/** The version reported by `tui --version`, read from package.json so there is one source. */
const VERSION: string = packageJson.version;

/** One CLI command: enough to run it and to generate its help. */
export interface Command {
  /** One line, shown in the command list. */
  summary: string;
  /** The usage line, also printed when a {@link UsageError} escapes. */
  usage: string;
  /** Every option it accepts. */
  options: OptionSpecs;
  /** Kept out of the command list — used for the recorder's internal daemon subcommand. */
  hidden?: boolean;
  /** Runs the command and returns its exit code. */
  run: (args: Args) => Promise<number>;
}

/** Options shared by every command that can produce an image. */
const IMAGE_OPTIONS: OptionSpecs = {
  png: { type: "boolean", describe: "also render the frame as a PNG image" },
  svg: { type: "boolean", describe: "also render the frame as an SVG image" },
  theme: { type: "string", describe: "image palette: dark (default) or light" },
  "font-size": { type: "number", describe: "image font size in px (default 16)" },
  scale: { type: "number", describe: "image pixel scale factor (default 2)" },
};

/**
 * Options shared by every command that acts on the TUI.
 *
 * `--snap` is the important one: it turns act-then-observe into a single command, so one call is
 * one full turn for an agent.
 */
const ACTION_OPTIONS: OptionSpecs = {
  snap: { type: "boolean", describe: "capture and print the screen after the action" },
  settle: { type: "string", describe: "wait for the screen to settle before capturing" },
  json: { type: "boolean", describe: "emit machine-readable JSON" },
};

/** Which image format was asked for, if any. `--svg` wins over `--png` when both are given. */
function imageFormat(args: Args): RenderFormat | undefined {
  if (args.boolean("svg")) return "svg";
  if (args.boolean("png")) return "png";
  return undefined;
}

/** Collect the text-matching options shared by `find`, `wait` and the mouse commands. */
function locateOptions(args: Args): LocateOptions {
  return {
    ...(args.boolean("regex") ? { regex: true } : {}),
    ...(args.boolean("ignore-case") ? { ignoreCase: true } : {}),
    ...(args.boolean("all") ? { all: true } : {}),
    ...(args.number("nth") !== undefined ? { nth: args.number("nth"), all: true } : {}),
  };
}

/** How long a session has left, phrased so the next command is obvious when it is running out. */
function leaseNote(expiresAtMs: number | undefined, name: string): string {
  if (expiresAtMs === undefined) return "no lease";
  if (expiresAtMs === NEVER) return "never expires";
  const left = expiresAtMs - Date.now();
  if (left <= 0) return "expired";
  return `auto-stops in ${formatElapsed(left)} (extend: tui keepalive ${name})`;
}

/** A session's remaining lease, in the compact form `tui ls` prints in its own column. */
function remainingLease(expiresAtMs: number | undefined): string {
  if (expiresAtMs === undefined) return "-";
  if (expiresAtMs === NEVER) return "never";
  const left = expiresAtMs - Date.now();
  return left <= 0 ? "expired" : formatElapsed(left);
}

/** Write to stdout, ensuring exactly one trailing newline. */
function output(text: string): void {
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/** Write to stderr, so it never contaminates output being parsed. */
function warn(text: string): void {
  process.stderr.write(`${text}\n`);
}

/**
 * Finish an action command: print its summary, or capture and print the resulting screen.
 *
 * With `--snap` the capture waits for the screen to settle first, which is what makes one command a
 * complete turn — act, let the TUI repaint, then show what it looks like now.
 */
async function afterAction(name: string, args: Args, summary: string): Promise<number> {
  if (!args.boolean("snap")) {
    if (args.boolean("json")) output(JSON.stringify({ ok: true, summary }, null, 2));
    else output(summary);
    return 0;
  }

  const settle = parseDuration(args.string("settle"), 300);
  if (settle > 0) {
    await waitFor(name, {
      stableMs: settle,
      timeoutMs: Math.max(settle * 8, 3000),
      intervalMs: 60,
    });
  }
  const snapshot = await capture(name);
  if (args.boolean("json")) {
    output(snapshotToJson(snapshot, { summary }));
    return 0;
  }
  output(renderSnapshot(snapshot, { note: summary }));
  return 0;
}

/**
 * Store a capture, and render an image if one was asked for.
 *
 * With `--out` the image goes exactly where it was told and nothing is added to the frame store.
 * Otherwise the capture is saved as a frame, and any image lands beside it — so images never appear
 * in the caller's working directory unless they asked for that.
 *
 * @returns The files written, and the image among them if there was one.
 */
async function persistSnapshot(
  name: string,
  snapshot: Snapshot,
  args: Args,
): Promise<{ paths: string[]; imagePath?: string }> {
  const paths: string[] = [];
  const format = imageFormat(args);
  const explicitOut = args.string("out");

  if (explicitOut) {
    const result = await renderAnsiToFile(snapshot.ansi, resolvePath(explicitOut), {
      cols: snapshot.cols,
      rows: snapshot.rows,
      cursor: snapshot.cursor,
      ...(format ? { format } : {}),
      ...(args.string("theme") ? { theme: args.string("theme") } : {}),
      ...(args.number("font-size") !== undefined ? { fontSize: args.number("font-size") } : {}),
      ...(args.number("scale") !== undefined ? { scale: args.number("scale") } : {}),
      title: `${name} @ ${snapshot.capturedAt}`,
    });
    paths.push(result.path);
    return { paths, imagePath: result.path };
  }

  if (!args.boolean("save", true)) return { paths };

  const label = args.string("label");
  if (label !== undefined) assertLabel(label);

  const frame = await saveFrame(name, snapshot, {
    kind: "snap",
    ...(label ? { label } : {}),
    ...(format ? { image: format } : {}),
    ...(args.string("theme") ? { theme: args.string("theme") } : {}),
    ...(args.number("font-size") !== undefined ? { fontSize: args.number("font-size") } : {}),
    ...(args.number("scale") !== undefined ? { scale: args.number("scale") } : {}),
  });
  paths.push(frame.files.text);
  if (frame.files.image) paths.push(frame.files.image);
  return { paths, ...(frame.files.image ? { imagePath: frame.files.image } : {}) };
}

/**
 * Work out which cell a mouse command means: `--text <pattern>`, or explicit coordinates.
 *
 * A text match is clicked at its centre by default, which is the part most reliably inside a
 * button's hit area; `--at start` and `--at end` aim at its edges instead.
 *
 * @param startIndex - Where the coordinate pair would begin among the positional arguments.
 * @throws {ConditionError} If the pattern matches nothing on screen.
 * @throws {UsageError} If neither a pattern nor a usable coordinate pair was given.
 */
async function resolveClickTarget(
  name: string,
  args: Args,
  startIndex: number,
): Promise<{ x: number; y: number; match?: ScreenMatch }> {
  const pattern = args.string("text");
  if (pattern !== undefined) {
    const snapshot = await capture(name);
    const matches = locate(snapshot.text, pattern, { ...locateOptions(args), all: true });
    const match = pickMatch(matches, args.number("nth"));
    if (!match) {
      throw new ConditionError(`no match for ${JSON.stringify(pattern)} on the current screen`);
    }
    const anchor = args.string("at") ?? "center";
    const x =
      anchor === "start"
        ? match.col
        : anchor === "end"
          ? match.col + Math.max(0, match.width - 1)
          : match.centerCol;
    return { x, y: match.row, match };
  }

  const rawX = args.positional(startIndex);
  const rawY = args.positional(startIndex + 1);
  if (rawX === undefined || rawY === undefined) {
    throw new UsageError("provide X and Y coordinates, or --text <pattern>");
  }
  const x = Number.parseInt(rawX, 10);
  const y = Number.parseInt(rawY, 10);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new UsageError(`invalid coordinates: ${rawX} ${rawY}`);
  }
  return { x, y };
}

/**
 * Warn when a mouse event will not land, rather than letting it fail silently.
 *
 * Two ways that happens: the application never enabled mouse reporting, or the coordinates fall
 * outside what the legacy x10 encoding can express. Both are warnings, not errors — the bytes were
 * delivered, and the caller may still have wanted that.
 */
async function warnIfMouseOff(
  name: string,
  encoding: MouseEncoding,
  cells: readonly { x: number; y: number }[],
): Promise<void> {
  const modes = await queryMouseModes(name);
  if (!modes.any) {
    warn(
      `warning: this TUI has not enabled mouse reporting (mouse ${describeModes(modes)}) — the event was delivered but will likely be ignored`,
    );
    return;
  }
  const unreachable = cells.some((cell) =>
    legacyOutOfRange(
      { x: cell.x, y: cell.y, button: "left", action: "press", modifiers: NO_MODIFIERS },
      encoding,
    ),
  );
  if (unreachable) {
    warn(
      `warning: the TUI uses the legacy x10 mouse encoding, which cannot address column or row 95 and beyond — this event was clamped`,
    );
  }
}

export /**
 * Every command, keyed by the name typed on the command line.
 *
 * Insertion order is the order `tui help` lists them, so they are grouped by how they are used —
 * start and inspect, act, wait and record, then housekeeping.
 */
const COMMANDS: Record<string, Command> = {
  start: {
    summary: "Launch a TUI in a detached tmux session",
    usage: "tui start [options] -- <command> [args...]",
    options: {
      name: { type: "string", describe: "session name (default: derived from the command)" },
      size: { type: "string", describe: "terminal size as COLSxROWS (default 120x32)" },
      cwd: { type: "string", describe: "working directory for the command" },
      env: { type: "string[]", describe: "extra environment as KEY=VALUE (repeatable)" },
      shell: { type: "string", describe: "run a raw shell command string instead of argv" },
      ttl: { type: "string", describe: "kill the session after this long (default 10m, max 60m)" },
      settle: { type: "string", describe: "settle time before the first capture (default 400ms)" },
      "wait-text": { type: "string", describe: "wait until this text appears before returning" },
      "wait-timeout": { type: "string", describe: "timeout for --wait-text (default 15s)" },
      record: { type: "string", describe: "start a recorder at this interval, e.g. 500ms" },
      "raw-log": { type: "boolean", describe: "also stream raw pane output to raw-output.log" },
      snap: { type: "boolean", describe: "print the first screen (default true)" },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
    },
    async run(args) {
      const size = parseSize(args.string("size"), { cols: 120, rows: 32 });
      const env: Record<string, string> = {};
      for (const entry of args.list("env")) {
        const splitAt = entry.indexOf("=");
        if (splitAt <= 0) throw new UsageError(`--env expects KEY=VALUE, got "${entry}"`);
        env[entry.slice(0, splitAt)] = entry.slice(splitAt + 1);
      }

      const argv = args.passthrough.length > 0 ? args.passthrough : args.positionals;
      const ttlMs = resolveTtlMs(args.string("ttl"));
      const meta = await startSession({
        ttlMs,
        ...(args.string("name") ? { name: args.string("name") } : {}),
        argv,
        ...(args.string("shell") ? { shell: args.string("shell") } : {}),
        ...(args.string("cwd") ? { cwd: resolvePath(args.string("cwd") ?? ".") } : {}),
        cols: size.cols,
        rows: size.rows,
        env,
        rawLog: args.boolean("raw-log"),
      });

      if (args.string("record") !== undefined) {
        await startWatcher(meta.name, {
          intervalMs: parseDuration(args.string("record"), 500),
          stopOnExit: true,
        });
      }

      const settle = parseDuration(args.string("settle"), 400);
      const waitText = args.string("wait-text");
      if (waitText !== undefined) {
        const result = await waitFor(meta.name, {
          text: waitText,
          timeoutMs: parseDuration(args.string("wait-timeout"), 15_000),
          intervalMs: 100,
        });
        if (!result.ok) {
          warn(`warning: --wait-text never matched: ${result.pending.join("; ")}`);
        }
      } else {
        await waitUntilDrawn(meta.name, Math.max(3000, settle * 4));
        if (settle > 0) await sleep(settle);
      }

      const snapshot = await capture(meta.name);
      if (args.boolean("json")) {
        output(
          JSON.stringify({ session: meta, attach: attachCommand(meta.name), snapshot }, null, 2),
        );
        return 0;
      }

      output(
        `session "${meta.name}" started · ${size.cols}x${size.rows} · ${meta.command} · ${leaseNote(meta.expiresAtMs, meta.name)}`,
      );
      output(`attach with: ${attachCommand(meta.name)}`);
      if (args.boolean("snap", true)) output(renderSnapshot(snapshot));
      return 0;
    },
  },

  ls: {
    summary: "List running sessions",
    usage: "tui ls [--json]",
    options: { json: { type: "boolean", describe: "emit machine-readable JSON" } },
    async run(args) {
      const sessions = await listSessions();
      if (args.boolean("json")) {
        output(JSON.stringify(sessions, null, 2));
        return 0;
      }
      if (sessions.length === 0) {
        output("no sessions running");
        return 0;
      }
      const rows: string[][] = [
        ["NAME", "SIZE", "COMMAND", "STATE", "WATCHER", "STARTED", "EXPIRES"],
      ];
      for (const session of sessions) {
        const watcher = await readWatcher(session.name);
        rows.push([
          session.name,
          `${session.cols}x${session.rows}`,
          session.command,
          session.dead ? `exited(${session.exitStatus ?? "?"})` : "running",
          watcher ? `pid ${watcher.pid}` : "-",
          session.meta?.startedAt ?? session.createdAt,
          remainingLease(session.expiresAtMs),
        ]);
      }
      output(table(rows));
      return 0;
    },
  },

  snap: {
    summary: "Capture the current screen (text, and optionally an image)",
    usage: "tui snap <session> [options]",
    options: {
      ...IMAGE_OPTIONS,
      label: { type: "string", describe: "label the saved frame" },
      out: { type: "string", describe: "write the image to this path instead of the frame store" },
      ansi: { type: "boolean", describe: "print the screen with ANSI colour sequences" },
      raw: { type: "boolean", describe: "print only the screen, without the header rule" },
      ruler: { type: "boolean", describe: "prefix rows and columns with coordinates" },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
      scrollback: { type: "number", describe: "include N lines of scrollback history" },
      alt: {
        type: "boolean",
        describe: "capture the other screen buffer (the normal one, while a full-screen app runs)",
      },
      save: { type: "boolean", describe: "save the frame to the store (default true)" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await requireSession(name);
      const snapshot = await capture(name, {
        ...(args.number("scrollback") !== undefined
          ? { scrollback: args.number("scrollback") }
          : {}),
        ...(args.boolean("alt") ? { alternate: true } : {}),
      });
      const saved = await persistSnapshot(name, snapshot, args);

      if (args.boolean("json")) {
        output(snapshotToJson(snapshot, { files: saved.paths }));
        return 0;
      }
      output(
        renderSnapshot(snapshot, {
          raw: args.boolean("raw"),
          ansi: args.boolean("ansi"),
          ruler: args.boolean("ruler"),
          savedPaths: saved.paths,
        }),
      );
      return 0;
    },
  },

  keys: {
    summary: "Send key presses (tmux key names, plus friendly aliases)",
    usage: "tui keys <session> <key> [key...]",
    options: {
      ...ACTION_OPTIONS,
      delay: { type: "string", describe: "delay between keys, e.g. 40ms" },
      repeat: { type: "number", describe: "repeat the whole sequence N times" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await requireSession(name);
      const keys = args.positionals.slice(1);
      if (keys.length === 0) throw new UsageError("provide at least one key");
      const sent = await sendKeys(name, keys, {
        delayMs: parseDuration(args.string("delay"), 0),
        ...(args.number("repeat") !== undefined ? { repeat: args.number("repeat") } : {}),
      });
      return afterAction(name, args, `sent keys: ${sent.join(" ")}`);
    },
  },

  type: {
    summary: "Type literal text into the TUI",
    usage: 'tui type <session> "text to type"',
    options: {
      ...ACTION_OPTIONS,
      delay: { type: "string", describe: "delay between characters, e.g. 20ms" },
      enter: { type: "boolean", describe: "press Enter after typing" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await requireSession(name);
      const text = args.positionals.slice(1).join(" ");
      if (text === "") throw new UsageError("provide the text to type");
      await sendText(name, text, { delayMs: parseDuration(args.string("delay"), 0) });
      if (args.boolean("enter")) await sendKeys(name, ["Enter"]);
      return afterAction(name, args, `typed ${JSON.stringify(text)}`);
    },
  },

  paste: {
    summary: "Paste a block of text (bracketed paste by default)",
    usage: "tui paste <session> [text] [--file path]",
    options: {
      ...ACTION_OPTIONS,
      file: { type: "string", describe: "read the payload from a file" },
      bracket: { type: "boolean", describe: "use bracketed paste (default true)" },
      enter: { type: "boolean", describe: "press Enter after pasting" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await requireSession(name);
      const file = args.string("file");
      let payload: string;
      if (file) payload = await Bun.file(resolvePath(file)).text();
      else if (args.positionals.length > 1) payload = args.positionals.slice(1).join(" ");
      else payload = await Bun.stdin.text();
      if (payload === "") throw new UsageError("nothing to paste");

      await pasteText(name, payload, { bracketed: args.boolean("bracket", true) });
      if (args.boolean("enter")) await sendKeys(name, ["Enter"]);
      return afterAction(name, args, `pasted ${payload.length} characters`);
    },
  },

  click: {
    summary: "Send a mouse click at a cell, or at matching on-screen text",
    usage: "tui click <session> <x> <y> | tui click <session> --text <pattern>",
    options: {
      ...ACTION_OPTIONS,
      text: { type: "string", describe: "click the cell where this text appears" },
      regex: { type: "boolean", describe: "treat --text as a regular expression" },
      "ignore-case": { type: "boolean", describe: "case-insensitive --text matching" },
      nth: { type: "number", describe: "pick the Nth match (0-based, negatives count back)" },
      at: { type: "string", describe: "click at start, center (default) or end of the match" },
      button: { type: "string", describe: "left (default), middle, right" },
      count: { type: "number", describe: "click N times, e.g. 2 for a double click" },
      modifiers: { type: "string", describe: "ctrl, alt, shift (comma separated)" },
      encoding: { type: "string", describe: "force sgr, utf8 or x10 encoding" },
      delay: { type: "string", describe: "delay between repeated clicks" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await requireSession(name);
      const target = await resolveClickTarget(name, args, 1);
      const button = parseButton(args.string("button"));
      const modifiers = parseModifiers(args.string("modifiers"));

      const encoding = await mouseClick(name, target.x, target.y, button, modifiers, {
        ...(args.string("encoding") ? { encoding: args.string("encoding") as MouseEncoding } : {}),
        ...(args.number("count") !== undefined ? { count: args.number("count") } : {}),
        delayMs: parseDuration(args.string("delay"), 60),
      });
      await warnIfMouseOff(name, encoding, [{ x: target.x, y: target.y }]);

      const where = target.match
        ? `${target.x},${target.y} (${JSON.stringify(target.match.text)})`
        : `${target.x},${target.y}`;
      return afterAction(name, args, `clicked ${button} at ${where} using ${encoding}`);
    },
  },

  move: {
    summary: "Move the mouse pointer to a cell (motion event)",
    usage: "tui move <session> <x> <y>",
    options: {
      ...ACTION_OPTIONS,
      text: { type: "string", describe: "move to the cell where this text appears" },
      regex: { type: "boolean", describe: "treat --text as a regular expression" },
      "ignore-case": { type: "boolean", describe: "case-insensitive --text matching" },
      nth: { type: "number", describe: "pick the Nth match (0-based)" },
      at: { type: "string", describe: "aim at start, center (default) or end of the match" },
      button: { type: "string", describe: "report this button as held during the motion" },
      modifiers: { type: "string", describe: "ctrl, alt, shift (comma separated)" },
      encoding: { type: "string", describe: "force sgr, utf8 or x10 encoding" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await requireSession(name);
      const target = await resolveClickTarget(name, args, 1);
      const modifiers = parseModifiers(args.string("modifiers"));
      const encoding = await mouseMove(name, target.x, target.y, modifiers, {
        ...(args.string("encoding") ? { encoding: args.string("encoding") as MouseEncoding } : {}),
        ...(args.string("button") ? { button: parseButton(args.string("button")) } : {}),
      });
      const modes = await queryMouseModes(name);
      if (!modes.all && !modes.button) {
        warn(
          `warning: this TUI tracks mouse as ${describeModes(modes)} — plain motion events are only reported under button-event(1002) or any-event(1003)`,
        );
      }
      return afterAction(name, args, `moved to ${target.x},${target.y} using ${encoding}`);
    },
  },

  drag: {
    summary: "Press, move and release the mouse between two cells",
    usage: "tui drag <session> <x1> <y1> <x2> <y2>",
    options: {
      ...ACTION_OPTIONS,
      button: { type: "string", describe: "left (default), middle, right" },
      steps: { type: "number", describe: "number of intermediate motion events (default 4)" },
      delay: { type: "string", describe: "delay between motion events (default 20ms)" },
      modifiers: { type: "string", describe: "ctrl, alt, shift (comma separated)" },
      encoding: { type: "string", describe: "force sgr, utf8 or x10 encoding" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await requireSession(name);
      const coordinates = args.positionals.slice(1, 5).map((value) => Number.parseInt(value, 10));
      if (coordinates.length < 4 || coordinates.some((value) => !Number.isFinite(value))) {
        throw new UsageError("drag needs four coordinates: <x1> <y1> <x2> <y2>");
      }
      const [x1, y1, x2, y2] = coordinates as [number, number, number, number];
      const encoding = await mouseDrag(
        name,
        { x: x1, y: y1 },
        { x: x2, y: y2 },
        parseButton(args.string("button")),
        parseModifiers(args.string("modifiers")),
        {
          ...(args.string("encoding")
            ? { encoding: args.string("encoding") as MouseEncoding }
            : {}),
          ...(args.number("steps") !== undefined ? { steps: args.number("steps") } : {}),
          delayMs: parseDuration(args.string("delay"), 20),
        },
      );
      await warnIfMouseOff(name, encoding, [
        { x: x1, y: y1 },
        { x: x2, y: y2 },
      ]);
      return afterAction(name, args, `dragged ${x1},${y1} -> ${x2},${y2} using ${encoding}`);
    },
  },

  scroll: {
    summary: "Send mouse wheel events",
    usage: "tui scroll <session> [x] [y] --down|--up [--amount n]",
    options: {
      ...ACTION_OPTIONS,
      up: { type: "boolean", describe: "scroll up" },
      down: { type: "boolean", describe: "scroll down" },
      left: { type: "boolean", describe: "scroll left" },
      right: { type: "boolean", describe: "scroll right" },
      amount: { type: "number", describe: "number of wheel notches (default 3)" },
      modifiers: { type: "string", describe: "ctrl, alt, shift (comma separated)" },
      encoding: { type: "string", describe: "force sgr, utf8 or x10 encoding" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await requireSession(name);
      const direction = args.boolean("up")
        ? "up"
        : args.boolean("left")
          ? "left"
          : args.boolean("right")
            ? "right"
            : "down";
      const rawX = args.positional(1);
      const rawY = args.positional(2);
      const snapshot = rawX === undefined || rawY === undefined ? await capture(name) : undefined;
      const x =
        rawX === undefined ? Math.floor((snapshot?.cols ?? 80) / 2) : Number.parseInt(rawX, 10);
      const y =
        rawY === undefined ? Math.floor((snapshot?.rows ?? 24) / 2) : Number.parseInt(rawY, 10);

      const encoding = await mouseScroll(
        name,
        x,
        y,
        direction,
        args.number("amount") ?? 3,
        parseModifiers(args.string("modifiers")),
        args.string("encoding") ? { encoding: args.string("encoding") as MouseEncoding } : {},
      );
      await warnIfMouseOff(name, encoding, [{ x, y }]);
      return afterAction(name, args, `scrolled ${direction} at ${x},${y} using ${encoding}`);
    },
  },

  find: {
    summary: "Locate text on the current screen and report its coordinates",
    usage: "tui find <session> <pattern>",
    options: {
      regex: { type: "boolean", describe: "treat the pattern as a regular expression" },
      "ignore-case": { type: "boolean", describe: "case-insensitive matching" },
      all: { type: "boolean", describe: "report every match, not just the first" },
      nth: { type: "number", describe: "report only the Nth match (0-based)" },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await requireSession(name);
      const pattern = args.requirePositional(1, "search pattern");
      const snapshot = await capture(name);
      const matches = locate(snapshot.text, pattern, { ...locateOptions(args), all: true });
      const selected =
        args.number("nth") !== undefined
          ? [pickMatch(matches, args.number("nth"))].filter((match): match is ScreenMatch =>
              Boolean(match),
            )
          : args.boolean("all")
            ? matches
            : matches.slice(0, 1);

      if (args.boolean("json")) {
        output(JSON.stringify({ pattern, matches: selected, total: matches.length }, null, 2));
        return selected.length > 0 ? 0 : 1;
      }
      if (selected.length === 0) {
        output(`no match for ${JSON.stringify(pattern)}`);
        return 1;
      }
      const rows: string[][] = [["X", "Y", "WIDTH", "TEXT"]];
      for (const match of selected) {
        rows.push([String(match.col), String(match.row), String(match.width), match.text]);
      }
      output(table(rows));
      output(
        `click the first one with: tui click ${name} ${selected[0]?.centerCol} ${selected[0]?.row}`,
      );
      return 0;
    },
  },

  wait: {
    summary: "Block until the screen satisfies a condition",
    usage: "tui wait <session> [--text pattern] [--stable 400ms] [--exit]",
    options: {
      text: { type: "string", describe: "wait until this text appears" },
      gone: { type: "string", describe: "wait until this text disappears" },
      regex: { type: "boolean", describe: "treat patterns as regular expressions" },
      "ignore-case": { type: "boolean", describe: "case-insensitive matching" },
      stable: { type: "string", describe: "wait until the screen stops changing for this long" },
      exit: { type: "boolean", describe: "wait until the process exits" },
      timeout: { type: "string", describe: "give up after this long (default 15s)" },
      interval: { type: "string", describe: "poll interval (default 100ms)" },
      quiet: { type: "boolean", describe: "do not print the screen" },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await requireSession(name);
      const hasCondition =
        args.has("text") || args.has("gone") || args.has("stable") || args.boolean("exit");

      const result = await waitFor(name, {
        ...(args.string("text") !== undefined ? { text: args.string("text") } : {}),
        ...(args.string("gone") !== undefined ? { gone: args.string("gone") } : {}),
        ...(args.boolean("exit") ? { exit: true } : {}),
        ...(args.has("stable") || !hasCondition
          ? { stableMs: parseDuration(args.string("stable"), 400) }
          : {}),
        ...(args.boolean("regex") ? { regex: true } : {}),
        ...(args.boolean("ignore-case") ? { ignoreCase: true } : {}),
        timeoutMs: parseDuration(args.string("timeout"), 15_000),
        intervalMs: parseDuration(args.string("interval"), 100),
      });

      if (args.boolean("json")) {
        output(
          JSON.stringify(
            {
              ok: result.ok,
              waitedMs: result.waitedMs,
              pending: result.pending,
              match: result.match,
              snapshot: result.snapshot,
            },
            null,
            2,
          ),
        );
        return result.ok ? 0 : 1;
      }

      const note = result.ok
        ? `condition met after ${formatElapsed(result.waitedMs)}`
        : `TIMEOUT after ${formatElapsed(result.waitedMs)}: ${result.pending.join("; ")}`;

      if (args.boolean("quiet")) output(note);
      else output(renderSnapshot(result.snapshot, { note }));
      return result.ok ? 0 : 1;
    },
  },

  watch: {
    summary: "Record the screen in the background, saving a frame on every change",
    usage: "tui watch <session> [--interval 500ms] [--stop]",
    options: {
      ...IMAGE_OPTIONS,
      interval: { type: "string", describe: "polling interval (default 500ms)" },
      "max-frames": { type: "number", describe: "stop after saving N frames" },
      duration: { type: "string", describe: "stop after this much time" },
      keep: { type: "number", describe: "keep only the newest N frames on disk" },
      "stop-on-exit": { type: "boolean", describe: "stop when the process exits (default true)" },
      stop: { type: "boolean", describe: "stop the running recorder" },
      status: { type: "boolean", describe: "show recorder status" },
      foreground: { type: "boolean", describe: "run the recorder in this process" },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      assertName(name);

      if (args.boolean("stop")) {
        const stopped = await stopWatcher(name);
        output(stopped ? `recorder for "${name}" stopped` : `no recorder running for "${name}"`);
        return 0;
      }

      if (args.boolean("status")) {
        const state = await readWatcher(name);
        if (args.boolean("json")) {
          output(JSON.stringify(state ?? null, null, 2));
          return 0;
        }
        output(
          state
            ? `recording "${name}" every ${state.intervalMs}ms (pid ${state.pid}, since ${state.startedAt})`
            : `no recorder running for "${name}"`,
        );
        return 0;
      }

      await requireSession(name);
      const options = {
        intervalMs: parseDuration(args.string("interval"), 500),
        stopOnExit: args.boolean("stop-on-exit", true),
        ...(imageFormat(args) ? { image: imageFormat(args) } : {}),
        ...(args.number("max-frames") !== undefined
          ? { maxFrames: args.number("max-frames") }
          : {}),
        ...(args.has("duration") ? { durationMs: parseDuration(args.string("duration"), 0) } : {}),
        ...(args.number("keep") !== undefined ? { keep: args.number("keep") } : {}),
        ...(args.string("theme") ? { theme: args.string("theme") } : {}),
        ...(args.number("scale") !== undefined ? { scale: args.number("scale") } : {}),
      };

      if (args.boolean("foreground")) {
        const saved = await runWatchLoop(name, options);
        output(`recorder finished after ${saved} frames`);
        return 0;
      }

      const state = await startWatcher(name, options);
      if (args.boolean("json")) {
        output(JSON.stringify(state, null, 2));
        return 0;
      }
      output(
        `recording "${name}" every ${state.intervalMs}ms (pid ${state.pid}) — frames in ${sessionDir(name)}/frames`,
      );
      return 0;
    },
  },

  "watch-daemon": {
    summary: "Internal recorder loop",
    usage: "tui watch-daemon <session> --interval <ms>",
    hidden: true,
    options: {
      interval: { type: "number", describe: "interval in milliseconds" },
      image: { type: "string", describe: "png or svg" },
      "max-frames": { type: "number", describe: "stop after N frames" },
      duration: { type: "number", describe: "stop after N milliseconds" },
      keep: { type: "number", describe: "keep only the newest N frames" },
      theme: { type: "string", describe: "image palette" },
      scale: { type: "number", describe: "image scale" },
      "stop-on-exit": { type: "boolean", describe: "stop when the process exits" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      await runWatchLoop(name, {
        intervalMs: args.number("interval") ?? 500,
        stopOnExit: args.boolean("stop-on-exit", true),
        ...(args.string("image") ? { image: args.string("image") as RenderFormat } : {}),
        ...(args.number("max-frames") !== undefined
          ? { maxFrames: args.number("max-frames") }
          : {}),
        ...(args.number("duration") !== undefined ? { durationMs: args.number("duration") } : {}),
        ...(args.number("keep") !== undefined ? { keep: args.number("keep") } : {}),
        ...(args.string("theme") ? { theme: args.string("theme") } : {}),
        ...(args.number("scale") !== undefined ? { scale: args.number("scale") } : {}),
      });
      return 0;
    },
  },

  frames: {
    summary: "List recorded frames",
    usage: "tui frames <session> [--last n]",
    options: {
      last: { type: "number", describe: "show only the newest N frames" },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      assertName(name);
      const all = await listFrames(name);
      const last = args.number("last");
      const frames = last === undefined ? all : all.slice(-last);

      if (args.boolean("json")) {
        output(JSON.stringify(frames, null, 2));
        return 0;
      }
      if (frames.length === 0) {
        output(`no frames recorded for "${name}"`);
        return 0;
      }
      const rows: string[][] = [["#", "ID", "KIND", "LABEL", "AT", "IMAGE"]];
      frames.forEach((frame, index) => {
        rows.push([
          String(all.length - frames.length + index),
          frame.id,
          frame.kind,
          frame.label ?? "-",
          `+${formatElapsed(frame.elapsedMs)}`,
          frame.files.image ? "yes" : "-",
        ]);
      });
      output(table(rows));
      return 0;
    },
  },

  frame: {
    summary: "Print a recorded frame",
    usage: "tui frame <session> [ref]",
    options: {
      ansi: { type: "boolean", describe: "print with ANSI colour sequences" },
      ruler: { type: "boolean", describe: "prefix rows and columns with coordinates" },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      assertName(name);
      const frame = await resolveFrame(name, args.positional(1));
      const body = args.boolean("ansi") ? await readFrameAnsi(frame) : await readFrameText(frame);

      if (args.boolean("json")) {
        output(JSON.stringify({ ...frame, body }, null, 2));
        return 0;
      }
      output(
        `── ${frame.id} · ${frame.kind}${frame.label ? ` · ${frame.label}` : ""} · +${formatElapsed(frame.elapsedMs)} ──`,
      );
      output(args.boolean("ruler") ? withRuler(body, frame.cols) : body);
      return 0;
    },
  },

  render: {
    summary: "Render a frame (or the live screen) as PNG or SVG",
    usage: "tui render <session> [ref] --out shot.png",
    options: {
      ...IMAGE_OPTIONS,
      out: {
        type: "string",
        describe: "output path (default: alongside the frame, in the session store)",
      },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      assertName(name);
      const reference = args.positional(1);

      let ansi: string;
      let cols: number;
      let rows: number;
      let cursor;
      let stem: string;
      if (reference === undefined || reference === "live") {
        await requireSession(name);
        const snapshot = await capture(name);
        ansi = snapshot.ansi;
        cols = snapshot.cols;
        rows = snapshot.rows;
        cursor = snapshot.cursor;
        stem = `${stampFor(new Date(snapshot.capturedAtMs))}-live`;
      } else {
        const frame = await resolveFrame(name, reference);
        ansi = await readFrameAnsi(frame);
        cols = frame.cols;
        rows = frame.rows;
        cursor = frame.cursor;
        stem = frame.id;
      }

      const format = imageFormat(args) ?? "png";
      const explicitOut = args.string("out");
      /* Without --out the image goes next to the frame in the session store, never into the
         working directory: render is normally run from inside the project being driven, and a stray
         app-live.png in someone else's repo is not ours to leave behind. The path is printed, so it
         is still easy to open. */
      const out = explicitOut
        ? resolvePath(explicitOut)
        : join(framesDir(name), `${stem}.${format === "svg" ? "svg" : "png"}`);
      const result = await renderAnsiToFile(ansi, out, {
        cols,
        rows,
        cursor,
        format,
        ...(args.string("theme") ? { theme: args.string("theme") } : {}),
        ...(args.number("font-size") !== undefined ? { fontSize: args.number("font-size") } : {}),
        ...(args.number("scale") !== undefined ? { scale: args.number("scale") } : {}),
        title: `${name} ${reference ?? "live"}`,
      });

      if (args.boolean("json")) {
        output(JSON.stringify(result, null, 2));
        return 0;
      }
      output(
        `wrote ${result.path} (${result.width}x${result.height}${result.backend ? ` via ${result.backend}` : ""})`,
      );
      return 0;
    },
  },

  diff: {
    summary: "Compare two frames, or a frame against the live screen",
    usage: "tui diff <session> [refA] [refB]",
    options: { json: { type: "boolean", describe: "emit machine-readable JSON" } },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      assertName(name);
      const refA = args.positional(1) ?? "-1";
      const refB = args.positional(2);

      const before = await readFrameText(await resolveFrame(name, refA));
      let after: string;
      if (refB === undefined || refB === "live") {
        await requireSession(name);
        after = (await capture(name)).text;
      } else {
        after = await readFrameText(await resolveFrame(name, refB));
      }

      const result = diffText(before, after);
      if (args.boolean("json")) {
        output(JSON.stringify(result, null, 2));
        return result.identical ? 0 : 1;
      }
      output(formatDiff(result));
      return result.identical ? 0 : 1;
    },
  },

  resize: {
    summary: "Resize a session's terminal",
    usage: "tui resize <session> <COLSxROWS>",
    options: { json: { type: "boolean", describe: "emit machine-readable JSON" } },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      const size = parseSize(args.requirePositional(1, "size"), { cols: 120, rows: 32 });
      await resizeSession(name, size.cols, size.rows);
      if (args.boolean("json")) {
        output(JSON.stringify({ session: name, cols: size.cols, rows: size.rows }, null, 2));
        return 0;
      }
      output(`resized "${name}" to ${size.cols}x${size.rows}`);
      return 0;
    },
  },

  stop: {
    summary: "Stop a session (artifacts are kept unless --purge)",
    usage: "tui stop <session> | tui stop --all",
    options: {
      all: { type: "boolean", describe: "stop every session" },
      purge: { type: "boolean", describe: "also delete the recorded frames" },
    },
    async run(args) {
      const purge = args.boolean("purge");
      if (args.boolean("all")) {
        const names = await listSessionNames();
        for (const name of names) {
          await stopWatcher(name);
          await stopSession(name, { purge });
        }
        output(names.length === 0 ? "no sessions running" : `stopped: ${names.join(", ")}`);
        return 0;
      }
      const name = args.requirePositional(0, "session name");
      await stopWatcher(name);
      await stopSession(name, { purge });
      output(`stopped "${name}"${purge ? " and removed its frames" : ""}`);
      return 0;
    },
  },

  keepalive: {
    summary: "Push back a session's auto-stop deadline",
    usage: "tui keepalive <session> [duration]",
    options: {
      ttl: { type: "string", describe: "new lease from now (default 10m, max 60m)" },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
    },
    async run(args) {
      const name = args.requirePositional(0, "session name");
      const ttlMs = resolveTtlMs(args.string("ttl") ?? args.positional(1));
      const expiresAtMs = await keepAlive(name, ttlMs);
      if (args.boolean("json")) {
        output(JSON.stringify({ session: name, ttlMs, expiresAtMs }, null, 2));
        return 0;
      }
      output(`"${name}" ${leaseNote(expiresAtMs, name)}`);
      return 0;
    },
  },

  gc: {
    summary: "Kill sessions whose lease ran out (runs automatically before every command)",
    usage: "tui gc [--max-age 10m]",
    options: {
      "max-age": {
        type: "string",
        describe: "also kill sessions older than this, whatever their lease says",
      },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
    },
    async run(args) {
      const maxAge = args.string("max-age");
      const reaped = await reap(
        maxAge === undefined ? {} : { maxAgeMs: parseDuration(maxAge, DEFAULT_TTL_MS) },
      );
      if (args.boolean("json")) {
        output(JSON.stringify({ reaped }, null, 2));
        return 0;
      }
      if (reaped.length === 0) {
        output("nothing to reap");
        return 0;
      }
      for (const session of reaped) {
        output(
          `killed "${session.name}" (${session.reason}, alive ${formatElapsed(session.ageMs)})`,
        );
      }
      return 0;
    },
  },

  clean: {
    summary: "Delete recorded artifacts for a session",
    usage: "tui clean <session> | tui clean --all",
    options: { all: { type: "boolean", describe: "clean every stored session" } },
    async run(args) {
      if (args.boolean("all")) {
        await rm(`${rootDir()}/sessions`, { recursive: true, force: true });
        output("removed every stored frame");
        return 0;
      }
      const name = args.requirePositional(0, "session name");
      assertName(name);
      await rm(sessionDir(name), { recursive: true, force: true });
      output(`removed artifacts for "${name}"`);
      return 0;
    },
  },

  run: {
    summary: "Run a YAML or JSON scenario file",
    usage: "tui run <scenario.yaml>",
    options: {
      out: { type: "string", describe: "directory for the report and images" },
      "update-golden": { type: "boolean", describe: "rewrite golden screens instead of failing" },
      keep: { type: "boolean", describe: "leave the session running after the scenario" },
      json: { type: "boolean", describe: "emit machine-readable JSON" },
    },
    async run(args) {
      const file = args.requirePositional(0, "scenario file");
      const report = await runScenario(resolvePath(file), {
        ...(args.string("out") ? { outDir: resolvePath(args.string("out") ?? ".") } : {}),
        updateGolden: args.boolean("update-golden"),
        keepSession: args.boolean("keep"),
      });
      if (args.boolean("json")) output(JSON.stringify(report, null, 2));
      else output(formatScenarioReport(report));
      return report.ok ? 0 : 1;
    },
  },

  doctor: {
    summary: "Check tmux, terminfo and image rendering support",
    usage: "tui doctor",
    options: { json: { type: "boolean", describe: "emit machine-readable JSON" } },
    async run(args) {
      /* Only required checks decide the exit code: PNG output is optional and SVG needs nothing,
         so a missing rasterizer must not fail a CI run that never asks for an image. */
      const checks: { name: string; ok: boolean; required: boolean; detail: string }[] = [];

      try {
        checks.push({ name: "tmux", ok: true, required: true, detail: await tmuxVersion() });
      } catch (error) {
        checks.push({
          name: "tmux",
          ok: false,
          required: true,
          detail: (error as Error).message,
        });
      }

      const terminfo = Bun.spawn(["infocmp", "tmux-256color"], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      const terminfoOk = (await terminfo.exited) === 0;
      checks.push({
        name: "terminfo tmux-256color",
        ok: terminfoOk,
        required: true,
        detail: terminfoOk ? "present" : "missing (install ncurses-term)",
      });

      const backends = await detectBackends();
      checks.push({
        name: "image rendering",
        ok: backends.length > 0,
        required: false,
        detail:
          backends.length > 0
            ? backends.join(", ")
            : "no rasterizer (install rsvg-convert or ImageMagick); --svg still works",
      });

      checks.push({ name: "state directory", ok: true, required: false, detail: rootDir() });
      checks.push({ name: "tmux socket", ok: true, required: false, detail: socketPath() });

      const ok = checks.every((check) => check.ok || !check.required);

      if (args.boolean("json")) {
        output(JSON.stringify({ ok, checks }, null, 2));
        return ok ? 0 : 1;
      }

      output(
        table([
          ["", "CHECK", "DETAIL"],
          ...checks.map((check) => [
            check.ok ? "ok" : check.required ? "FAIL" : "warn",
            check.name,
            check.detail,
          ]),
        ]),
      );
      return ok ? 0 : 1;
    },
  },
};

/** Help for one command, or the command list when no name is given. */
function helpText(commandName?: string): string {
  if (commandName && COMMANDS[commandName]) {
    const command = COMMANDS[commandName];
    const lines = [command.summary, "", `usage: ${command.usage}`];
    const options = formatOptions(command.options);
    if (options !== "") lines.push("", "options:", options);
    return lines.join("\n");
  }

  const rows = Object.entries(COMMANDS)
    .filter(([, command]) => !command.hidden)
    .map(([name, command]) => [`  ${name}`, command.summary]);

  return [
    "tui-driver — drive, see and snapshot any TUI through tmux",
    "",
    "usage: tui <command> [options]",
    "",
    "commands:",
    table(rows),
    "",
    "run `tui help <command>` for the options of a single command.",
  ].join("\n");
}

/**
 * Parse a command line, run the command, and return its exit code.
 *
 * Errors carrying an exit code are reported and turned into that status; anything else propagates
 * to the entry point, which treats it as a crash. Never calls `process.exit`, so the test suite can
 * drive it in-process.
 *
 * @param argv - Arguments with the program name already removed.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const [commandName, ...rest] = argv;

  if (
    commandName === undefined ||
    commandName === "help" ||
    commandName === "--help" ||
    commandName === "-h"
  ) {
    output(helpText(rest[0]));
    return 0;
  }
  if (commandName === "--version" || commandName === "-v") {
    output(`tui-driver ${VERSION}`);
    return 0;
  }

  const command = COMMANDS[commandName];
  if (!command) {
    warn(`unknown command "${commandName}"`);
    output(helpText());
    return 2;
  }

  if (rest.includes("--help") || rest.includes("-h")) {
    output(helpText(commandName));
    return 0;
  }

  /* Before anything else, so a leaked session never survives the next command. The watchdog is the
     primary guard; this catches the case where it was killed with the rest of a process group. `gc`
     is excluded because it does its own sweep with its own options. */
  if (commandName !== "gc") {
    const reaped = await sweep();
    if (reaped.length > 0) {
      warn(`reaped expired session(s): ${reaped.map((session) => session.name).join(", ")}`);
    }
  }

  try {
    const args = parseArgs(rest, command.options);
    return await command.run(args);
  } catch (error) {
    if (error instanceof CliError) {
      warn(`error: ${error.message}`);
      if (error instanceof UsageError) warn(`usage: ${command.usage}`);
      return error.exitCode;
    }
    throw error;
  }
}
