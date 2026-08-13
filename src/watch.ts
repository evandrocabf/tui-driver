/**
 * The background recorder: a frame saved every time the screen actually changes.
 *
 * Frames are content-hashed, so an idle TUI costs nothing on disk however long the recorder runs.
 * The recorder is a detached child process rather than a thread, so it outlives the command that
 * started it — which is the whole point, and also why it is tracked by pid and reaped deliberately.
 */

import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

import { capture } from "./capture.js";
import { DependencyError, UsageError } from "./errors.js";
import { listFrames, saveFrame } from "./frames.js";
import { sessionDir, watcherLogPath, watcherPath } from "./paths.js";
import type { RenderFormat } from "./render.js";
import { hasSession } from "./tmux.js";
import { ensureDir, isProcessAlive, readJson, sleep, writeJson } from "./util.js";

/** How the recorder should run. */
export interface WatcherOptions {
  /** How long to pause between captures. */
  intervalMs: number;
  /** Also render an image for each frame. */
  image?: RenderFormat;
  /** Stop after saving this many frames. */
  maxFrames?: number;
  /** Stop after this long. */
  durationMs?: number;
  /** Keep only the newest this many frames, deleting older files as it rolls. */
  keep?: number;
  /** Stop when the recorded process exits. */
  stopOnExit: boolean;
  /** Palette for rendered images. */
  theme?: string;
  /** Pixel scale factor for rendered images. */
  scale?: number;
}

/** A running recorder, as recorded in the session's `watcher.json`. */
export interface WatcherState extends WatcherOptions {
  /** The recorder process's pid. */
  pid: number;
  /** The session being recorded. */
  session: string;
  /** When recording started, as an ISO-8601 string. */
  startedAt: string;
}

/**
 * The hidden subcommand the detached child runs.
 *
 * Also used as the marker for the liveness check, so a recycled pid belonging to something else is
 * not mistaken for a live recorder.
 */
const DAEMON_COMMAND = "watch-daemon";

/** This CLI's entry point, which the recorder re-executes as a detached child. */
function cliEntry(): string {
  return join(import.meta.dir, "..", "bin", "tui.ts");
}

/**
 * The recorder re-executes this CLI as a detached child, which only works under bun: the entry
 * point is TypeScript and the spawn passes bun's `run` subcommand.
 */
function assertBunRuntime(): void {
  if (!process.versions.bun) {
    throw new DependencyError(
      "the background recorder needs the bun runtime — run the CLI with bun, or record in this process with: tui watch <session> --foreground",
    );
  }
}

/**
 * The recorder running for a session, if there is one.
 *
 * A state file whose process is gone is deleted on the way through, so a recorder killed with the
 * rest of a process group does not block the next `tui watch`.
 */
export async function readWatcher(name: string): Promise<WatcherState | undefined> {
  const state = await readJson<WatcherState>(watcherPath(name));
  if (!state) return undefined;
  if (!isProcessAlive(state.pid, DAEMON_COMMAND)) {
    await rm(watcherPath(name), { force: true });
    return undefined;
  }
  return state;
}

/**
 * Spawn a detached recorder for a session.
 *
 * Its output goes to the session's `watcher.log`, since a detached process has nowhere else to put
 * a stack trace, and a recorder that died silently is otherwise very hard to diagnose.
 *
 * @throws {UsageError} If a recorder is already running for this session.
 * @throws {DependencyError} If the runtime is not bun.
 */
export async function startWatcher(name: string, options: WatcherOptions): Promise<WatcherState> {
  assertBunRuntime();
  const existing = await readWatcher(name);
  if (existing) {
    throw new UsageError(
      `a watcher is already recording "${name}" (pid ${existing.pid}) — stop it with: tui watch ${name} --stop`,
    );
  }

  await ensureDir(sessionDir(name));
  const logFd = openSync(watcherLogPath(name), "a");

  const args = ["run", cliEntry(), DAEMON_COMMAND, name, "--interval", String(options.intervalMs)];
  if (options.image) args.push("--image", options.image);
  if (options.maxFrames !== undefined) args.push("--max-frames", String(options.maxFrames));
  if (options.durationMs !== undefined) args.push("--duration", String(options.durationMs));
  if (options.keep !== undefined) args.push("--keep", String(options.keep));
  if (options.theme) args.push("--theme", options.theme);
  if (options.scale !== undefined) args.push("--scale", String(options.scale));
  if (!options.stopOnExit) args.push("--no-stop-on-exit");

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  closeSync(logFd);

  if (child.pid === undefined) throw new UsageError("failed to spawn the watcher process");

  const state: WatcherState = {
    ...options,
    pid: child.pid,
    session: name,
    startedAt: new Date().toISOString(),
  };
  await writeJson(watcherPath(name), state);
  return state;
}

/**
 * Stop a session's recorder.
 *
 * The state file is removed first, so a recorder that cannot be signalled still leaves nothing
 * behind that would block the next one.
 *
 * @returns True if a live recorder was signalled.
 */
export async function stopWatcher(name: string): Promise<boolean> {
  const state = await readJson<WatcherState>(watcherPath(name));
  await rm(watcherPath(name), { force: true });
  if (!state) return false;
  if (!isProcessAlive(state.pid, DAEMON_COMMAND)) return false;
  try {
    process.kill(state.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/**
 * The recording loop itself, run by the detached child and by `--foreground`.
 *
 * Exits on any of: the session disappearing, a capture failing, the recorded process exiting, the
 * frame budget, the time budget, or a signal. A failed capture ends the loop rather than retrying —
 * it means the session is going away, and a recorder that outlives its session is the leak this is
 * all built to avoid.
 *
 * @returns How many frames were saved.
 */
export async function runWatchLoop(name: string, options: WatcherOptions): Promise<number> {
  let running = true;
  const stop = (): void => {
    running = false;
  };
  /* Removed in the finally below: --foreground can be called repeatedly in one process, and the
     handlers would otherwise accumulate. */
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const deadline = options.durationMs === undefined ? undefined : Date.now() + options.durationMs;
  let lastHash: string | undefined;
  let saved = 0;

  try {
    while (running) {
      if (!(await hasSession(name))) break;

      let snapshot;
      try {
        snapshot = await capture(name);
      } catch {
        break;
      }

      if (snapshot.hash !== lastHash) {
        lastHash = snapshot.hash;
        await saveFrame(name, snapshot, {
          kind: "auto",
          ...(options.image ? { image: options.image } : {}),
          ...(options.theme ? { theme: options.theme } : {}),
          ...(options.scale ? { scale: options.scale } : {}),
        });
        saved += 1;
        if (options.keep !== undefined && options.keep > 0) await pruneFrames(name, options.keep);
      }

      if (snapshot.dead && options.stopOnExit) break;
      if (options.maxFrames !== undefined && saved >= options.maxFrames) break;
      if (deadline !== undefined && Date.now() >= deadline) break;

      await sleep(options.intervalMs);
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }

  await rm(watcherPath(name), { force: true });
  return saved;
}

/**
 * Delete the oldest frames beyond the rolling window.
 *
 * Only the files go; the index keeps its entries, and {@link listFrames} filters out the ones whose
 * files have gone. Rewriting an append-only log from a background process is not worth the risk.
 */
async function pruneFrames(name: string, keep: number): Promise<void> {
  const frames = await listFrames(name);
  const excess = frames.length - keep;
  if (excess <= 0) return;
  for (const frame of frames.slice(0, excess)) {
    await rm(frame.files.text, { force: true });
    await rm(frame.files.ansi, { force: true });
    if (frame.files.image) await rm(frame.files.image, { force: true });
  }
}
