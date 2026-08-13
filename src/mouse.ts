/**
 * Encoding mouse events in the wire protocol the application itself turned on.
 *
 * There is no single "mouse protocol": a terminal application enables one of several tracking modes
 * and one of several coordinate encodings, and only then does it understand mouse bytes at all.
 * tmux reports which it chose, so every event is encoded to match rather than guessed at — which is
 * what makes clicks land in both modern (SGR) and legacy (x10) applications.
 */

import { UsageError } from "./errors.js";

/** A mouse button, or a wheel direction, which the protocol encodes the same way. */
export type MouseButton =
  "left" | "middle" | "right" | "wheel-up" | "wheel-down" | "wheel-left" | "wheel-right" | "none";

/** What the pointer did. `motion` is a move with or without a button held. */
export type MouseAction = "press" | "release" | "motion";

/**
 * How coordinates are written on the wire.
 *
 * - `sgr` (1006) — the modern encoding, no coordinate limit. Preferred whenever available.
 * - `utf8` (1005) — legacy, coordinates as UTF-8 code points.
 * - `x10` — the original single-byte encoding. Unreliable past column/row 94.
 */
export type MouseEncoding = "sgr" | "utf8" | "x10";

/**
 * The mouse reporting modes an application has enabled, as tmux reports them.
 *
 * When {@link MouseModes.any} is false the application is not listening at all, and injected mouse
 * bytes would be swallowed — which is why the commands warn instead of silently doing nothing.
 */
export interface MouseModes {
  /** Any mouse reporting at all is on. */
  any: boolean;
  /** Normal tracking (1000): press and release only. */
  standard: boolean;
  /** Button-event tracking (1002): also motion while a button is held. */
  button: boolean;
  /** Any-event tracking (1003): also motion with no button held. */
  all: boolean;
  /** SGR coordinate encoding (1006) is on. */
  sgr: boolean;
  /** UTF-8 coordinate encoding (1005) is on. */
  utf8: boolean;
}

/** Modifier keys held during a mouse event. */
export interface MouseModifiers {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** A single mouse event, in the zero-based cell coordinates used throughout the tool. */
export interface MouseEventSpec {
  /** Zero-based column. */
  x: number;
  /** Zero-based row. */
  y: number;
  button: MouseButton;
  action: MouseAction;
  modifiers: MouseModifiers;
}

/** No modifier keys held. Copy before mutating. */
export const NO_MODIFIERS: MouseModifiers = { shift: false, alt: false, ctrl: false };

/**
 * Base button numbers from the xterm protocol.
 *
 * 0-2 are the buttons, 3 is release in the legacy encodings, and the wheel occupies 64+.
 */
const BUTTON_CODES: Record<MouseButton, number> = {
  left: 0,
  middle: 1,
  right: 2,
  none: 3,
  "wheel-up": 64,
  "wheel-down": 65,
  "wheel-left": 66,
  "wheel-right": 67,
};

/**
 * Parse a `--button` value, accepting the obvious spellings and aliases.
 *
 * @param input - e.g. `left`, `r`, `3`, `wheel-down`. Defaults to `left`.
 * @throws {UsageError} On anything unrecognised.
 */
export function parseButton(input: string | undefined): MouseButton {
  const value = (input ?? "left").toLowerCase();
  if (value === "left" || value === "l" || value === "1") return "left";
  if (value === "middle" || value === "m" || value === "2") return "middle";
  if (value === "right" || value === "r" || value === "3") return "right";
  if (value === "wheel-up" || value === "up") return "wheel-up";
  if (value === "wheel-down" || value === "down") return "wheel-down";
  if (value === "wheel-left" || value === "left-scroll") return "wheel-left";
  if (value === "wheel-right" || value === "right-scroll") return "wheel-right";
  if (value === "none") return "none";
  throw new UsageError(`unknown mouse button: ${input}`);
}

/**
 * Parse a `--modifiers` value such as `ctrl+shift`, `alt,ctrl` or `meta shift`.
 *
 * @throws {UsageError} On an unrecognised modifier name.
 */
export function parseModifiers(input: string | undefined): MouseModifiers {
  if (!input || input === "") return { ...NO_MODIFIERS };
  const modifiers: MouseModifiers = { ...NO_MODIFIERS };
  for (const rawPart of input.split(/[,+\s]+/)) {
    const part = rawPart.trim().toLowerCase();
    if (part === "") continue;
    if (part === "shift") modifiers.shift = true;
    else if (part === "alt" || part === "meta" || part === "option") modifiers.alt = true;
    else if (part === "ctrl" || part === "control") modifiers.ctrl = true;
    else throw new UsageError(`unknown modifier: ${part} (use ctrl, alt, shift)`);
  }
  return modifiers;
}

/** Whether this is a wheel direction rather than a real button. Wheels have no release event. */
export function isWheel(button: MouseButton): boolean {
  return button.startsWith("wheel-");
}

/**
 * Choose the encoding to send, given what the application enabled.
 *
 * Best-first: SGR has no coordinate limit, UTF-8 raises it, x10 is the fallback that every
 * mouse-aware terminal application understands.
 */
export function pickEncoding(modes: MouseModes): MouseEncoding {
  if (modes.sgr) return "sgr";
  if (modes.utf8) return "utf8";
  return "x10";
}

/**
 * Describe the mouse modes for a snapshot header: `button-event(1002)/sgr(1006)`, or `off`.
 *
 * The mode numbers are included on purpose — they are what you search for when a click does not
 * land, and they name the exact thing the application asked for.
 */
export function describeModes(modes: MouseModes): string {
  if (!modes.any) return "off";
  const tracking = modes.all
    ? "any-event(1003)"
    : modes.button
      ? "button-event(1002)"
      : modes.standard
        ? "normal(1000)"
        : "on";
  const encoding = modes.sgr ? "sgr(1006)" : modes.utf8 ? "utf8(1005)" : "x10";
  return `${tracking}/${encoding}`;
}

/**
 * Build the protocol's button byte: base button, plus the motion and modifier bits.
 *
 * SGR reports the real button on release and distinguishes it with a trailing `m`; the legacy
 * encodings have no such marker and must report the "any button released" code 3 instead.
 */
function buttonCode(spec: MouseEventSpec, encoding: MouseEncoding): number {
  let code = BUTTON_CODES[spec.button];
  if (spec.action === "release" && encoding !== "sgr" && !isWheel(spec.button)) code = 3;
  if (spec.action === "motion") code += 32;
  if (spec.modifiers.shift) code += 4;
  if (spec.modifiers.alt) code += 8;
  if (spec.modifiers.ctrl) code += 16;
  return code;
}

/**
 * Encode one mouse event as the exact bytes to inject into the pane.
 *
 * The protocol is 1-based; the 0-based coordinates used everywhere else are converted here, so this
 * is the only place the two conventions meet. The legacy encodings also add the historical 32
 * offset to every value.
 *
 * @returns The byte sequence, ready to be sent to the pane.
 */
export function encodeMouseEvent(spec: MouseEventSpec, encoding: MouseEncoding): number[] {
  const column = spec.x + 1;
  const row = spec.y + 1;
  const code = buttonCode(spec, encoding);

  if (encoding === "sgr") {
    const final = spec.action === "release" && !isWheel(spec.button) ? "m" : "M";
    return [0x1b, ...Buffer.from(`[<${code};${column};${row}${final}`, "utf8")];
  }

  const header = [0x1b, 0x5b, 0x4d];
  if (encoding === "utf8") {
    return [
      ...header,
      ...Buffer.from(String.fromCodePoint(code + 32), "utf8"),
      ...Buffer.from(String.fromCodePoint(column + 32), "utf8"),
      ...Buffer.from(String.fromCodePoint(row + 32), "utf8"),
    ];
  }

  return [...header, clampLegacy(code + 32), clampLegacy(column + 32), clampLegacy(row + 32)];
}

/** Keep a legacy-encoded value inside one byte. Coordinates past the limit are already warned about. */
function clampLegacy(value: number): number {
  return Math.max(0, Math.min(255, value));
}

/**
 * Whether an event falls outside what the x10 encoding can express.
 *
 * x10 packs each coordinate into a single byte with a 32 offset, so anything past column or row 94
 * silently lands somewhere else. The CLI warns rather than failing, because the click may still be
 * what the caller wanted on a narrow screen.
 */
export function legacyOutOfRange(spec: MouseEventSpec, encoding: MouseEncoding): boolean {
  if (encoding !== "x10") return false;
  return spec.x + 1 + 32 > 0x7f || spec.y + 1 + 32 > 0x7f;
}

/** Render bytes as two-digit hex, which is how they are handed to `tmux send-keys -H`. */
export function toHexArgs(bytes: readonly number[]): string[] {
  return bytes.map((byte) => byte.toString(16).padStart(2, "0"));
}

/**
 * The full byte sequence for a click: press then release.
 *
 * A wheel "click" is a single event — there is no release to send, and emitting one would be read
 * as a second scroll.
 *
 * @returns One byte sequence per event to inject, in order.
 */
export function clickSequence(
  x: number,
  y: number,
  button: MouseButton,
  modifiers: MouseModifiers,
  encoding: MouseEncoding,
): number[][] {
  if (isWheel(button)) {
    return [encodeMouseEvent({ x, y, button, action: "press", modifiers }, encoding)];
  }
  return [
    encodeMouseEvent({ x, y, button, action: "press", modifiers }, encoding),
    encodeMouseEvent({ x, y, button, action: "release", modifiers }, encoding),
  ];
}
