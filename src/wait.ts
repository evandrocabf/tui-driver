/**
 * Synchronising on what the screen actually says, rather than sleeping and hoping.
 *
 * This is the single most important thing the tool provides for driving a TUI reliably: a fixed
 * sleep is either too short (flaky) or too long (slow), and both get worse on a loaded machine.
 */

import { capture, type Snapshot } from "./capture.js";
import { locate, type LocateOptions, type ScreenMatch } from "./locate.js";
import { sleep } from "./util.js";

/**
 * What to wait for.
 *
 * Conditions combine: every one that is set must hold at the same time before the wait succeeds.
 */
export interface WaitOptions {
  /** Wait until this appears on screen. */
  text?: string;
  /** Wait until this is no longer on screen. */
  gone?: string;
  /** Wait until the pane's process exits. */
  exit?: boolean;
  /** Wait until the screen has not changed for this many milliseconds. */
  stableMs?: number;
  /** Treat {@link WaitOptions.text} and {@link WaitOptions.gone} as regular expressions. */
  regex?: boolean;
  /** Match case-insensitively. */
  ignoreCase?: boolean;
  /** Give up after this long. */
  timeoutMs: number;
  /** How long to pause between captures. */
  intervalMs: number;
}

/** The outcome of a wait, including the screen it ended on. */
export interface WaitResult {
  /** True when every condition held. False means the timeout ran out. */
  ok: boolean;
  /** How long the wait took. */
  waitedMs: number;
  /**
   * The last screen captured. On failure this is the screen the wait gave up on, which is printed
   * for the caller — it is almost always enough to see why the condition never held.
   */
  snapshot: Snapshot;
  /** Where {@link WaitOptions.text} was found, when it was. */
  match: ScreenMatch | undefined;
  /** The conditions still unmet, phrased for display. Empty when `ok` is true. */
  pending: string[];
}

/**
 * Block until the pane has drawn something.
 *
 * `start` uses this before returning, because `--settle` alone is a race: a slow TUI has simply not
 * painted yet, and returning an empty screen looks identical to a broken program. A process that
 * exits immediately also counts as drawn — there is nothing more to wait for, and the caller needs
 * to see the exit status rather than sit here until the timeout.
 *
 * @returns True once the screen is non-empty or the process has exited; false on timeout.
 */
export async function waitUntilDrawn(
  name: string,
  timeoutMs: number,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await capture(name);
    if (snapshot.text.trim() !== "" || snapshot.dead) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

/**
 * Poll a session until every requested condition holds, or the timeout runs out.
 *
 * Stability is tracked across the whole wait rather than measured at the end: each capture is
 * content-hashed, and the clock restarts only when the hash changes. That way `--stable 300ms`
 * means "300ms since the last actual repaint", not "300ms since we started looking".
 *
 * Never throws on a condition that fails to hold — the caller turns {@link WaitResult.ok} into the
 * exit code, so a timeout is an answer rather than an error.
 */
export async function waitFor(name: string, options: WaitOptions): Promise<WaitResult> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const locateOptions: LocateOptions = {
    ...(options.regex ? { regex: true } : {}),
    ...(options.ignoreCase ? { ignoreCase: true } : {}),
  };

  let lastHash: string | undefined;
  let lastChangeAt = startedAt;
  let snapshot = await capture(name);
  let match: ScreenMatch | undefined;

  for (;;) {
    const now = Date.now();
    if (snapshot.hash !== lastHash) {
      lastHash = snapshot.hash;
      lastChangeAt = now;
    }

    const pending: string[] = [];
    match = undefined;

    if (options.text !== undefined) {
      const found = locate(snapshot.text, options.text, locateOptions);
      if (found.length === 0) pending.push(`text ${JSON.stringify(options.text)} not on screen`);
      else match = found[0];
    }

    if (options.gone !== undefined) {
      const found = locate(snapshot.text, options.gone, locateOptions);
      if (found.length > 0) pending.push(`text ${JSON.stringify(options.gone)} still on screen`);
    }

    if (options.exit && !snapshot.dead) pending.push("process still running");

    if (options.stableMs !== undefined && now - lastChangeAt < options.stableMs) {
      pending.push(`screen changed ${now - lastChangeAt}ms ago`);
    }

    if (pending.length === 0) {
      return { ok: true, waitedMs: now - startedAt, snapshot, match, pending };
    }

    if (now >= deadline) {
      return { ok: false, waitedMs: now - startedAt, snapshot, match, pending };
    }

    await sleep(Math.min(options.intervalMs, Math.max(1, deadline - Date.now())));
    snapshot = await capture(name);
  }
}
