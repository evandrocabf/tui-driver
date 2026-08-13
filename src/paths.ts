/**
 * Every path the tool writes to, derived in one place from a single root.
 *
 * The root is state, not config or cache: it holds live sessions and their recorded frames, which
 * are neither user-authored nor safely discardable while a session is running. Hence
 * `$XDG_STATE_HOME` rather than `$XDG_CONFIG_HOME` or `$XDG_CACHE_HOME`.
 */

import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Practical ceiling for a unix socket path.
 *
 * The kernel limit is 108 bytes on Linux and 104 on macOS, both including the terminator, and tmux
 * appends to the path internally. 95 leaves room for both.
 */
const MAX_UNIX_SOCKET_PATH = 95;

/**
 * The root directory for all tui-driver state.
 *
 * `TUI_DRIVER_HOME` overrides everything, which is what the test suite uses to isolate itself, and
 * what lets several unrelated runs coexist on one machine.
 */
export function rootDir(): string {
  const explicit = process.env["TUI_DRIVER_HOME"];
  if (explicit && explicit !== "") return explicit;
  const xdgState = process.env["XDG_STATE_HOME"];
  if (xdgState && xdgState !== "") return join(xdgState, "tui-driver");
  return join(homedir(), ".local", "state", "tui-driver");
}

/**
 * The socket for our private tmux server.
 *
 * Normally this sits inside {@link rootDir}, which keeps everything in one place. Unix socket paths
 * are capped near 108 bytes, though, and a deep `TUI_DRIVER_HOME` blows through that — so an
 * over-long path falls back to a name in the temp directory, hashed from the root so it stays
 * stable across commands and distinct per root. The uid is included so two users cannot collide.
 */
export function socketPath(): string {
  const preferred = join(rootDir(), "tmux.sock");
  if (Buffer.byteLength(preferred) <= MAX_UNIX_SOCKET_PATH) return preferred;
  const digest = createHash("sha1").update(rootDir()).digest("hex").slice(0, 10);
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `tui-driver-${uid}-${digest}.sock`);
}

/**
 * The config file for our private tmux server: status bar off, no key bindings, panes kept after
 * the process exits.
 */
export function tmuxConfPath(): string {
  return join(rootDir(), "tmux.conf");
}

/** The directory holding one subdirectory per session. */
function sessionsRoot(): string {
  return join(rootDir(), "sessions");
}

/** Everything belonging to one session: metadata, frames, recorder state. */
export function sessionDir(name: string): string {
  return join(sessionsRoot(), name);
}

/**
 * Where a session's captured frames live — text, ANSI, and any rendered images.
 *
 * This is also where `render` and `snap --png` write by default, so images stay out of whatever
 * directory the caller happened to be in.
 */
export function framesDir(name: string): string {
  return join(sessionDir(name), "frames");
}

/** A session's metadata file: command, cwd, size, start time and lease. */
export function metaPath(name: string): string {
  return join(sessionDir(name), "session.json");
}

/** A session's frame index, one JSON record per line in capture order. */
export function framesIndexPath(name: string): string {
  return join(sessionDir(name), "frames.jsonl");
}

/** Where the background recorder records its pid, so a later command can find and stop it. */
export function watcherPath(name: string): string {
  return join(sessionDir(name), "watcher.json");
}

/** The background recorder's own log, for diagnosing a recorder that died. */
export function watcherLogPath(name: string): string {
  return join(sessionDir(name), "watcher.log");
}

/** Where `start --raw-log` streams the pane's raw output. */
export function pipeLogPath(name: string): string {
  return join(sessionDir(name), "raw-output.log");
}
