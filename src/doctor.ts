/** End-to-end environment checks used by `tui doctor`. */

import { capture } from "./capture.js";
import { DependencyError } from "./errors.js";
import { sendText } from "./input.js";
import { resizeSession, startSession, stopSession } from "./session.js";
import { tmuxVersion } from "./tmux.js";
import { waitFor } from "./wait.js";

/** Parse and enforce the documented tmux >= 3.2 contract. */
export function assertSupportedTmuxVersion(version: string): string {
  const match = /tmux\s+(\d+)\.(\d+)/i.exec(version);
  if (!match) throw new DependencyError(`cannot parse tmux version: ${version}`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < 3 || (major === 3 && minor < 2)) {
    throw new DependencyError(`tmux 3.2 or newer is required (found ${version})`);
  }
  return version;
}

/** Read tmux's version and enforce the supported range. */
export async function requireSupportedTmux(): Promise<string> {
  return assertSupportedTmuxVersion(await tmuxVersion());
}

/**
 * Prove that the private server can create, capture, drive, resize and remove a real PTY.
 * A version check alone cannot detect socket permissions or an unusable state directory.
 */
export async function runTmuxCanary(): Promise<string> {
  const name = `doctor-${process.pid}-${Date.now()}`;
  try {
    await startSession({
      name,
      argv: ["sh", "-c", "printf TUI_DRIVER_DOCTOR_READY; cat"],
      cols: 40,
      rows: 10,
      ttlMs: 30_000,
    });
    const ready = await waitFor(name, {
      text: "TUI_DRIVER_DOCTOR_READY",
      timeoutMs: 3000,
      intervalMs: 40,
    });
    if (!ready.ok) throw new DependencyError("tmux canary did not produce a capturable screen");
    await sendText(name, "x");
    await resizeSession(name, 42, 11);
    const snapshot = await capture(name);
    if (snapshot.cols !== 42 || snapshot.rows !== 11) {
      throw new DependencyError(
        `tmux canary resize failed (expected 42x11, got ${snapshot.cols}x${snapshot.rows})`,
      );
    }
    return "create, capture, input, resize and cleanup succeeded";
  } finally {
    await stopSession(name, { purge: true }).catch(() => undefined);
  }
}
