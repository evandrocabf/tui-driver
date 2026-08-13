import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import packageJson from "../../package.json" with { type: "json" };
import { main } from "../../src/cli.js";
import {
  captureOutput,
  createState,
  destroyState,
  FIXTURE_COLS,
  FIXTURE_ROWS,
  MENU_FIXTURE,
  restoreHome,
  TOOLS_AVAILABLE,
} from "../helpers/tui.js";

const SESSION = "cli-it";
const previousHome = process.env["TUI_DRIVER_HOME"];
let stateDir = "";

function run(argv: string[]): Promise<{ result: number; stdout: string; stderr: string }> {
  return captureOutput(() => main(argv));
}

describe.skipIf(!TOOLS_AVAILABLE)("cli", () => {
  beforeAll(async () => {
    stateDir = await createState("cli");
  });

  afterAll(async () => {
    await destroyState(stateDir);
    restoreHome(previousHome);
  });

  test("start launches the TUI and prints the screen once it is drawn", async () => {
    const { result, stdout } = await run([
      "start",
      "--name",
      SESSION,
      "--size",
      `${FIXTURE_COLS}x${FIXTURE_ROWS}`,
      "--",
      "python3",
      MENU_FIXTURE,
    ]);
    expect(result).toBe(0);
    expect(stdout).toContain(`session "${SESSION}" started`);
    expect(stdout).toContain("attach with: tmux -S");
    expect(stdout).toContain("TUI DRIVER DEMO");
    expect(stdout).toContain("SELECTED: Dashboard");
  }, 30_000);

  test("start refuses a name that is already taken", async () => {
    const { result, stderr } = await run(["start", "--name", SESSION, "--", "sleep", "5"]);
    expect(result).toBe(2);
    expect(stderr).toContain("already exists");
  }, 30_000);

  test("snap prints a header, and --ruler adds coordinates", async () => {
    const plain = await run(["snap", SESSION]);
    expect(plain.result).toBe(0);
    expect(plain.stdout).toContain(`${SESSION} · ${FIXTURE_COLS}x${FIXTURE_ROWS}`);

    const ruled = await run(["snap", SESSION, "--ruler", "--no-save"]);
    expect(ruled.result).toBe(0);
    expect(ruled.stdout).toContain("0123456789");
  }, 30_000);

  test("snap --json exposes the metadata an agent branches on", async () => {
    const { result, stdout } = await run(["snap", SESSION, "--json", "--no-save"]);
    expect(result).toBe(0);
    const snapshot = JSON.parse(stdout) as Record<string, unknown>;
    expect(snapshot["cols"]).toBe(FIXTURE_COLS);
    expect(snapshot["rows"]).toBe(FIXTURE_ROWS);
    expect(snapshot["dead"]).toBe(false);
    expect(snapshot["session"]).toBe(SESSION);
    expect(String(snapshot["text"])).toContain("SELECTED: Dashboard");
  }, 30_000);

  test("find reports coordinates, and exits 1 when nothing matches", async () => {
    const found = await run(["find", SESSION, "Reports"]);
    expect(found.result).toBe(0);
    expect(found.stdout).toContain("Reports");
    expect(found.stdout).toContain(`tui click ${SESSION}`);

    const missing = await run(["find", SESSION, "Nowhere"]);
    expect(missing.result).toBe(1);
    expect(missing.stdout).toContain("no match");
  }, 30_000);

  test("keys drives the app and --snap shows the result in the same call", async () => {
    const { result, stdout } = await run(["keys", SESSION, "Down", "--snap"]);
    expect(result).toBe(0);
    expect(stdout).toContain("SELECTED: Settings");
    expect(stdout).toContain("sent keys: Down");
  }, 30_000);

  test("keys without a key is a usage error", async () => {
    const { result, stderr } = await run(["keys", SESSION]);
    expect(result).toBe(2);
    expect(stderr).toContain("provide at least one key");
  }, 30_000);

  test("click targets on-screen text", async () => {
    const { result, stdout } = await run(["click", SESSION, "--text", "Reports", "--snap"]);
    expect(result).toBe(0);
    expect(stdout).toContain("ACTIVATED: Reports");
    expect(stdout).toContain("clicked left at");
  }, 30_000);

  test("click reports an unmatched label as a failed condition", async () => {
    const { result, stderr } = await run(["click", SESSION, "--text", "Nowhere"]);
    expect(result).toBe(1);
    expect(stderr).toContain("no match");
  }, 30_000);

  test("wait exits 1 on timeout and says what it was still waiting for", async () => {
    const { result, stdout } = await run([
      "wait",
      SESSION,
      "--text",
      "NEVER",
      "--timeout",
      "300ms",
      "--quiet",
    ]);
    expect(result).toBe(1);
    expect(stdout).toContain("TIMEOUT");
    expect(stdout).toContain("NEVER");
  }, 30_000);

  test("wait --stable succeeds once the screen settles", async () => {
    const { result, stdout } = await run(["wait", SESSION, "--stable", "150ms", "--quiet"]);
    expect(result).toBe(0);
    expect(stdout).toContain("condition met");
  }, 30_000);

  test("frames lists what was recorded", async () => {
    await run(["snap", SESSION, "--label", "one"]);
    await run(["keys", SESSION, "Up"]);
    await run(["snap", SESSION, "--label", "two"]);

    const { result, stdout } = await run(["frames", SESSION]);
    expect(result).toBe(0);
    expect(stdout).toContain("one");
    expect(stdout).toContain("two");
  }, 30_000);

  test("frame, diff and render accept negative references", async () => {
    /* Regression: these are documented in the README and the skill, and used to exit 2 with
       "unknown option -1" because the parser treated -1 as a flag. */
    const frame = await run(["frame", SESSION, "-1"]);
    expect(frame.result).toBe(0);
    expect(frame.stdout).toContain("TUI DRIVER DEMO");

    const diff = await run(["diff", SESSION, "-1", "live"]);
    expect(diff.result).not.toBe(2);
    expect(diff.stderr).not.toContain("unknown option");

    const out = join(stateDir, "negative.svg");
    const render = await run(["render", SESSION, "-1", "--svg", "--out", out]);
    expect(render.result).toBe(0);
    expect(await Bun.file(out).exists()).toBe(true);
  }, 30_000);

  test("render without --out writes into the session store, not the working directory", async () => {
    /* Regression: the default used to be `<session>-<ref>.svg` resolved against cwd, so an agent
       rendering from inside the project it was driving dropped stray images into that repo. */
    const before = new Set(await readdir(process.cwd()));

    const live = await run(["render", SESSION, "--svg"]);
    expect(live.result).toBe(0);
    expect(live.stdout).toContain(join(stateDir, "sessions", SESSION, "frames"));

    const stored = await run(["render", SESSION, "-1", "--svg"]);
    expect(stored.result).toBe(0);
    expect(stored.stdout).toContain(join(stateDir, "sessions", SESSION, "frames"));

    const written = stored.stdout.replace(/^wrote /, "").split(" ")[0]!;
    expect(await Bun.file(written).exists()).toBe(true);

    const after = await readdir(process.cwd());
    expect(after.filter((entry) => !before.has(entry))).toEqual([]);
  }, 30_000);

  test("diff reports 0 when identical and 1 when the screen moved on", async () => {
    await run(["snap", SESSION, "--label", "before"]);
    const identical = await run(["diff", SESSION, "before", "live"]);
    expect(identical.result).toBe(0);
    expect(identical.stdout).toContain("identical");

    await run(["keys", SESSION, "Down"]);
    const changed = await run(["diff", SESSION, "before", "live"]);
    expect(changed.result).toBe(1);
    expect(changed.stdout).toContain("rows differ");
  }, 30_000);

  test("ls shows the running session", async () => {
    const { result, stdout } = await run(["ls"]);
    expect(result).toBe(0);
    expect(stdout).toContain(SESSION);
    expect(stdout).toContain("running");
  }, 30_000);

  test("resize --json reports the new size", async () => {
    const { result, stdout } = await run(["resize", SESSION, "70x16", "--json"]);
    expect(result).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ session: SESSION, cols: 70, rows: 16 });

    const snapshot = await run(["snap", SESSION, "--json", "--no-save"]);
    expect((JSON.parse(snapshot.stdout) as { cols: number }).cols).toBe(70);
  }, 30_000);

  test("an unknown session exits 4", async () => {
    const { result, stderr } = await run(["snap", "no-such-session"]);
    expect(result).toBe(4);
    expect(stderr).toContain("no session named");
  });

  test("an invalid session name is a usage error", async () => {
    const { result, stderr } = await run(["snap", "bad name!"]);
    expect(result).toBe(2);
    expect(stderr).toContain("invalid session name");
  });

  test("an unknown command exits 2 and prints the command list", async () => {
    const { result, stdout, stderr } = await run(["frobnicate"]);
    expect(result).toBe(2);
    expect(stderr).toContain('unknown command "frobnicate"');
    expect(stdout).toContain("commands:");
  });

  test("help lists the public commands and hides the internal ones", async () => {
    const { result, stdout } = await run(["help"]);
    expect(result).toBe(0);
    expect(stdout).toContain("start");
    expect(stdout).toContain("watch");
    expect(stdout).not.toContain("watch-daemon");

    const perCommand = await run(["help", "snap"]);
    expect(perCommand.stdout).toContain("usage: tui snap");
    expect(perCommand.stdout).toContain("--ruler");
  });

  test("--version matches package.json", async () => {
    const { result, stdout } = await run(["--version"]);
    expect(result).toBe(0);
    expect(stdout.trim()).toBe(`tui-driver ${packageJson.version}`);
  });

  test("doctor passes when tmux is present, even without a rasterizer", async () => {
    const { result, stdout } = await run(["doctor", "--json"]);
    const report = JSON.parse(stdout) as {
      ok: boolean;
      checks: { name: string; required: boolean }[];
    };
    expect(result).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.checks.find((check) => check.name === "image rendering")?.required).toBe(false);
    expect(report.checks.find((check) => check.name === "tmux")?.required).toBe(true);
  }, 30_000);

  test("stop --purge kills the session and removes its frames", async () => {
    const stopped = await run(["stop", SESSION, "--purge"]);
    expect(stopped.result).toBe(0);
    expect(stopped.stdout).toContain("removed its frames");

    const gone = await run(["snap", SESSION]);
    expect(gone.result).toBe(4);

    const empty = await run(["ls"]);
    expect(empty.stdout).toContain("no sessions running");
  }, 30_000);
});
