import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { sendKeys } from "../../src/input.js";
import { tmuxConfPath } from "../../src/paths.js";
import { startSession, stopSession } from "../../src/session.js";
import { ensureConfig, TMUX_CONF } from "../../src/tmux.js";
import { waitFor } from "../../src/wait.js";
import {
  createState,
  destroyState,
  FIXTURE_COLS,
  FIXTURE_ROWS,
  MENU_FIXTURE,
  restoreHome,
  TOOLS_AVAILABLE,
} from "../helpers/tui.js";

const previousHome = process.env["TUI_DRIVER_HOME"];
const stateDirs: string[] = [];

describe.skipIf(!TOOLS_AVAILABLE)("private tmux config", () => {
  beforeAll(async () => {
    stateDirs.push(await createState("conf-a"));
  });

  afterAll(async () => {
    for (const dir of stateDirs) {
      process.env["TUI_DRIVER_HOME"] = dir;
      await destroyState(dir);
    }
    restoreHome(previousHome);
  });

  test("writes the config into whichever state directory is current", async () => {
    /* Regression: the writer used to latch on a boolean, so a second state directory in the same
       process silently ran on tmux's own defaults — tmux accepts a missing -f file without error. */
    await ensureConfig();
    expect(await Bun.file(tmuxConfPath()).text()).toBe(TMUX_CONF);

    const second = await createState("conf-b");
    stateDirs.push(second);
    expect(await Bun.file(tmuxConfPath()).exists()).toBe(false);

    await ensureConfig();
    expect(await Bun.file(tmuxConfPath()).text()).toBe(TMUX_CONF);
  });

  test("keeps a dead pane around so the exit can still be observed", async () => {
    /* remain-on-exit comes from that config, and is what `wait --exit` depends on. */
    await startSession({
      name: "conf-exit",
      argv: ["python3", MENU_FIXTURE],
      cols: FIXTURE_COLS,
      rows: FIXTURE_ROWS,
    });
    const ready = await waitFor("conf-exit", {
      text: "TUI DRIVER DEMO",
      timeoutMs: 15_000,
      intervalMs: 80,
    });
    expect(ready.ok).toBe(true);

    await sendKeys("conf-exit", ["q"]);

    const exited = await waitFor("conf-exit", { exit: true, timeoutMs: 8000, intervalMs: 60 });
    expect(exited.ok).toBe(true);
    expect(exited.snapshot.dead).toBe(true);

    await stopSession("conf-exit", { purge: true });
  }, 60_000);
});
