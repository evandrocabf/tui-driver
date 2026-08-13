import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  createState,
  destroyState,
  FIXTURE_COLS,
  FIXTURE_ROWS,
  MENU_FIXTURE,
  MOUSE_FIXTURE,
  restoreHome,
  TOOLS_AVAILABLE,
} from "../helpers/tui.js";

const previousHome = process.env["TUI_DRIVER_HOME"];
let stateDir = "";

describe.skipIf(!TOOLS_AVAILABLE)("tmux harness", () => {
  beforeAll(async () => {
    stateDir = await createState("harness");
  });

  afterAll(async () => {
    await destroyState(stateDir);
    restoreHome(previousHome);
  });

  test("drives a curses TUI with keys, mouse and captures", async () => {
    const { capture } = await import("../../src/capture.js");
    const { mouseClick } = await import("../../src/input.js");
    const { sendKeys } = await import("../../src/input.js");
    const { locate } = await import("../../src/locate.js");
    const { NO_MODIFIERS } = await import("../../src/mouse.js");
    const { saveFrame, listFrames } = await import("../../src/frames.js");
    const { renderAnsiToFile } = await import("../../src/render.js");
    const { startSession, stopSession } = await import("../../src/session.js");
    const { waitFor } = await import("../../src/wait.js");

    const meta = await startSession({
      name: "it-menu",
      argv: ["python3", MENU_FIXTURE],
      cols: FIXTURE_COLS,
      rows: FIXTURE_ROWS,
    });
    expect(meta.name).toBe("it-menu");

    const ready = await waitFor("it-menu", {
      text: "TUI DRIVER DEMO",
      timeoutMs: 15_000,
      intervalMs: 80,
    });
    expect(ready.ok).toBe(true);

    const boot = await capture("it-menu");
    expect(boot.cols).toBe(FIXTURE_COLS);
    expect(boot.rows).toBe(FIXTURE_ROWS);
    expect(boot.dead).toBe(false);
    expect(boot.text).toContain("SELECTED: Dashboard");
    expect(boot.mouse.any).toBe(true);

    await sendKeys("it-menu", ["Down"]);
    const afterKey = await waitFor("it-menu", {
      text: "SELECTED: Settings",
      timeoutMs: 5000,
      intervalMs: 60,
    });
    expect(afterKey.ok).toBe(true);

    const target = locate(afterKey.snapshot.text, "Reports")[0];
    expect(target).toBeDefined();
    await mouseClick("it-menu", target?.centerCol ?? 0, target?.row ?? 0, "left", NO_MODIFIERS);

    const afterClick = await waitFor("it-menu", {
      text: "ACTIVATED: Reports",
      timeoutMs: 5000,
      intervalMs: 60,
    });
    expect(afterClick.ok).toBe(true);

    const frame = await saveFrame("it-menu", afterClick.snapshot, {
      kind: "snap",
      label: "clicked",
    });
    expect(frame.label).toBe("clicked");
    expect(await Bun.file(frame.files.text).text()).toContain("ACTIVATED: Reports");
    expect(await listFrames("it-menu")).toHaveLength(1);

    const svgPath = join(stateDir, "shot.svg");
    const rendered = await renderAnsiToFile(afterClick.snapshot.ansi, svgPath, {
      cols: afterClick.snapshot.cols,
      rows: afterClick.snapshot.rows,
      format: "svg",
    });
    expect(rendered.format).toBe("svg");
    expect((await Bun.file(svgPath).text()).length).toBeGreaterThan(500);

    await sendKeys("it-menu", ["q"]);
    const exited = await waitFor("it-menu", { exit: true, timeoutMs: 5000, intervalMs: 60 });
    expect(exited.ok).toBe(true);
    expect(exited.snapshot.dead).toBe(true);

    await stopSession("it-menu", { purge: true });
  }, 60_000);

  test("delivers the exact mouse bytes a TUI expects", async () => {
    const { capture } = await import("../../src/capture.js");
    const { mouseClick, mouseScroll } = await import("../../src/input.js");
    const { NO_MODIFIERS } = await import("../../src/mouse.js");
    const { startSession, stopSession } = await import("../../src/session.js");
    const { waitFor } = await import("../../src/wait.js");

    await startSession({ name: "it-echo", argv: [MOUSE_FIXTURE], cols: 70, rows: 10 });
    const ready = await waitFor("it-echo", {
      text: "MOUSE ECHO READY",
      timeoutMs: 15_000,
      intervalMs: 80,
    });
    expect(ready.ok).toBe(true);

    const modes = await capture("it-echo");
    expect(modes.mouse.sgr).toBe(true);

    await mouseClick("it-echo", 10, 5, "left", NO_MODIFIERS);
    await mouseScroll("it-echo", 5, 5, "down", 1, NO_MODIFIERS);

    const seen = await waitFor("it-echo", {
      text: "[<65;6;6M",
      timeoutMs: 5000,
      intervalMs: 60,
    });
    expect(seen.ok).toBe(true);
    expect(seen.snapshot.text).toContain("[<0;11;6M");
    expect(seen.snapshot.text).toContain("[<0;11;6m");

    await stopSession("it-echo", { purge: true });
  }, 60_000);

  test("rejects duplicate session names and unknown sessions", async () => {
    const { startSession, stopSession, requireSession } = await import("../../src/session.js");
    await startSession({ name: "it-dup", argv: ["sleep", "30"], cols: 40, rows: 8 });
    expect(
      startSession({ name: "it-dup", argv: ["sleep", "30"], cols: 40, rows: 8 }),
    ).rejects.toThrow(/already exists/);
    expect(requireSession("it-missing")).rejects.toThrow(/no session named/);
    await stopSession("it-dup", { purge: true });
  }, 30_000);

  test("survives a state directory whose path contains a space", async () => {
    /* The raw-output pipe is a shell command built by tmux, so the path has to be quoted. */
    const { capture } = await import("../../src/capture.js");
    const { startSession, stopSession } = await import("../../src/session.js");
    const { waitFor } = await import("../../src/wait.js");
    const { pipeLogPath } = await import("../../src/paths.js");

    const spaced = join(stateDir, "with space");
    const restore = process.env["TUI_DRIVER_HOME"];
    process.env["TUI_DRIVER_HOME"] = spaced;
    try {
      await startSession({
        name: "it-space",
        argv: ["python3", MENU_FIXTURE],
        cols: FIXTURE_COLS,
        rows: FIXTURE_ROWS,
        rawLog: true,
      });
      const ready = await waitFor("it-space", {
        text: "TUI DRIVER DEMO",
        timeoutMs: 15_000,
        intervalMs: 80,
      });
      expect(ready.ok).toBe(true);
      expect((await capture("it-space")).text).toContain("SELECTED: Dashboard");
      expect(await Bun.file(pipeLogPath("it-space")).exists()).toBe(true);
      await stopSession("it-space", { purge: true });
    } finally {
      restoreHome(restore);
    }
  }, 60_000);
});
