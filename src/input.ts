/**
 * Sending input to a pane: keys, literal text, pastes, and mouse events.
 *
 * Keys go through tmux's own key names, which is what makes `Down`, `C-c` and `F5` work without
 * knowing any escape sequences. Mouse events do not: tmux has no "click here" command, so they are
 * encoded in the protocol the application enabled and injected as raw bytes.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { UsageError } from "./errors.js";
import {
  clickSequence,
  encodeMouseEvent,
  isWheel,
  pickEncoding,
  toHexArgs,
  type MouseButton,
  type MouseEncoding,
  type MouseModes,
  type MouseModifiers,
} from "./mouse.js";
import { exactTarget, tmux, tmuxOrThrow } from "./tmux.js";
import { sleep } from "./util.js";

/**
 * Friendly spellings mapped to the names tmux actually understands.
 *
 * tmux calls page-up `PPage` and backspace `BSpace`; nobody types that from memory, and the failure
 * mode is a key silently sent as literal text.
 */
const KEY_ALIASES: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  enter: "Enter",
  return: "Enter",
  cr: "Enter",
  newline: "Enter",
  tab: "Tab",
  backtab: "BTab",
  space: "Space",
  bs: "BSpace",
  backspace: "BSpace",
  del: "DC",
  delete: "DC",
  ins: "IC",
  insert: "IC",
  pgup: "PPage",
  pageup: "PPage",
  prior: "PPage",
  pgdn: "NPage",
  pagedown: "NPage",
  next: "NPage",
  home: "Home",
  end: "End",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
};

/**
 * Turn a key as written on the command line into the name tmux expects.
 *
 * Accepts, in order: single characters as themselves; caret notation (`^c`); a modifier prefix in
 * any of its spellings (`ctrl+c`, `ctrl-c`, `C-c`, `alt+x`), applied recursively so `ctrl+alt+del`
 * works; the aliases above; and function keys in any case. Anything else is passed through, since
 * it may already be a tmux key name.
 *
 * @throws {UsageError} On an empty key.
 */
export function normalizeKey(raw: string): string {
  const key = raw.trim();
  if (key === "") throw new UsageError("empty key");
  if (key.length === 1) return key;

  const caret = /^\^(.)$/.exec(key);
  if (caret?.[1]) return `C-${caret[1]}`;

  const modifier = /^(ctrl|control|alt|meta|option|shift|c|m|s)\s*[-+]\s*(.+)$/i.exec(key);
  if (modifier?.[1] && modifier[2]) {
    const head = modifier[1].toLowerCase();
    const prefix =
      head === "c" || head === "ctrl" || head === "control"
        ? "C"
        : head === "s" || head === "shift"
          ? "S"
          : "M";
    return `${prefix}-${normalizeKey(modifier[2])}`;
  }

  const alias = KEY_ALIASES[key.toLowerCase()];
  if (alias) return alias;

  const functionKey = /^f(\d{1,2})$/i.exec(key);
  if (functionKey?.[1]) return `F${functionKey[1]}`;

  return key;
}

/** The tmux target for a session's single pane. */
function paneTarget(name: string): string {
  return `${exactTarget(name)}:`;
}

/** Makes paste buffer names unique within this process; the pid makes them unique across processes. */
let pasteCounter = 0;

/** Pacing for a run of input. */
export interface SendKeysOptions {
  /** Pause between individual keys. Some TUIs debounce and drop a burst sent all at once. */
  delayMs?: number;
  /** Send the whole sequence this many times. */
  repeat?: number;
}

/**
 * Send key presses to a pane.
 *
 * With no delay every key goes in one tmux call, which is both faster and closer to a real burst of
 * typing. A delay forces one call per key, since that is the only way to space them out.
 *
 * @returns The normalised key names actually sent, which is what the CLI echoes back.
 */
export async function sendKeys(
  name: string,
  keys: readonly string[],
  options: SendKeysOptions = {},
): Promise<string[]> {
  const normalized = keys.map(normalizeKey);
  const repeat = Math.max(1, options.repeat ?? 1);
  const delay = options.delayMs ?? 0;
  const target = paneTarget(name);

  for (let round = 0; round < repeat; round += 1) {
    if (delay <= 0) {
      await tmuxOrThrow(["send-keys", "-t", target, ...normalized]);
      continue;
    }
    for (const key of normalized) {
      await tmuxOrThrow(["send-keys", "-t", target, key]);
      await sleep(delay);
    }
  }
  return normalized;
}

/**
 * Type literal text into a pane.
 *
 * Sent with `send-keys -l`, so text that looks like a key name is typed rather than interpreted.
 * The `--` guards text beginning with a dash from being read as an option by tmux itself.
 */
export async function sendText(
  name: string,
  text: string,
  options: SendKeysOptions = {},
): Promise<void> {
  const target = paneTarget(name);
  const delay = options.delayMs ?? 0;
  if (delay <= 0) {
    await tmuxOrThrow(["send-keys", "-t", target, "-l", "--", text]);
    return;
  }
  for (const char of text) {
    await tmuxOrThrow(["send-keys", "-t", target, "-l", "--", char]);
    await sleep(delay);
  }
}

/**
 * Paste a block of text, with bracketed paste by default.
 *
 * Bracketed paste is what tells the application this is a paste rather than typing, so an editor
 * does not re-indent every line of it. Routed through a tmux buffer rather than `send-keys`, which
 * is how multi-line input arrives as one paste instead of a run of Enter presses.
 *
 * @param options - `bracketed: false` sends it as plain input instead.
 */
export async function pasteText(
  name: string,
  text: string,
  options: { bracketed?: boolean } = {},
): Promise<void> {
  const target = paneTarget(name);
  pasteCounter += 1;
  const bufferName = `tui-driver-${process.pid}-${pasteCounter}`;
  /* A private directory, so the payload is never readable at a predictable path in shared /tmp. */
  const tempDir = await mkdtemp(join(tmpdir(), "tui-driver-paste-"));
  const tempFile = join(tempDir, "payload");
  await Bun.write(tempFile, text);
  try {
    await tmuxOrThrow(["load-buffer", "-b", bufferName, tempFile]);
    /* -d deletes the buffer once it has been pasted, so nothing accumulates in tmux either. */
    const args = ["paste-buffer", "-b", bufferName, "-t", target, "-d"];
    if (options.bracketed !== false) args.push("-p");
    await tmuxOrThrow(args);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Ask tmux which mouse reporting modes the application currently has enabled.
 *
 * Queried per event rather than cached: a TUI commonly turns the mouse on and off as it moves
 * between screens, so a cached answer goes stale exactly when it matters.
 */
export async function queryMouseModes(name: string): Promise<MouseModes> {
  const format = [
    "#{mouse_any_flag}",
    "#{mouse_standard_flag}",
    "#{mouse_button_flag}",
    "#{mouse_all_flag}",
    "#{mouse_sgr_flag}",
    "#{mouse_utf8_flag}",
  ].join(" ");
  const result = await tmux(["display-message", "-p", "-t", paneTarget(name), format]);
  const fields = result.stdout.trim().split(/\s+/);
  return {
    any: fields[0] === "1",
    standard: fields[1] === "1",
    button: fields[2] === "1",
    all: fields[3] === "1",
    sgr: fields[4] === "1",
    utf8: fields[5] === "1",
  };
}

/**
 * Inject raw bytes into a pane, one tmux call per sequence.
 *
 * Sent as hex through `send-keys -H`, which is the only way to deliver arbitrary bytes without tmux
 * interpreting them as key names.
 */
async function sendRawBytes(name: string, sequences: readonly number[][]): Promise<void> {
  const target = paneTarget(name);
  for (const bytes of sequences) {
    await tmuxOrThrow(["send-keys", "-t", target, "-H", ...toHexArgs(bytes)]);
  }
}

/** Shared options for the mouse commands. */
export interface MouseSendOptions {
  /** Force an encoding instead of detecting it. Mostly useful for tests. */
  encoding?: MouseEncoding;
  /** Use already-queried modes rather than asking tmux again. */
  modes?: MouseModes;
  /** Pause between the events that make up one gesture. */
  delayMs?: number;
}

/** Decide which wire encoding to use: explicit, from supplied modes, or by asking tmux. */
async function encodingFor(name: string, options: MouseSendOptions): Promise<MouseEncoding> {
  if (options.encoding) return options.encoding;
  const modes = options.modes ?? (await queryMouseModes(name));
  return pickEncoding(modes);
}

/**
 * Click at a cell.
 *
 * Coordinates are zero-based, as everywhere else in the tool. A `count` above 1 sends repeated
 * press/release pairs with a gap short enough for the application to read them as a double click.
 *
 * @returns The encoding used, so the caller can report it.
 */
export async function mouseClick(
  name: string,
  x: number,
  y: number,
  button: MouseButton,
  modifiers: MouseModifiers,
  options: MouseSendOptions & { count?: number } = {},
): Promise<MouseEncoding> {
  const encoding = await encodingFor(name, options);
  const count = Math.max(1, options.count ?? 1);
  for (let index = 0; index < count; index += 1) {
    await sendRawBytes(name, clickSequence(x, y, button, modifiers, encoding));
    if (index + 1 < count) await sleep(options.delayMs ?? 40);
  }
  return encoding;
}

/**
 * Move the pointer, producing a motion event.
 *
 * Only reaches an application in button-event (1002) or any-event (1003) tracking; in normal
 * tracking the event is simply not reported.
 */
export async function mouseMove(
  name: string,
  x: number,
  y: number,
  modifiers: MouseModifiers,
  options: MouseSendOptions & { button?: MouseButton } = {},
): Promise<MouseEncoding> {
  const encoding = await encodingFor(name, options);
  const button = options.button ?? "none";
  await sendRawBytes(name, [
    encodeMouseEvent({ x, y, button, action: "motion", modifiers }, encoding),
  ]);
  return encoding;
}

/**
 * Press, move through intermediate cells, and release.
 *
 * The intermediate motion events are the point: an application tracking a drag needs to see the
 * path, and a press followed straight by a release somewhere else looks like two unrelated clicks.
 *
 * @throws {UsageError} If asked to drag with a wheel direction, which has no press or release.
 */
export async function mouseDrag(
  name: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
  button: MouseButton,
  modifiers: MouseModifiers,
  options: MouseSendOptions & { steps?: number } = {},
): Promise<MouseEncoding> {
  if (isWheel(button)) throw new UsageError("drag requires a real button, not a wheel");
  const encoding = await encodingFor(name, options);
  const steps = Math.max(1, options.steps ?? 4);
  const delay = options.delayMs ?? 20;

  await sendRawBytes(name, [
    encodeMouseEvent({ x: from.x, y: from.y, button, action: "press", modifiers }, encoding),
  ]);
  for (let step = 1; step <= steps; step += 1) {
    const ratio = step / steps;
    const x = Math.round(from.x + (to.x - from.x) * ratio);
    const y = Math.round(from.y + (to.y - from.y) * ratio);
    await sleep(delay);
    await sendRawBytes(name, [
      encodeMouseEvent({ x, y, button, action: "motion", modifiers }, encoding),
    ]);
  }
  await sleep(delay);
  await sendRawBytes(name, [
    encodeMouseEvent({ x: to.x, y: to.y, button, action: "release", modifiers }, encoding),
  ]);
  return encoding;
}

/**
 * Turn the mouse wheel.
 *
 * A wheel event is a press with no release, repeated once per notch — which is exactly what a real
 * wheel produces, and what applications count to decide how far to scroll.
 */
export async function mouseScroll(
  name: string,
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right",
  amount: number,
  modifiers: MouseModifiers,
  options: MouseSendOptions = {},
): Promise<MouseEncoding> {
  const encoding = await encodingFor(name, options);
  const button = `wheel-${direction}` as MouseButton;
  const times = Math.max(1, amount);
  for (let index = 0; index < times; index += 1) {
    await sendRawBytes(name, [
      encodeMouseEvent({ x, y, button, action: "press", modifiers }, encoding),
    ]);
    if (index + 1 < times) await sleep(options.delayMs ?? 15);
  }
  return encoding;
}
