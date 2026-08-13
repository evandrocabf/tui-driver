/**
 * Session leases: why a forgotten `tui start` does not leave a process tree running for hours.
 *
 * Two independent mechanisms, deliberately. A detached `sh` watchdog kills each session when its
 * lease runs out with no CLI call needed, and every command sweeps first — so a session whose
 * watchdog was killed still dies at the next command at the latest.
 */

import { spawn } from "node:child_process";

import { UsageError } from "./errors.js";
import { socketPath } from "./paths.js";
import { exactTarget, serverRunning, tmux } from "./tmux.js";
import { parseDuration } from "./util.js";

/**
 * Every session carries a lease and dies on its own when it runs out. Nothing here relies on the
 * caller remembering to `tui stop`: an abandoned session is the normal failure mode, not the
 * exception, and a forgotten TUI keeps a whole process tree (bun, node, python…) alive forever.
 */
export const DEFAULT_TTL_MS = 10 * 60_000;

/** The longest lease `--ttl` may ask for. Longer leases are a human decision, via TUI_DRIVER_TTL. */
export const MAX_TTL_MS = 60 * 60_000;

/** Stored on the tmux session as epoch seconds, so the shell watchdog can compare it with `date`. */
export const EXPIRES_OPTION = "@tui-expires";

/** A lease of 0 means "never expires" — only reachable through the environment variable. */
export const NEVER = 0;

const WATCHDOG_INTERVAL_MS = 5000;

/** The tmux target for reading and writing a session's options. */
function optionTarget(name: string): string {
  return `${exactTarget(name)}:`;
}

/** The default lease, overridable per machine with TUI_DRIVER_TTL (accepts `never` / `off` / `0`). */
export function defaultTtlMs(): number {
  const raw = process.env["TUI_DRIVER_TTL"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_TTL_MS;
  if (/^(never|off|none|0)$/i.test(raw)) return NEVER;
  const parsed = parseDuration(raw, DEFAULT_TTL_MS);
  return parsed > 0 ? parsed : NEVER;
}

/**
 * A lease asked for on the command line. It cannot be disabled and cannot exceed MAX_TTL_MS —
 * an agent driving this CLI should never be able to create a session that outlives the work.
 */
export function resolveTtlMs(flag: string | undefined): number {
  if (flag === undefined || flag === "") return defaultTtlMs();
  if (/^(never|off|none)$/i.test(flag.trim())) {
    throw new UsageError(
      "--ttl cannot disable the lease — set TUI_DRIVER_TTL=never in your environment if you really want immortal sessions",
    );
  }
  const ms = parseDuration(flag, DEFAULT_TTL_MS);
  if (ms <= 0) {
    throw new UsageError("--ttl must be positive, e.g. --ttl 20m");
  }
  if (ms > MAX_TTL_MS) {
    throw new UsageError(
      `--ttl cannot exceed ${MAX_TTL_MS / 60_000}m — set TUI_DRIVER_TTL in your environment for a longer default`,
    );
  }
  return ms;
}

/** Phrase a lease for the line `tui start` prints. */
export function describeTtl(ttlMs: number): string {
  return ttlMs === NEVER ? "no expiry" : `expires in ${Math.round(ttlMs / 60_000)}m`;
}

/** Write the deadline where both the watchdog and every later CLI run can find it. */
export async function setDeadline(name: string, expiresAtMs: number): Promise<void> {
  const seconds = expiresAtMs === NEVER ? 0 : Math.ceil(expiresAtMs / 1000);
  await tmux(["set-option", "-t", optionTarget(name), EXPIRES_OPTION, String(seconds)]);
}

/**
 * Read a session's deadline in epoch milliseconds.
 *
 * `undefined` means no lease was ever set — a session from an older version, or one made by hand.
 * Callers fall back to the default lease measured from tmux's own creation time.
 */
export async function readDeadline(name: string): Promise<number | undefined> {
  const result = await tmux(["show-options", "-v", "-t", optionTarget(name), EXPIRES_OPTION]);
  if (result.code !== 0) return undefined;
  return parseDeadline(result.stdout.trim());
}

/** Parse the stored deadline, treating anything malformed as "no lease". */
function parseDeadline(raw: string): number | undefined {
  if (raw === "") return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

/**
 * How often the watchdog re-checks the deadline, as a value for `sleep`.
 *
 * Overridable through `TUI_DRIVER_WATCHDOG_INTERVAL`, which is what the lifetime tests use so they
 * do not have to wait five seconds for every assertion. Floored so a bad value cannot spin.
 */
function watchdogIntervalSeconds(): string {
  const raw = process.env["TUI_DRIVER_WATCHDOG_INTERVAL"];
  const ms = raw === undefined || raw === "" ? WATCHDOG_INTERVAL_MS : parseDuration(raw, 5000);
  return (Math.max(200, ms) / 1000).toFixed(1);
}

/**
 * Polls the deadline rather than sleeping until it, so `tui keepalive` can push it back, and so a
 * session killed by hand takes its watchdog down with it. Written in `sh` on purpose: a runtime
 * watchdog would be one more process to leak.
 */
const WATCHDOG_SCRIPT = `
sock=$1
name=$2
interval=$3
while :; do
  expires=$(tmux -S "$sock" show-options -v -t "=$name:" @tui-expires 2>/dev/null) || exit 0
  case "$expires" in
    ""|0|*[!0-9]*) exit 0 ;;
  esac
  if [ "$(date +%s)" -ge "$expires" ]; then
    tmux -S "$sock" kill-session -t "=$name" >/dev/null 2>&1
    exit 0
  fi
  sleep "$interval"
done
`;

/** Arms a detached watchdog for a session. Safe to call twice: extra watchdogs are idempotent. */
export function armWatchdog(name: string): void {
  const child = spawn(
    "sh",
    ["-c", WATCHDOG_SCRIPT, "tui-driver-watchdog", socketPath(), name, watchdogIntervalSeconds()],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

/** How aggressive a sweep to run. */
export interface ReapOptions {
  /** Also kill sessions older than this, whatever their lease says. */
  maxAgeMs?: number;
  /** The current time, injectable so tests need not wait for a real lease to run out. */
  now?: number;
}

/** A session that was killed by a sweep, and why. */
export interface ReapedSession {
  /** The session that was killed. */
  name: string;
  /** `expired` when its lease ran out, `too-old` when `--max-age` overrode the lease. */
  reason: "expired" | "too-old";
  /** How long it had been alive. */
  ageMs: number;
}

/**
 * Kills every session whose lease ran out. This is the belt to the watchdog's braces: it also
 * catches sessions whose watchdog was killed, and sessions created before leases existed at all
 * (no option set — those fall back to the default lease measured from tmux's own creation time).
 */
export async function reap(options: ReapOptions = {}): Promise<ReapedSession[]> {
  const now = options.now ?? Date.now();
  if (!(await serverRunning())) return [];

  const format = ["#{session_name}", `#{${EXPIRES_OPTION}}`, "#{session_created}"].join("<|>");
  const result = await tmux(["list-sessions", "-F", format]);
  if (result.code !== 0) return [];

  const reaped: ReapedSession[] = [];
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [name = "", rawExpires = "", rawCreated = ""] = line.split("<|>");
    if (name === "") continue;

    const createdMs = (Number.parseInt(rawCreated, 10) || 0) * 1000;
    const ageMs = createdMs === 0 ? 0 : now - createdMs;
    const deadline = parseDeadline(rawExpires.trim());
    const fallback = createdMs === 0 ? undefined : createdMs + DEFAULT_TTL_MS;
    const effective = rawExpires.trim() === "" ? fallback : deadline;

    const tooOld = options.maxAgeMs !== undefined && ageMs >= options.maxAgeMs;
    const expired = effective !== undefined && effective !== NEVER && now >= effective;
    if (!tooOld && !expired) continue;

    await kill(name);
    reaped.push({ name, reason: tooOld ? "too-old" : "expired", ageMs });
  }
  return reaped;
}

/**
 * Kill a session and everything of ours attached to it.
 *
 * The recorder goes first: it is a process of ours rather than the application's, so killing the
 * session alone would leave it sitting in its poll loop for one more interval — and a long
 * `--interval` keeps it around long after the TUI is gone.
 *
 * Imported lazily to break the cycle between this module and the recorder.
 */
async function kill(name: string): Promise<void> {
  const { stopWatcher } = await import("./watch.js");
  await stopWatcher(name).catch(() => false);
  await tmux(["kill-session", "-t", exactTarget(name)]);
}

/** Best-effort sweep run before every command, so a leak never survives the next CLI call. */
export async function sweep(): Promise<ReapedSession[]> {
  try {
    return await reap();
  } catch {
    return [];
  }
}
