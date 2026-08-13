/**
 * Small shared helpers: argument value parsing, JSON/JSONL persistence, and the process liveness
 * check the watchdog and recorder both depend on.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";

import { UsageError } from "./errors.js";

/** Terminal dimensions in character cells. */
export interface Size {
  /** Width in columns. */
  cols: number;
  /** Height in rows. */
  rows: number;
}

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i;
const SIZE_PATTERN = /^(\d+)\s*[x×]\s*(\d+)$/i;

/**
 * Parse a human duration such as `250ms`, `2s`, `10m` or `1h` into milliseconds.
 *
 * A bare number is milliseconds, which keeps `--settle 300` working. This is the single place
 * durations are interpreted, so every `--timeout`, `--interval`, `--ttl` and `--delay` accepts the
 * same spellings.
 *
 * @param input - The raw option value, or `undefined` when the option was not given.
 * @param fallback - Milliseconds to use when `input` is absent or empty.
 * @throws {UsageError} If the value is present but unparseable.
 */
export function parseDuration(input: string | number | undefined, fallback: number): number {
  if (input === undefined || input === "") return fallback;
  if (typeof input === "number") return Math.round(input);
  const match = DURATION_PATTERN.exec(input.trim());
  if (!match) throw new UsageError(`invalid duration: ${input} (use 250ms, 2s, 1m)`);
  const value = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(value * multiplier);
}

/**
 * Parse a `COLSxROWS` terminal size, as accepted by `--size`.
 *
 * The bounds are sanity limits rather than tmux limits: a size outside them is far more likely to
 * be a typo than an intention, and a TUI given absurd dimensions fails in confusing ways.
 *
 * @param input - The raw option value, e.g. `120x32`. `×` is accepted as well as `x`.
 * @param fallback - The size to use when `input` is absent or empty.
 * @throws {UsageError} If the value is malformed or out of range.
 */
export function parseSize(input: string | undefined, fallback: Size): Size {
  if (input === undefined || input === "") return fallback;
  const match = SIZE_PATTERN.exec(input.trim());
  if (!match) throw new UsageError(`invalid size: ${input} (use COLSxROWS, e.g. 120x32)`);
  const cols = Number(match[1]);
  const rows = Number(match[2]);
  if (cols < 20 || cols > 1000) throw new UsageError(`columns out of range: ${cols}`);
  if (rows < 5 || rows > 500) throw new UsageError(`rows out of range: ${rows}`);
  return { cols, rows };
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A short content hash, used to tell whether a screen actually changed.
 *
 * Truncated to 12 hex characters deliberately: this decides "is this the same screen", never
 * anything security-sensitive, and the short form stays readable in `frames.jsonl` and `--json`.
 */
export function hashText(input: string): string {
  return createHash("sha1").update(input).digest("hex").slice(0, 12);
}

/**
 * Quote an argument vector for `/bin/sh`.
 *
 * tmux takes several of its arguments as shell command strings, so anything built from a path or a
 * user-supplied value has to survive spaces and metacharacters on the way through.
 */
export function shellQuote(argv: readonly string[]): string {
  return argv.map(quoteOne).join(" ");
}

/** Single-quote one argument unless it is made entirely of characters the shell leaves alone. */
function quoteOne(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Format a timestamp for use in a filename: `20260813T182301537`.
 *
 * Compact ISO-8601 with the separators removed, so frame files sort chronologically by name and
 * stay legible in a directory listing.
 */
export function stampFor(date: Date): string {
  const iso = date.toISOString();
  return iso.replaceAll("-", "").replaceAll(":", "").replace(".", "").replace("Z", "");
}

/**
 * Format a duration the way it is shown in snapshot headers and `tui ls`: `840ms`, `2.2s`, `24m01s`.
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  /* Seconds are rounded before the split, so computing minutes from the raw value would let a
     rounded 60 through and print "24m60s". */
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Create a directory and every missing parent. Succeeds if it already exists. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

/**
 * Read a JSON-lines file into an array.
 *
 * A missing file reads as empty and unparseable lines are skipped rather than thrown: the frame
 * index is appended to by a background recorder, so a torn final line is a normal thing to find and
 * must not take down the command that is reading it.
 *
 * @typeParam T - The shape each line is expected to hold. Not validated at runtime.
 */
export async function readJsonl<T>(path: string): Promise<T[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  const raw = await file.text();
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      continue;
    }
  }
  return out;
}

/** Append one entry to a JSON-lines file, creating it if needed. */
export async function appendJsonl(path: string, entry: unknown): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

/**
 * Read and parse a JSON file, returning `undefined` if it is missing or corrupt.
 *
 * Session metadata is read on nearly every command, including while another process may be writing
 * it, so an unreadable file has to mean "not there" rather than an exception.
 *
 * @typeParam T - The shape the file is expected to hold. Not validated at runtime.
 */
export async function readJson<T>(path: string): Promise<T | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return (await file.json()) as T;
  } catch {
    return undefined;
  }
}

/** Write a value as pretty-printed JSON with a trailing newline. */
export async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Whether a process is still running.
 *
 * A bare PID check cannot tell a live process from a recycled PID, so callers that know what the
 * process should be can pass a marker to match against its command line. Where /proc is absent
 * (macOS) the marker is ignored and the PID check stands on its own.
 *
 * @param pid - The process id to test.
 * @param commandMarker - A substring expected in the process's command line, used to reject a
 * recycled PID that now belongs to something else.
 */
export function isProcessAlive(pid: number, commandMarker?: string): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    /* EPERM means the process exists but belongs to someone else, which still counts as alive. */
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (commandMarker === undefined) return true;
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(commandMarker);
  } catch {
    return true;
  }
}
