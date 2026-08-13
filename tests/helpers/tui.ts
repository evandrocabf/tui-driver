import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Snapshot } from "../../src/capture.js";

export const MENU_FIXTURE = join(import.meta.dir, "..", "fixtures", "menu.py");
export const MOUSE_FIXTURE = join(import.meta.dir, "..", "fixtures", "mouse-echo.sh");

/**
 * The demo fixture draws about a dozen rows and aborts on a smaller terminal, which kills the pane
 * and makes every downstream assertion look like a tooling bug. Tests must not go below this.
 */
export const FIXTURE_COLS = 64;
export const FIXTURE_ROWS = 14;

export async function hasBinary(binary: string): Promise<boolean> {
  const proc = Bun.spawn(["sh", "-c", `command -v ${binary}`], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  return (await proc.exited) === 0;
}

export const TOOLS_AVAILABLE = (await hasBinary("tmux")) && (await hasBinary("python3"));

/**
 * Point the CLI at a throwaway state directory. Every module reads the location through
 * `rootDir()` at call time, so setting the variable here is enough to isolate a test file.
 */
export async function createState(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `tui-driver-${prefix}-`));
  process.env["TUI_DRIVER_HOME"] = dir;
  return dir;
}

/** Put TUI_DRIVER_HOME back the way it was, so test files cannot leak state into each other. */
export function restoreHome(previous: string | undefined): void {
  if (previous === undefined) delete process.env["TUI_DRIVER_HOME"];
  else process.env["TUI_DRIVER_HOME"] = previous;
}

export async function destroyState(dir: string): Promise<void> {
  const { stopSession } = await import("../../src/session.js");
  const { listSessionNames } = await import("../../src/tmux.js");
  for (const name of await listSessionNames()) {
    await stopSession(name).catch(() => undefined);
  }
  await rm(dir, { recursive: true, force: true });
}

export interface CapturedRun<T> {
  result: T;
  stdout: string;
  stderr: string;
}

/** Run something with stdout/stderr diverted, so CLI output can be asserted on. */
export async function captureOutput<T>(run: () => Promise<T>): Promise<CapturedRun<T>> {
  /* Captured to be assigned straight back in the finally below, never called detached, so the
     `this` binding these rules worry about is never actually lost. */
  /* eslint-disable @typescript-eslint/unbound-method */
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  /* eslint-enable @typescript-eslint/unbound-method */
  let stdout = "";
  let stderr = "";

  process.stdout.write = (chunk: unknown): boolean => {
    stdout += String(chunk);
    return true;
  };
  process.stderr.write = (chunk: unknown): boolean => {
    stderr += String(chunk);
    return true;
  };

  try {
    const result = await run();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

/** A snapshot with plausible defaults, for tests that never touch tmux. */
export function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const text = overrides.text ?? "hello";
  return {
    session: "app",
    capturedAt: "2026-08-10T00:00:00.000Z",
    capturedAtMs: 0,
    elapsedMs: 2200,
    cols: 64,
    rows: 3,
    cursor: { x: 4, y: 1, visible: true },
    dead: false,
    exitStatus: undefined,
    command: "python3",
    panePid: 123,
    alternateScreen: false,
    historySize: 0,
    mouse: { any: true, standard: false, button: true, all: false, sgr: true, utf8: false },
    ansi: text,
    hash: "abc123",
    ...overrides,
    text,
  };
}

/** Poll until `check` is true, or give up. Used instead of fixed sleeps. */
export async function until(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
