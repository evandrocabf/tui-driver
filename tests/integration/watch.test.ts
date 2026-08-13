import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { listFrames } from "../../src/frames.js";
import { sendKeys } from "../../src/input.js";
import { startSession, stopSession } from "../../src/session.js";
import { isProcessAlive } from "../../src/util.js";
import { readWatcher, runWatchLoop, startWatcher, stopWatcher } from "../../src/watch.js";
import { waitFor } from "../../src/wait.js";
import {
  createState,
  destroyState,
  FIXTURE_COLS,
  FIXTURE_ROWS,
  MENU_FIXTURE,
  restoreHome,
  TOOLS_AVAILABLE,
  until,
} from "../helpers/tui.js";

const previousHome = process.env["TUI_DRIVER_HOME"];
let stateDir = "";

async function startFixture(name: string): Promise<void> {
  await startSession({
    name,
    argv: ["python3", MENU_FIXTURE],
    cols: FIXTURE_COLS,
    rows: FIXTURE_ROWS,
  });
  const ready = await waitFor(name, { text: "TUI DRIVER DEMO", timeoutMs: 15_000, intervalMs: 80 });
  expect(ready.ok).toBe(true);
}

describe.skipIf(!TOOLS_AVAILABLE)("recorder", () => {
  beforeAll(async () => {
    stateDir = await createState("watch");
  });

  afterAll(async () => {
    await destroyState(stateDir);
    restoreHome(previousHome);
  });

  test("records a frame per change in a detached process, and stops on request", async () => {
    await startFixture("watch-bg");
    const state = await startWatcher("watch-bg", { intervalMs: 120, stopOnExit: true });
    expect(state.pid).toBeGreaterThan(0);

    const running = await readWatcher("watch-bg");
    expect(running?.pid).toBe(state.pid);
    expect(isProcessAlive(state.pid, "watch-daemon")).toBe(true);

    expect(await until(async () => (await listFrames("watch-bg")).length >= 1, 8000)).toBe(true);

    await sendKeys("watch-bg", ["Down"]);
    expect(await until(async () => (await listFrames("watch-bg")).length >= 2, 8000)).toBe(true);

    expect(await stopWatcher("watch-bg")).toBe(true);
    expect(await readWatcher("watch-bg")).toBeUndefined();
    expect(await until(() => !isProcessAlive(state.pid, "watch-daemon"), 5000)).toBe(true);

    await stopSession("watch-bg", { purge: true });
  }, 60_000);

  test("refuses a second recorder for the same session", async () => {
    await startFixture("watch-dup");
    await startWatcher("watch-dup", { intervalMs: 200, stopOnExit: true });
    expect(startWatcher("watch-dup", { intervalMs: 200, stopOnExit: true })).rejects.toThrow(
      /already recording/,
    );
    await stopWatcher("watch-dup");
    await stopSession("watch-dup", { purge: true });
  }, 60_000);

  test("stopWatcher reports false when nothing is recording", async () => {
    expect(await stopWatcher("watch-never")).toBe(false);
    expect(await readWatcher("watch-never")).toBeUndefined();
  });

  test("only writes a frame when the screen actually changed", async () => {
    await startFixture("watch-hash");

    /* The screen is static, so a long run still produces exactly one frame. */
    const saved = await runWatchLoop("watch-hash", {
      intervalMs: 50,
      stopOnExit: true,
      durationMs: 400,
    });
    expect(saved).toBe(1);
    expect(await listFrames("watch-hash")).toHaveLength(1);

    await stopSession("watch-hash", { purge: true });
  }, 60_000);

  test("honours maxFrames and prunes to keep", async () => {
    await startFixture("watch-keep");

    await runWatchLoop("watch-keep", { intervalMs: 40, stopOnExit: true, maxFrames: 1 });
    await sendKeys("watch-keep", ["Down"]);
    await runWatchLoop("watch-keep", { intervalMs: 40, stopOnExit: true, maxFrames: 1 });
    expect((await listFrames("watch-keep")).length).toBeGreaterThanOrEqual(2);

    await sendKeys("watch-keep", ["Down"]);
    await runWatchLoop("watch-keep", {
      intervalMs: 40,
      stopOnExit: true,
      maxFrames: 1,
      keep: 1,
    });
    expect(await listFrames("watch-keep")).toHaveLength(1);

    await stopSession("watch-keep", { purge: true });
  }, 60_000);

  test("stops by itself when the process exits", async () => {
    await startFixture("watch-exit");
    await sendKeys("watch-exit", ["q"]);
    const exited = await waitFor("watch-exit", { exit: true, timeoutMs: 8000, intervalMs: 60 });
    expect(exited.ok).toBe(true);

    /* Would run for a minute if stopOnExit were ignored; the pane is dead, so it returns at once. */
    const saved = await runWatchLoop("watch-exit", {
      intervalMs: 50,
      stopOnExit: true,
      durationMs: 60_000,
    });
    expect(saved).toBe(1);

    await stopSession("watch-exit", { purge: true });
  }, 60_000);

  test("returns without recording when the session is already gone", async () => {
    expect(await runWatchLoop("watch-absent", { intervalMs: 50, stopOnExit: true })).toBe(0);
  }, 30_000);
});
