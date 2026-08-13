/**
 * The private tmux server every session runs on.
 *
 * Its own socket, its own config, no key bindings and no status bar — so it cannot collide with
 * whatever tmux the user is already running, and a stray keystroke cannot reach our panes.
 */

import { existsSync } from "node:fs";

import { DependencyError } from "./errors.js";
import { ensureDir } from "./util.js";
import { rootDir, socketPath, tmuxConfPath } from "./paths.js";

/**
 * The server config.
 *
 * Several of these settings are load-bearing rather than cosmetic:
 * `remain-on-exit` keeps the pane after the process dies, which is the only way `wait --exit` can
 * observe an exit status; `status off` keeps the status bar out of captured screens; `mouse off`
 * stops tmux from intercepting the mouse events we inject for the application; and the `RGB` /
 * `Tc` terminal features are what let truecolor survive into a capture.
 *
 * Notably absent: `window-size manual`, which segfaults tmux 3.6a when set at server start. The
 * size is pinned on the window right after `new-session` instead.
 */
export const TMUX_CONF = `set -s escape-time 0
set -g default-terminal "tmux-256color"
set -as terminal-features ",*:RGB"
set -ga terminal-overrides ",*:Tc"
set -g history-limit 50000
set -g status off
set -g mouse off
set -g set-titles off
set -g visual-bell off
set -g visual-activity off
set -g bell-action none
set -g focus-events off
set -g base-index 0
set -g repeat-time 0
set -g assume-paste-time 0
set -g detach-on-destroy off
set -g destroy-unattached off
setw -g pane-base-index 0
setw -g aggressive-resize off
setw -g automatic-rename off
setw -g allow-rename off
setw -g remain-on-exit on
setw -g monitor-activity off
setw -g monitor-bell off
`;

/** The result of one tmux invocation. */
export interface TmuxResult {
  /** Process exit status. */
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Which config path has been written this process, not merely "have we written one". The state
 * directory can change under us (TUI_DRIVER_HOME, tests), and tmux accepts a missing `-f` file
 * without complaining — so a stale flag silently yields a server running on tmux's own defaults,
 * with no `remain-on-exit` and a status bar.
 */
let configuredPath: string | undefined;

/**
 * The environment to run tmux in.
 *
 * `TMUX` and `TMUX_PANE` are stripped: if the caller is themselves inside tmux, leaving them set
 * makes tmux refuse to nest, and every command fails with "sessions should be nested with care".
 */
function tmuxEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "TMUX" || key === "TMUX_PANE") continue;
    env[key] = value;
  }
  return env;
}

/**
 * Write the config file if it is missing or out of date, and reload it into a running server.
 *
 * Called before every tmux invocation, and cheap after the first: the work is skipped once
 * {@link configuredPath} matches.
 */
export async function ensureConfig(): Promise<void> {
  const path = tmuxConfPath();
  if (configuredPath === path) return;
  await ensureDir(rootDir());
  const file = Bun.file(path);
  const current = (await file.exists()) ? await file.text() : "";
  if (current !== TMUX_CONF) {
    await Bun.write(path, TMUX_CONF);
    if (await serverRunning()) {
      await rawTmux(["source-file", path]);
    }
  }
  configuredPath = path;
}

/** Invoke tmux against our socket and config, without ensuring the config exists first. */
async function rawTmux(args: string[]): Promise<TmuxResult> {
  const proc = Bun.spawn(["tmux", "-S", socketPath(), "-f", tmuxConfPath(), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: tmuxEnv(),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Invoke tmux against our private server, writing the config first if needed. */
export async function tmux(args: string[]): Promise<TmuxResult> {
  await ensureConfig();
  return rawTmux(args);
}

/**
 * Invoke tmux and return its stdout, failing loudly on a non-zero exit.
 *
 * @throws {DependencyError} With whatever tmux said, which is usually the most useful diagnostic.
 */
export async function tmuxOrThrow(args: string[]): Promise<string> {
  const result = await tmux(args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new DependencyError(`tmux ${args[0] ?? ""} failed: ${detail}`);
  }
  return result.stdout;
}

/**
 * Whether our tmux server is up.
 *
 * The socket file is checked with `existsSync` rather than `Bun.file().exists()`, which reports
 * false for unix sockets. Its presence is not proof of life — a stale socket outlives a crashed
 * server — so `list-sessions` is what actually decides.
 */
export async function serverRunning(): Promise<boolean> {
  if (!existsSync(socketPath())) return false;
  const proc = Bun.spawn(["tmux", "-S", socketPath(), "list-sessions"], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: tmuxEnv(),
  });
  const code = await proc.exited;
  return code === 0;
}

/**
 * The installed tmux version string, e.g. `tmux 3.5a`.
 *
 * @throws {DependencyError} If tmux is not on PATH.
 */
export async function tmuxVersion(): Promise<string> {
  const proc = Bun.spawn(["tmux", "-V"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new DependencyError("tmux is not available on PATH");
  return stdout.trim();
}

/** Whether a session by this exact name exists. */
export async function hasSession(name: string): Promise<boolean> {
  const result = await tmux(["has-session", "-t", exactTarget(name)]);
  return result.code === 0;
}

/** Every live session name; empty when the server is not running. */
export async function listSessionNames(): Promise<string[]> {
  if (!(await serverRunning())) return [];
  const result = await tmux(["list-sessions", "-F", "#{session_name}"]);
  if (result.code !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * A tmux target that matches this name and nothing else.
 *
 * Without the `=` prefix tmux treats a target as a prefix pattern, so a session called `app` would
 * also match `app2` — and commands would land on the wrong session.
 */
export function exactTarget(name: string): string {
  return `=${name}`;
}
