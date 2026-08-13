/**
 * Starting, sizing, listing and stopping sessions.
 *
 * A session is a detached tmux session with a pinned window size, a lease, and a metadata file
 * recording what it was asked to run. Pinning the size is what makes captures reproducible:
 * attaching to a session from a differently-sized terminal must not change what the TUI sees.
 */

import { rm } from "node:fs/promises";
import { basename } from "node:path";

import { SessionError, UsageError } from "./errors.js";
import { armWatchdog, defaultTtlMs, EXPIRES_OPTION, NEVER, setDeadline } from "./lifetime.js";
import { readMeta, writeMeta, type SessionMeta } from "./meta.js";
import { pipeLogPath, sessionDir, socketPath } from "./paths.js";
import { exactTarget, hasSession, listSessionNames, tmux, tmuxOrThrow } from "./tmux.js";
import { ensureDir, formatElapsed, shellQuote } from "./util.js";

/** A session name is also a directory name and a tmux target, so it is kept deliberately narrow. */
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** How to launch a session. */
export interface StartOptions {
  /** The session name. Derived from the command when omitted. */
  name?: string;
  /** The argument vector to run, as given after `--`. Taken literally. */
  argv: string[];
  /** A shell command string to run instead of {@link StartOptions.argv}. */
  shell?: string;
  /** Working directory for the launched program. Defaults to the caller's. */
  cwd?: string;
  /** Pinned width in columns. */
  cols: number;
  /** Pinned height in rows. */
  rows: number;
  /** Environment overrides for the launched program. */
  env?: Record<string, string>;
  /** Also stream the pane's raw output to a log file. */
  rawLog?: boolean;
  /** Lease length; defaults to DEFAULT_TTL_MS. 0 disables expiry (environment override only). */
  ttlMs?: number;
}

/** A live session as `tui ls` reports it: tmux's view, plus our own metadata when we have it. */
export interface SessionInfo {
  name: string;
  /** Current width in columns. */
  cols: number;
  /** Current height in rows. */
  rows: number;
  /** The command tmux reports as running in the pane. */
  command: string;
  /** Whether the pane's process has exited. The pane itself survives it. */
  dead: boolean;
  /** Its exit status, or `undefined` while it is still running. */
  exitStatus: number | undefined;
  /** The pane process's pid. */
  panePid: number;
  /** When tmux created the session, as an ISO-8601 string. */
  createdAt: string;
  /** When the lease runs out; `0` for never, `undefined` for a session with no lease at all. */
  expiresAtMs: number | undefined;
  /** Our own record, absent for a session started by an older version or by hand. */
  meta: SessionMeta | undefined;
}

/**
 * Reject a session name that would not be safe as a path or a tmux target.
 *
 * @throws {UsageError} If the name contains anything but letters, digits, dash and underscore.
 */
export function assertName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new UsageError(
      `invalid session name "${name}" (letters, digits, dash and underscore only)`,
    );
  }
}

/**
 * Invent a session name from the command being run, e.g. `htop-3f2a`.
 *
 * The random suffix is what keeps two parallel runs of the same program from colliding. Callers are
 * still encouraged to pass `--name`, which makes the session findable later.
 */
export function suggestName(argv: readonly string[], shell: string | undefined): string {
  const source = argv[0] ?? shell ?? "tui";
  const stem = basename(source.split(/\s+/)[0] ?? "tui").replace(/[^A-Za-z0-9_-]/g, "");
  const prefix = stem === "" ? "tui" : stem.slice(0, 24);
  const suffix = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `${prefix}-${suffix}`;
}

/**
 * The command a human can run to watch a session live.
 *
 * Printed by `tui start`, because our socket is not the default one and attaching to it is
 * otherwise not obvious.
 */
export function attachCommand(name: string): string {
  return `tmux -S ${socketPath()} attach -t ${name}`;
}

/**
 * Launch a program in a new detached session, pin its size, and arm its lease.
 *
 * `COLORTERM=truecolor` is set by default so applications that probe for colour support draw in
 * full colour, which is what makes a rendered image look like the real thing.
 *
 * Returns as soon as the session exists; waiting for the first paint is the caller's job, via
 * {@link waitUntilDrawn}.
 *
 * @throws {UsageError} If the name is taken, or there is nothing to run.
 */
export async function startSession(options: StartOptions): Promise<SessionMeta> {
  const name = options.name ?? suggestName(options.argv, options.shell);
  assertName(name);

  if (await hasSession(name)) {
    throw new UsageError(`session "${name}" already exists (stop it first: tui stop ${name})`);
  }

  if (options.argv.length === 0 && !options.shell) {
    throw new UsageError("nothing to run — pass a command after -- or use --shell");
  }

  const command = options.shell ?? shellQuote(options.argv);
  const cwd = options.cwd ?? process.cwd();
  const env: Record<string, string> = { COLORTERM: "truecolor", ...(options.env ?? {}) };

  await ensureDir(sessionDir(name));

  const args = [
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    String(options.cols),
    "-y",
    String(options.rows),
    "-c",
    cwd,
  ];
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(command);

  await tmuxOrThrow(args);
  await pinSize(name, options.cols, options.rows);

  if (options.rawLog) {
    /* tmux runs this through /bin/sh, so the path has to survive spaces and metacharacters. */
    const target = shellQuote([pipeLogPath(name)]);
    await tmux(["pipe-pane", "-t", `${exactTarget(name)}:`, "-O", `cat >> ${target}`]);
  }

  const startedAtMs = Date.now();
  const ttlMs = options.ttlMs ?? defaultTtlMs();
  const expiresAtMs = ttlMs === NEVER ? NEVER : startedAtMs + ttlMs;
  await setDeadline(name, expiresAtMs);
  if (expiresAtMs !== NEVER) armWatchdog(name);

  const meta: SessionMeta = {
    name,
    command,
    argv: [...options.argv],
    cwd,
    cols: options.cols,
    rows: options.rows,
    env,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    ttlMs,
    expiresAtMs,
  };
  await writeMeta(meta);
  return meta;
}

/** Push a running session's deadline back, and re-arm its watchdog in case that process died. */
export async function keepAlive(name: string, ttlMs: number): Promise<number> {
  await requireSession(name);
  const expiresAtMs = ttlMs === NEVER ? NEVER : Date.now() + ttlMs;
  await setDeadline(name, expiresAtMs);
  if (expiresAtMs !== NEVER) armWatchdog(name);
  const meta = await readMeta(name);
  if (meta) await writeMeta({ ...meta, ttlMs, expiresAtMs });
  return expiresAtMs;
}

/**
 * Fix a window's size so attaching from another terminal cannot change it.
 *
 * `window-size manual` is set here on an already-created window rather than in the server config,
 * because setting it at server start segfaults tmux 3.6a. The liveness check that follows exists
 * for exactly that reason: if tmux dies here, the caller needs to be told what happened rather than
 * meeting a confusing error on the next command.
 */
async function pinSize(name: string, cols: number, rows: number): Promise<void> {
  const target = `${exactTarget(name)}:`;
  await tmux(["set-option", "-w", "-t", target, "window-size", "manual"]);
  if (!(await hasSession(name))) {
    throw new SessionError(
      `tmux died while pinning the window size for "${name}" — retry without --size`,
    );
  }
  await tmux(["resize-window", "-t", target, "-x", String(cols), "-y", String(rows)]);
}

/** Resize a running session and record the new size in its metadata. */
export async function resizeSession(name: string, cols: number, rows: number): Promise<void> {
  await requireSession(name);
  await pinSize(name, cols, rows);
  const meta = await readMeta(name);
  if (meta) await writeMeta({ ...meta, cols, rows });
}

/**
 * Assert that a session exists, with an error that says which kind of "missing" this is.
 *
 * A reaped session looks exactly like a typo unless the error says otherwise, and the next move is
 * different: start it again with a longer lease, rather than hunting for the right name.
 *
 * @throws {UsageError} If the name is malformed.
 * @throws {SessionError} If the session does not exist, distinguishing expiry from absence.
 */
export async function requireSession(name: string): Promise<void> {
  assertName(name);
  if (await hasSession(name)) return;

  const meta = await readMeta(name);
  const expiresAtMs = meta?.expiresAtMs;
  if (expiresAtMs !== undefined && expiresAtMs !== 0 && Date.now() >= expiresAtMs) {
    throw new SessionError(
      `session "${name}" expired after its ${formatElapsed(meta?.ttlMs ?? 0)} lease and was reaped — ` +
        `start it again (add --ttl 30m for a longer lease, or run: tui keepalive ${name})`,
    );
  }
  throw new SessionError(`no session named "${name}" (list them with: tui ls)`);
}

/**
 * Kill a session. Succeeds quietly if it is already gone.
 *
 * @param options - `purge` also deletes the session's recorded frames and metadata.
 */
export async function stopSession(name: string, options: { purge?: boolean } = {}): Promise<void> {
  assertName(name);
  if (await hasSession(name)) {
    await tmux(["kill-session", "-t", exactTarget(name)]);
  }
  if (options.purge) {
    await rm(sessionDir(name), { recursive: true, force: true });
  }
}

/**
 * Every live session, sorted by name.
 *
 * Panes are listed rather than sessions because the pane carries the interesting fields — the
 * running command, whether it died, its exit status. Each session has exactly one pane here, and
 * the first one seen wins.
 */
export async function listSessions(): Promise<SessionInfo[]> {
  const names = await listSessionNames();
  if (names.length === 0) return [];

  const format = [
    "#{session_name}",
    "#{pane_width}",
    "#{pane_height}",
    "#{pane_current_command}",
    "#{pane_dead}",
    "#{pane_dead_status}",
    "#{pane_pid}",
    "#{session_created}",
    `#{${EXPIRES_OPTION}}`,
  ].join("<|>");

  const result = await tmux(["list-panes", "-a", "-F", format]);
  const infos: SessionInfo[] = [];
  const seen = new Set<string>();

  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split("<|>");
    const name = fields[0] ?? "";
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    const deadStatus = fields[5] ?? "";
    infos.push({
      name,
      cols: Number.parseInt(fields[1] ?? "0", 10) || 0,
      rows: Number.parseInt(fields[2] ?? "0", 10) || 0,
      command: fields[3] ?? "",
      dead: fields[4] === "1",
      exitStatus: deadStatus === "" ? undefined : Number.parseInt(deadStatus, 10),
      panePid: Number.parseInt(fields[6] ?? "0", 10) || 0,
      createdAt: new Date((Number.parseInt(fields[7] ?? "0", 10) || 0) * 1000).toISOString(),
      expiresAtMs: expiresFromSeconds(fields[8]),
      meta: await readMeta(name),
    });
  }

  return infos.sort((a, b) => a.name.localeCompare(b.name));
}

/** Read the stored deadline into milliseconds, treating anything malformed as "no lease". */
function expiresFromSeconds(raw: string | undefined): number | undefined {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "") return undefined;
  const seconds = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}
