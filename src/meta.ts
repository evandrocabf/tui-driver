/**
 * The record kept on disk for each session.
 *
 * tmux knows a session exists, but not what it was asked to run, at what size, or how long it is
 * allowed to live. That is what this file holds, and it is what lets any later command — in a
 * different process, minutes later — say something useful about a session it did not start.
 */

import { metaPath, sessionDir } from "./paths.js";
import { ensureDir, readJson, writeJson } from "./util.js";

/** Everything known about a session that tmux does not track itself. */
export interface SessionMeta {
  /** The session name, which is also its directory name and its tmux target. */
  name: string;
  /** The program that was launched. */
  command: string;
  /** The full argument vector, as given after `--`. */
  argv: string[];
  /** The working directory it was launched in. */
  cwd: string;
  /** Pinned width in columns. */
  cols: number;
  /** Pinned height in rows. */
  rows: number;
  /** Environment overrides the session was started with. */
  env: Record<string, string>;
  /** Start time as an ISO-8601 string. */
  startedAt: string;
  /** Start time in milliseconds since the epoch, used to compute the `+2.2s` in capture headers. */
  startedAtMs: number;
  /** Lease length in milliseconds; 0 means the session never expires. */
  ttlMs?: number;
  /** When the lease runs out and the session is reaped; 0 means never. */
  expiresAtMs?: number;
}

/** Write a session's metadata, creating its directory if this is the first write. */
export async function writeMeta(meta: SessionMeta): Promise<void> {
  await ensureDir(sessionDir(meta.name));
  await writeJson(metaPath(meta.name), meta);
}

/**
 * Read a session's metadata.
 *
 * Returns `undefined` for a session started by an older version or by hand, as well as for one that
 * does not exist — callers treat both the same way, falling back to tmux's own creation time.
 */
export async function readMeta(name: string): Promise<SessionMeta | undefined> {
  return readJson<SessionMeta>(metaPath(name));
}
