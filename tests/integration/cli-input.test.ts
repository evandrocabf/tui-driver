import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { main } from "../../src/cli.js";
import { sessionDir } from "../../src/paths.js";
import {
  captureOutput,
  createState,
  destroyState,
  FIXTURE_COLS,
  FIXTURE_ROWS,
  MENU_FIXTURE,
  MOUSE_FIXTURE,
  restoreHome,
  TOOLS_AVAILABLE,
} from "../helpers/tui.js";

const SESSION = "cli-input";
const previousHome = process.env["TUI_DRIVER_HOME"];
let stateDir = "";

function run(argv: string[]): Promise<{ result: number; stdout: string; stderr: string }> {
  return captureOutput(() => main(argv));
}

describe.skipIf(!TOOLS_AVAILABLE)("cli input and lifecycle", () => {
  beforeAll(async () => {
    stateDir = await createState("cli-input");
    const started = await run([
      "start",
      "--name",
      SESSION,
      "--size",
      `${FIXTURE_COLS}x${FIXTURE_ROWS}`,
      "--record",
      "150ms",
      "--",
      "python3",
      MENU_FIXTURE,
    ]);
    expect(started.result).toBe(0);
  }, 30_000);

  afterAll(async () => {
    await destroyState(stateDir);
    restoreHome(previousHome);
  });

  test("--record starts a recorder alongside the session", async () => {
    const status = await run(["watch", SESSION, "--status"]);
    expect(status.result).toBe(0);
    expect(status.stdout).toContain(`recording "${SESSION}"`);

    const json = await run(["watch", SESSION, "--status", "--json"]);
    expect((JSON.parse(json.stdout) as { intervalMs: number }).intervalMs).toBe(150);
  }, 30_000);

  test("watch refuses to start a second recorder, then stops the first", async () => {
    const second = await run(["watch", SESSION, "--interval", "200ms"]);
    expect(second.result).toBe(2);
    expect(second.stderr).toContain("already recording");

    const stopped = await run(["watch", SESSION, "--stop"]);
    expect(stopped.result).toBe(0);
    expect(stopped.stdout).toContain("stopped");

    const after = await run(["watch", SESSION, "--status"]);
    expect(after.stdout).toContain("no recorder running");
  }, 30_000);

  test("type sends literal text and reaches the app", async () => {
    /* The demo reports the last key it saw, so typing a plain character is observable. */
    const { result, stdout } = await run(["type", SESSION, "z", "--snap"]);
    expect(result).toBe(0);
    expect(stdout).toContain('typed "z"');
    expect(stdout).toContain("EVENT: key");
  }, 30_000);

  test("type without text is a usage error", async () => {
    const { result, stderr } = await run(["type", SESSION]);
    expect(result).toBe(2);
    expect(stderr).toContain("provide the text to type");
  });

  test("injects every exact-input source and validates protocol options", async () => {
    const name = "protocol-input";
    const payload = join(stateDir, "raw-byte.bin");
    await Bun.write(payload, new Uint8Array([0x43]));
    expect(
      (
        await run([
          "start",
          "--name",
          name,
          "--wait-text",
          "MOUSE ECHO READY",
          "--",
          "bash",
          MOUSE_FIXTURE,
        ])
      ).result,
    ).toBe(0);

    expect((await run(["bytes", name, "--hex", "0x41"])).result).toBe(0);
    expect((await run(["bytes", name, "--base64", "Qg=="])).result).toBe(0);
    expect((await run(["bytes", name, "--file", payload])).result).toBe(0);
    expect((await run(["focus", name, "--in"])).result).toBe(0);
    expect((await run(["focus", name, "--out"])).result).toBe(0);
    expect(
      (await run(["key-event", name, "A", "--event", "repeat", "--modifiers", "ctrl"])).result,
    ).toBe(0);
    expect((await run(["key-event", name, "U+0042", "--event", "release"])).result).toBe(0);
    expect((await run(["key-event", name, "67"])).result).toBe(0);

    const screen = await run(["snap", name, "--raw", "--no-save"]);
    expect(screen.stdout).toContain("ABC");
    expect(screen.stdout).toContain("^[[I");
    expect(screen.stdout).toContain("^[[O");
    expect(screen.stdout).toContain("^[[65;5:2u");
    expect(screen.stdout).toContain("^[[66;1:3u");
    expect(screen.stdout).toContain("^[[67;1:1u");

    for (const [argv, message] of [
      [["bytes", name], "choose exactly one"],
      [["bytes", name, "--hex", "abc"], "complete byte pairs"],
      [["bytes", name, "--base64", "%%%="], "not valid base64"],
      [["bytes", name, "--hex", "41", "--base64", "QQ=="], "choose exactly one"],
      [["focus", name], "choose exactly one"],
      [["focus", name, "--in", "--out"], "choose exactly one"],
      [["key-event", name, "two"], "expects one character"],
      [["key-event", name, "A", "--event", "hold"], "unknown key event"],
    ] as const) {
      const invalid = await run([...argv]);
      expect(invalid.result).toBe(2);
      expect(invalid.stderr).toContain(message);
    }

    await run(["stop", name, "--purge"]);
  }, 30_000);

  test("reports capabilities and versioned cell state", async () => {
    const capabilities = await run(["capabilities", SESSION, "--json"]);
    expect(capabilities.result).toBe(0);
    const report = JSON.parse(capabilities.stdout) as {
      schemaVersion: number;
      scope: string;
      input: { rawBytes: boolean };
    };
    expect(report).toMatchObject({
      schemaVersion: 1,
      scope: "single-pane-cell-grid",
      input: { rawBytes: true },
    });

    const human = await run(["capabilities", SESSION]);
    expect(human.result).toBe(0);
    expect(human.stdout).toContain("extended keys");
    expect(human.stdout).toContain("terminal graphics");

    const snap = await run(["snap", SESSION, "--json", "--no-save"]);
    const snapshot = JSON.parse(snap.stdout) as {
      schemaVersion: number;
      stateHash: string;
      grid: { lines: unknown[] };
    };
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.stateHash).toHaveLength(12);
    expect(snapshot.grid.lines.length).toBeGreaterThan(0);
  }, 30_000);

  test("wait can synchronize on complete state, cursor and terminal modes", async () => {
    const before = JSON.parse((await run(["snap", SESSION, "--json", "--no-save"])).stdout) as {
      stateHash: string;
      cursor: { x: number; y: number; visible: boolean };
      alternateScreen: boolean;
    };

    const pending = await run([
      "wait",
      SESSION,
      "--changed-from",
      before.stateHash,
      "--cursor",
      `${before.cursor.x + 1},${before.cursor.y + 1}`,
      before.cursor.visible ? "--no-cursor-visible" : "--cursor-visible",
      before.alternateScreen ? "--no-alternate" : "--alternate",
      "--timeout",
      "150ms",
      "--interval",
      "30ms",
      "--json",
    ]);
    expect(pending.result).toBe(1);
    expect((JSON.parse(pending.stdout) as { pending: string[] }).pending).toHaveLength(5);

    expect((await run(["wait", SESSION, "--cursor", "bad"])).result).toBe(2);
    await run(["keys", SESSION, "Down"]);
    expect(
      (
        await run([
          "wait",
          SESSION,
          "--changed-from",
          before.stateHash,
          "--timeout",
          "3s",
          "--quiet",
        ])
      ).result,
    ).toBe(0);
  }, 30_000);

  test("diff compares ANSI and complete state between stored and live captures", async () => {
    await run(["snap", SESSION, "--label", "state-before"]);
    await run(["keys", SESSION, "Down"]);
    await run(["snap", SESSION, "--label", "state-after"]);

    expect(
      (await run(["diff", SESSION, "state-before", "state-after", "--mode", "ansi"])).result,
    ).toBe(1);
    expect(
      (await run(["diff", SESSION, "state-before", "state-after", "--mode", "state"])).result,
    ).toBe(1);
    expect((await run(["diff", SESSION, "state-after", "live", "--mode", "state"])).result).toBe(0);
    const invalid = await run(["diff", SESSION, "state-before", "--mode", "pixels"]);
    expect(invalid.result).toBe(2);
    expect(invalid.stderr).toContain("text, ansi or state");
  }, 30_000);

  test("paste delivers a payload from a file", async () => {
    const payload = join(stateDir, "payload.txt");
    await Bun.write(payload, "pasted-text");
    const { result, stdout } = await run(["paste", SESSION, "--file", payload]);
    expect(result).toBe(0);
    expect(stdout).toContain("pasted 11 characters");
  }, 30_000);

  test("move, drag and scroll report the encoding they used", async () => {
    const move = await run(["move", SESSION, "10", "5"]);
    expect(move.result).toBe(0);
    expect(move.stdout).toContain("moved to 10,5");

    const drag = await run(["drag", SESSION, "2", "3", "8", "6", "--steps", "2"]);
    expect(drag.result).toBe(0);
    expect(drag.stdout).toContain("dragged 2,3 -> 8,6");

    const scroll = await run(["scroll", SESSION, "--down", "--amount", "2"]);
    expect(scroll.result).toBe(0);
    expect(scroll.stdout).toContain("scrolled down");
  }, 30_000);

  test("drag without four coordinates is a usage error", async () => {
    const { result, stderr } = await run(["drag", SESSION, "1", "2"]);
    expect(result).toBe(2);
    expect(stderr).toContain("four coordinates");
  });

  test("click rejects a bad button and bad modifiers", async () => {
    const button = await run(["click", SESSION, "1", "1", "--button", "elbow"]);
    expect(button.result).toBe(2);
    expect(button.stderr).toContain("unknown mouse button");

    const modifiers = await run(["click", SESSION, "1", "1", "--modifiers", "hyper"]);
    expect(modifiers.result).toBe(2);
    expect(modifiers.stderr).toContain("unknown modifier");

    const encoding = await run(["click", SESSION, "1", "1", "--encoding", "guess"]);
    expect(encoding.result).toBe(2);
    expect(encoding.stderr).toContain("unknown mouse encoding");

    const outside = await run(["click", SESSION, "999", "1"]);
    expect(outside.result).toBe(2);
    expect(outside.stderr).toContain("outside");

    const stale = await run(["click", SESSION, "1", "1", "--if-hash", "stale"]);
    expect(stale.result).toBe(1);
    expect(stale.stderr).toContain("screen changed");
  });

  test("click needs coordinates or a text target", async () => {
    const { result, stderr } = await run(["click", SESSION]);
    expect(result).toBe(2);
    expect(stderr).toContain("provide X and Y coordinates");
  });

  test("frame --json carries the body and the record", async () => {
    await run(["snap", SESSION, "--label", "json-frame"]);
    const { result, stdout } = await run(["frame", SESSION, "json-frame", "--json"]);
    expect(result).toBe(0);
    const frame = JSON.parse(stdout) as { label: string; body: string; cols: number };
    expect(frame.label).toBe("json-frame");
    expect(frame.cols).toBe(FIXTURE_COLS);
    expect(frame.body).toContain("TUI DRIVER DEMO");
  }, 30_000);

  test("frames --json and --last narrow the listing", async () => {
    const { result, stdout } = await run(["frames", SESSION, "--last", "1", "--json"]);
    expect(result).toBe(0);
    expect(JSON.parse(stdout)).toHaveLength(1);
  }, 30_000);

  test("snap --scrollback and --raw change what is printed", async () => {
    const raw = await run(["snap", SESSION, "--raw", "--no-save"]);
    expect(raw.result).toBe(0);
    expect(raw.stdout).not.toContain("·");

    const scrollback = await run(["snap", SESSION, "--scrollback", "5", "--no-save"]);
    expect(scrollback.result).toBe(0);
    expect(scrollback.stdout).toContain("TUI DRIVER DEMO");
  }, 30_000);

  test("clean removes the artifacts but leaves the session running", async () => {
    const { result, stdout } = await run(["clean", SESSION]);
    expect(result).toBe(0);
    expect(stdout).toContain("removed artifacts");
    expect(await Bun.file(join(sessionDir(SESSION), "frames.jsonl")).exists()).toBe(false);

    const alive = await run(["snap", SESSION, "--no-save"]);
    expect(alive.result).toBe(0);
  }, 30_000);

  test("stop --all clears every session", async () => {
    const { result, stdout } = await run(["stop", "--all"]);
    expect(result).toBe(0);
    expect(stdout).toContain(SESSION);

    const empty = await run(["stop", "--all"]);
    expect(empty.stdout).toContain("no sessions running");
  }, 30_000);
});
