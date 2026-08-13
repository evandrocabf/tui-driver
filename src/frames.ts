/**
 * The frame store: every screen this tool has captured, kept so it can be re-read or re-rendered
 * later.
 *
 * Both the plain text and the ANSI are written for every frame. The ANSI is what makes any frame
 * renderable to an image after the fact — you never have to decide up front whether you will want a
 * picture of it.
 */

import { join } from "node:path";

import type { CursorState, Snapshot } from "./capture.js";
import { UsageError } from "./errors.js";
import { framesDir, framesIndexPath } from "./paths.js";
import { renderAnsiToFile, type RenderFormat } from "./render.js";
import { appendJsonl, ensureDir, readJsonl, stampFor } from "./util.js";

/** Where a frame came from: the background recorder (`auto`) or an explicit `snap` (`snap`). */
export type FrameKind = "auto" | "snap";

/**
 * One recorded frame, as stored in the session's `frames.jsonl`.
 *
 * This carries the snapshot's metadata but not its content: the screen itself lives in the files
 * named by {@link FrameRecord.files}, so the index stays small enough to read in full on every
 * command.
 */
export interface FrameRecord {
  /** Timestamp-based identifier, also the base name of the frame's files. Sorts chronologically. */
  id: string;
  kind: FrameKind;
  /** The name given by `--label`, if any. Frames can be referenced by it. */
  label?: string;
  /** Capture time as an ISO-8601 string. */
  capturedAt: string;
  /** How long the session had been running when this was captured. */
  elapsedMs: number;
  /** Content hash of the ANSI, which is how the recorder tells a repaint from an idle screen. */
  hash: string;
  /** Screen width in columns at capture time. */
  cols: number;
  /** Screen height in rows at capture time. */
  rows: number;
  /** Cursor position and visibility at capture time. */
  cursor: CursorState;
  /** Whether the pane's process had already exited. */
  dead: boolean;
  /** The command tmux reported as running in the pane. */
  command: string;
  /** Absolute paths to this frame's files. */
  files: {
    /** The screen as plain text. */
    text: string;
    /** The screen with ANSI escapes, which is what any later render reads. */
    ansi: string;
    /** A rendered image, if one was asked for at capture time. */
    image?: string;
  };
}

/** How to store a frame. */
export interface SaveFrameOptions {
  kind: FrameKind;
  /** A name to reference this frame by later. */
  label?: string;
  /** Also render an image now. Any frame can be rendered later regardless. */
  image?: RenderFormat;
  /** Palette for that image. */
  theme?: string;
  /** Cell font size for that image. */
  fontSize?: number;
  /** Pixel scale factor for that image. */
  scale?: number;
}

const LABEL_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Reject a label that would not make a safe file name.
 *
 * Labels become part of a path, so anything with a separator or a shell metacharacter in it is
 * turned away here rather than producing a file somewhere unexpected.
 *
 * @throws {UsageError} If the label contains anything but letters, digits, dot, dash or underscore.
 */
export function assertLabel(label: string): void {
  if (!LABEL_PATTERN.test(label)) {
    throw new UsageError(`invalid label "${label}" (use letters, digits, dot, dash, underscore)`);
  }
}

/**
 * Find an unused frame id, appending a counter if needed.
 *
 * Timestamps have millisecond resolution, so two captures in the same millisecond — or two frames
 * sharing a label — would otherwise overwrite each other's files.
 */
async function uniqueFrameId(name: string, base: string): Promise<string> {
  let candidate = base;
  let counter = 1;
  while (await Bun.file(join(framesDir(name), `${candidate}.txt`)).exists()) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

/**
 * Write a snapshot to the frame store and append it to the session's index.
 *
 * The record is appended only after every file is on disk, so a reader never finds an index entry
 * pointing at a file that is not there yet.
 */
export async function saveFrame(
  name: string,
  snapshot: Snapshot,
  options: SaveFrameOptions,
): Promise<FrameRecord> {
  const directory = framesDir(name);
  await ensureDir(directory);

  const stamp = stampFor(new Date(snapshot.capturedAtMs));
  const base = options.label ? `${stamp}-${options.label}` : stamp;
  const id = await uniqueFrameId(name, base);

  const textPath = join(directory, `${id}.txt`);
  const ansiPath = join(directory, `${id}.ansi`);
  await Bun.write(textPath, `${snapshot.text}\n`);
  await Bun.write(ansiPath, snapshot.ansi);

  let imagePath: string | undefined;
  if (options.image) {
    const extension = options.image === "svg" ? "svg" : "png";
    imagePath = join(directory, `${id}.${extension}`);
    await renderAnsiToFile(snapshot.ansi, imagePath, {
      cols: snapshot.cols,
      rows: snapshot.rows,
      cursor: snapshot.cursor,
      format: options.image,
      ...(options.theme ? { theme: options.theme } : {}),
      ...(options.fontSize ? { fontSize: options.fontSize } : {}),
      ...(options.scale ? { scale: options.scale } : {}),
      title: `${name} @ ${snapshot.capturedAt}`,
    });
  }

  const record: FrameRecord = {
    id,
    kind: options.kind,
    ...(options.label ? { label: options.label } : {}),
    capturedAt: snapshot.capturedAt,
    elapsedMs: snapshot.elapsedMs,
    hash: snapshot.hash,
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursor: snapshot.cursor,
    dead: snapshot.dead,
    command: snapshot.command,
    files: {
      text: textPath,
      ansi: ansiPath,
      ...(imagePath ? { image: imagePath } : {}),
    },
  };

  await appendJsonl(framesIndexPath(name), record);
  return record;
}

/**
 * Every frame recorded for a session, oldest first.
 *
 * The index is append-only but the files are not: `watch --keep` prunes old frames as it rolls, so
 * entries whose files are gone are filtered out unless `includePruned` asks for them.
 */
export async function listFrames(
  name: string,
  options: { includePruned?: boolean } = {},
): Promise<FrameRecord[]> {
  const records = await readJsonl<FrameRecord>(framesIndexPath(name));
  if (options.includePruned) return records;
  const alive: FrameRecord[] = [];
  for (const record of records) {
    if (await Bun.file(record.files.text).exists()) alive.push(record);
  }
  return alive;
}

/**
 * Resolve a frame reference as written on the command line.
 *
 * Accepted, in the order they are tried: `last` (the default) and `first`; a negative offset from
 * the end (`-1` is the one before last); a positive index from the start; an exact frame id; and
 * finally a label, matched newest-first so a repeated label refers to the most recent one.
 *
 * @throws {UsageError} If the session has no frames, or nothing matches the reference.
 */
export async function resolveFrame(
  name: string,
  reference: string | undefined,
): Promise<FrameRecord> {
  const frames = await listFrames(name);
  if (frames.length === 0) throw new UsageError(`no frames recorded for session "${name}"`);

  const wanted = reference ?? "last";
  if (wanted === "last" || wanted === "-0") {
    const last = frames[frames.length - 1];
    if (!last) throw new UsageError(`no frames recorded for session "${name}"`);
    return last;
  }
  if (wanted === "first") {
    const first = frames[0];
    if (!first) throw new UsageError(`no frames recorded for session "${name}"`);
    return first;
  }

  const relative = /^-(\d+)$/.exec(wanted);
  if (relative) {
    const back = Number.parseInt(relative[1] ?? "0", 10);
    const frame = frames[frames.length - 1 - back];
    if (!frame) throw new UsageError(`frame ${wanted} is out of range (${frames.length} frames)`);
    return frame;
  }

  const positional = /^\d+$/.exec(wanted);
  if (positional) {
    const frame = frames[Number.parseInt(wanted, 10)];
    if (frame) return frame;
  }

  const byId = frames.find((frame) => frame.id === wanted);
  if (byId) return byId;

  const byLabel = [...frames].reverse().find((frame) => frame.label === wanted);
  if (byLabel) return byLabel;

  throw new UsageError(`no frame matching "${wanted}" in session "${name}"`);
}

/** Read a frame's plain text, or `""` if the file has since been pruned. */
export async function readFrameText(frame: FrameRecord): Promise<string> {
  const file = Bun.file(frame.files.text);
  if (!(await file.exists())) return "";
  return file.text();
}

/** Read a frame's ANSI, or `""` if the file has since been pruned. */
export async function readFrameAnsi(frame: FrameRecord): Promise<string> {
  const file = Bun.file(frame.files.ansi);
  if (!(await file.exists())) return "";
  return file.text();
}
