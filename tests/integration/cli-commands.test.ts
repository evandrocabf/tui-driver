import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { main } from "../../src/cli.js";
import { setDeadline } from "../../src/lifetime.js";
import {
  captureOutput,
  createState,
  destroyState,
  FIXTURE_COLS,
  FIXTURE_ROWS,
  MENU_FIXTURE,
  restoreHome,
  TOOLS_AVAILABLE,
  until,
} from "../helpers/tui.js";

/**
 * The command surface that cli.test.ts does not reach: the JSON variants, the housekeeping
 * commands, and the option branches that only matter when something has gone wrong.
 */

const previousHome = process.env["TUI_DRIVER_HOME"];
let stateDir = "";
let workDir = "";

function run(argv: string[]): Promise<{ result: number; stdout: string; stderr: string }> {
  return captureOutput(() => main(argv));
}

/** Start a fixture session and return its name, so each test can have its own. */
async function startFixture(name: string, extra: string[] = []): Promise<string> {
  const { result } = await run([
    "start",
    "--name",
    name,
    "--size",
    `${FIXTURE_COLS}x${FIXTURE_ROWS}`,
    ...extra,
    "--",
    "python3",
    MENU_FIXTURE,
  ]);
  expect(result).toBe(0);
  return name;
}

describe.skipIf(!TOOLS_AVAILABLE)("cli commands", () => {
  beforeAll(async () => {
    stateDir = await createState("cli-commands");
    workDir = join(stateDir, "work");
    await mkdir(workDir, { recursive: true });
  });

  afterAll(async () => {
    await destroyState(stateDir);
    restoreHome(previousHome);
  });

  describe("the dispatcher", () => {
    test("--version prints the package version", async () => {
      const { result, stdout } = await run(["--version"]);
      expect(result).toBe(0);
      expect(stdout).toMatch(/^tui-driver \d+\.\d+\.\d+/);
      expect((await run(["-v"])).stdout).toBe(stdout);
    });

    test("no arguments prints the command list", async () => {
      const { result, stdout } = await run([]);
      expect(result).toBe(0);
      expect(stdout).toContain("usage: tui <command>");
      expect(stdout).toContain("start");
    });

    test("help for one command prints its options", async () => {
      const { result, stdout } = await run(["help", "click"]);
      expect(result).toBe(0);
      expect(stdout).toContain("usage: tui click");
      expect(stdout).toContain("--button");
    });

    test("--help after a command name prints that command's help", async () => {
      const { result, stdout } = await run(["click", "--help"]);
      expect(result).toBe(0);
      expect(stdout).toContain("usage: tui click");
    });

    test("an unknown command exits 2 and lists what is available", async () => {
      const { result, stdout, stderr } = await run(["nonsense"]);
      expect(result).toBe(2);
      expect(stderr).toContain('unknown command "nonsense"');
      expect(stdout).toContain("usage: tui <command>");
    });

    test("an unknown option exits 2 with the command's usage line", async () => {
      const { result, stderr } = await run(["snap", "whatever", "--not-an-option"]);
      expect(result).toBe(2);
      expect(stderr).toContain("unknown option");
      expect(stderr).toContain("usage: tui snap");
    });
  });

  describe("doctor", () => {
    test("reports the environment and exits 0 when tmux is present", async () => {
      const { result, stdout } = await run(["doctor"]);
      expect(result).toBe(0);
      expect(stdout).toContain("tmux");
      expect(stdout).toContain("terminfo");
      expect(stdout).toContain("state directory");
    });

    test("--json marks only the required checks as required", async () => {
      const { result, stdout } = await run(["doctor", "--json"]);
      expect(result).toBe(0);
      const report = JSON.parse(stdout) as {
        ok: boolean;
        checks: { name: string; ok: boolean; required: boolean }[];
      };
      expect(report.ok).toBe(true);
      /* Image rendering is optional: --svg needs nothing, so a machine with no rasterizer must
         still pass a CI run that never asks for an image. */
      expect(report.checks.find((c) => c.name === "image rendering")?.required).toBe(false);
      expect(report.checks.find((c) => c.name === "tmux")?.required).toBe(true);
    });
  });

  describe("ls and clean", () => {
    test("ls reports no sessions when none are running", async () => {
      const { result, stdout } = await run(["ls"]);
      expect(result).toBe(0);
      expect(stdout).toContain("no sessions running");
    });

    test("ls --json is an array", async () => {
      const name = await startFixture("ls-json");
      const { result, stdout } = await run(["ls", "--json"]);
      expect(result).toBe(0);
      const rows = JSON.parse(stdout) as { name: string; cols: number }[];
      expect(rows.some((row) => row.name === name)).toBe(true);
      await run(["stop", name]);
    }, 30_000);

    test("clean removes a stopped session's artifacts", async () => {
      const name = await startFixture("clean-me");
      await run(["snap", name, "--label", "keep"]);
      await run(["stop", name]);

      const { result, stdout } = await run(["clean", name]);
      expect(result).toBe(0);
      expect(stdout).toContain(name);
      expect(await Bun.file(join(stateDir, "sessions", name, "frames.jsonl")).exists()).toBe(false);
    }, 30_000);

    test("clean --all clears everything", async () => {
      await startFixture("clean-all-1");
      await run(["stop", "clean-all-1"]);
      const { result } = await run(["clean", "--all"]);
      expect(result).toBe(0);
    }, 30_000);
  });

  describe("start options", () => {
    test("--shell runs a command string, and --json reports the metadata", async () => {
      const { result, stdout } = await run([
        "start",
        "--name",
        "shell-start",
        "--shell",
        "printf 'FROM SHELL\\n'; sleep 30",
        "--json",
      ]);
      expect(result).toBe(0);
      const { session } = JSON.parse(stdout) as {
        session: { name: string; command: string; ttlMs: number };
      };
      expect(session.name).toBe("shell-start");
      expect(session.command).toContain("FROM SHELL");
      expect(session.ttlMs).toBeGreaterThan(0);
      await run(["stop", "shell-start"]);
    }, 30_000);

    test("--env reaches the program, and --wait-text gates the return", async () => {
      const { result, stdout } = await run([
        "start",
        "--name",
        "env-start",
        "--env",
        "TUI_DRIVER_PROBE=probe-value",
        "--wait-text",
        "probe-value",
        "--shell",
        'printf "%s\\n" "$TUI_DRIVER_PROBE"; sleep 30',
      ]);
      expect(result).toBe(0);
      expect(stdout).toContain("probe-value");
      await run(["stop", "env-start"]);
    }, 30_000);

    test("--raw-log streams the pane output to a file", async () => {
      /* Printed in a loop rather than once: pipe-pane is attached just after the session is
         created, so anything the program wrote in that gap is genuinely not captured. */
      await run([
        "start",
        "--name",
        "rawlog",
        "--raw-log",
        "--wait-text",
        "LOGGED",
        "--shell",
        'while :; do printf "LOGGED\\n"; sleep 0.2; done',
      ]);
      const log = join(stateDir, "sessions", "rawlog", "raw-output.log");
      await until(async () => (await Bun.file(log).text()).includes("LOGGED"), 8000);
      expect(await Bun.file(log).text()).toContain("LOGGED");
      await run(["stop", "rawlog"]);
    }, 30_000);

    test("--record starts a recorder alongside the session", async () => {
      await startFixture("recorded", ["--record", "200ms"]);
      const { stdout } = await run(["watch", "recorded", "--status"]);
      expect(stdout).toContain("recording");
      await run(["watch", "recorded", "--stop"]);
      await run(["stop", "recorded"]);
    }, 30_000);

    test("--ttl cannot disable the lease", async () => {
      const { result, stderr } = await run([
        "start",
        "--name",
        "immortal",
        "--ttl",
        "never",
        "--",
        "sleep",
        "5",
      ]);
      expect(result).toBe(2);
      expect(stderr).toContain("cannot disable the lease");
    });

    test("--ttl rejects a value over the ceiling", async () => {
      const { result, stderr } = await run([
        "start",
        "--name",
        "toolong",
        "--ttl",
        "90m",
        "--",
        "sleep",
        "5",
      ]);
      expect(result).toBe(2);
      expect(stderr).toContain("cannot exceed");
    });

    test("starting with nothing to run is a usage error", async () => {
      const { result, stderr } = await run(["start", "--name", "empty"]);
      expect(result).toBe(2);
      expect(stderr).toContain("nothing to run");
    });
  });

  describe("wait", () => {
    test("--gone waits for text to disappear", async () => {
      const name = await startFixture("wait-gone");
      /* The banner is on screen now, so --gone must time out rather than pass vacuously. */
      const { result } = await run([
        "wait",
        name,
        "--gone",
        "TUI DRIVER DEMO",
        "--timeout",
        "300ms",
        "--quiet",
      ]);
      expect(result).toBe(1);
      await run(["stop", name]);
    }, 30_000);

    test("--exit waits for the process to die", async () => {
      await run(["start", "--name", "wait-exit", "--shell", "sleep 0.3"]);
      const { result, stdout } = await run(["wait", "wait-exit", "--exit", "--timeout", "10s"]);
      expect(result).toBe(0);
      expect(stdout).toContain("condition met");
      await run(["stop", "wait-exit"]);
    }, 30_000);

    test("--json reports the conditions still pending on timeout", async () => {
      const name = await startFixture("wait-json");
      const { result, stdout } = await run([
        "wait",
        name,
        "--text",
        "NEVER-APPEARS",
        "--timeout",
        "300ms",
        "--json",
      ]);
      expect(result).toBe(1);
      const report = JSON.parse(stdout) as { ok: boolean; pending: string[] };
      expect(report.ok).toBe(false);
      expect(report.pending.join(" ")).toContain("NEVER-APPEARS");
      await run(["stop", name]);
    }, 30_000);

    test("waiting with no condition succeeds immediately", async () => {
      /* Not an error: with nothing requested there is nothing pending, so the wait is satisfied on
         the first capture. It prints the screen, which is the useful part. */
      const name = await startFixture("wait-nocond");
      const { result, stdout } = await run(["wait", name]);
      expect(result).toBe(0);
      expect(stdout).toContain("TUI DRIVER DEMO");
      await run(["stop", name]);
    }, 30_000);
  });

  describe("find, frames and diff", () => {
    test("find --json returns every match with coordinates", async () => {
      const name = await startFixture("find-json");
      const { result, stdout } = await run(["find", name, "e", "--all", "--ignore-case", "--json"]);
      expect(result).toBe(0);
      const found = JSON.parse(stdout) as {
        pattern: string;
        matches: { row: number; col: number }[];
      };
      expect(found.pattern).toBe("e");
      expect(found.matches.length).toBeGreaterThan(1);
      await run(["stop", name]);
    }, 30_000);

    test("find --regex --nth selects one match", async () => {
      const name = await startFixture("find-nth");
      const { result, stdout } = await run(["find", name, "^\\s*\\w+", "--regex", "--nth", "1"]);
      expect(result).toBe(0);
      expect(stdout).toContain("tui click");
      await run(["stop", name]);
    }, 30_000);

    test("frames --last limits the list, and --json is machine-readable", async () => {
      const name = await startFixture("frames-json");
      for (const label of ["a", "b", "c"]) await run(["snap", name, "--label", label]);

      const listed = await run(["frames", name, "--last", "2"]);
      expect(listed.result).toBe(0);

      const { result, stdout } = await run(["frames", name, "--json"]);
      expect(result).toBe(0);
      expect((JSON.parse(stdout) as unknown[]).length).toBeGreaterThanOrEqual(3);
      await run(["stop", name]);
    }, 40_000);

    test("frames on a session with none recorded says so", async () => {
      const name = await startFixture("frames-empty", ["--no-snap"]);
      const { stdout } = await run(["frames", name]);
      expect(stdout.toLowerCase()).toContain("no frames");
      await run(["stop", name]);
    }, 30_000);
  });

  describe("resize and paste", () => {
    test("resize changes the pinned size", async () => {
      const name = await startFixture("resize-me");
      const { result, stdout } = await run(["resize", name, "70x20"]);
      expect(result).toBe(0);
      expect(stdout).toContain("70x20");

      const snap = await run(["snap", name, "--no-save"]);
      expect(snap.stdout).toContain("70x20");
      await run(["stop", name]);
    }, 30_000);

    test("resize rejects a malformed size", async () => {
      const name = await startFixture("resize-bad");
      const { result, stderr } = await run(["resize", name, "wide"]);
      expect(result).toBe(2);
      expect(stderr).toContain("invalid size");
      await run(["stop", name]);
    }, 30_000);

    test("paste sends a block from a file", async () => {
      const name = await startFixture("paste-file");
      const payload = join(workDir, "payload.txt");
      await Bun.write(payload, "pasted-from-file\n");

      const { result, stdout } = await run(["paste", name, "--file", payload]);
      expect(result).toBe(0);
      expect(stdout).toContain("pasted");
      await run(["stop", name]);
    }, 30_000);

    test("paste takes literal positional text, and --enter submits it", async () => {
      /* Not tested: `paste` with neither text nor --file reads stdin, which is the documented way
         to pipe a payload in. It blocks by design, so there is nothing to assert in-process. */
      const name = await startFixture("paste-literal");
      const { result, stdout } = await run([
        "paste",
        name,
        "literal",
        "payload",
        "--no-bracket",
        "--enter",
      ]);
      expect(result).toBe(0);
      expect(stdout).toContain("pasted");
      await run(["stop", name]);
    }, 30_000);

    test("paste from an empty file is a usage error", async () => {
      const name = await startFixture("paste-blank");
      const blank = join(workDir, "blank.txt");
      await Bun.write(blank, "");
      const { result, stderr } = await run(["paste", name, "--file", blank]);
      expect(result).toBe(2);
      expect(stderr).toContain("nothing to paste");
      await run(["stop", name]);
    }, 30_000);
  });

  describe("watch", () => {
    test("--status on a session with no recorder says so", async () => {
      const name = await startFixture("watch-status");
      const { result, stdout } = await run(["watch", name, "--status"]);
      expect(result).toBe(0);
      expect(stdout.toLowerCase()).toContain("no recorder");
      await run(["stop", name]);
    }, 30_000);

    test("--stop with no recorder running is not an error", async () => {
      const name = await startFixture("watch-nostop");
      const { result } = await run(["watch", name, "--stop"]);
      expect(result).toBe(0);
      await run(["stop", name]);
    }, 30_000);

    test("a second recorder for one session is refused", async () => {
      const name = await startFixture("watch-double");
      await run(["watch", name, "--interval", "300ms"]);
      const { result, stderr } = await run(["watch", name, "--interval", "300ms"]);
      expect(result).toBe(2);
      expect(stderr).toContain("already recording");
      await run(["watch", name, "--stop"]);
      await run(["stop", name]);
    }, 40_000);

    test("--status --json describes the running recorder", async () => {
      const name = await startFixture("watch-json");
      await run(["watch", name, "--interval", "300ms"]);
      const { result, stdout } = await run(["watch", name, "--status", "--json"]);
      expect(result).toBe(0);
      const state = JSON.parse(stdout) as { pid: number; session: string };
      expect(state.session).toBe(name);
      expect(state.pid).toBeGreaterThan(0);
      await run(["watch", name, "--stop"]);
      await run(["stop", name]);
    }, 40_000);

    test("--foreground records in this process until the frame budget is met", async () => {
      const name = await startFixture("watch-fg");
      const { result, stdout } = await run([
        "watch",
        name,
        "--foreground",
        "--interval",
        "100ms",
        "--max-frames",
        "1",
        "--duration",
        "5s",
      ]);
      expect(result).toBe(0);
      expect(stdout).toContain("frame");
      await run(["stop", name]);
    }, 40_000);
  });

  describe("keepalive and gc", () => {
    test("keepalive pushes the deadline back", async () => {
      const name = await startFixture("keep-me");
      const { result, stdout } = await run(["keepalive", name, "20m"]);
      expect(result).toBe(0);
      expect(stdout).toContain(name);
      await run(["stop", name]);
    }, 30_000);

    test("keepalive --json reports the new deadline", async () => {
      const name = await startFixture("keep-json");
      const { result, stdout } = await run(["keepalive", name, "--ttl", "15m", "--json"]);
      expect(result).toBe(0);
      const report = JSON.parse(stdout) as { expiresAtMs: number };
      expect(report.expiresAtMs).toBeGreaterThan(Date.now());
      await run(["stop", name]);
    }, 30_000);

    test("keepalive on a missing session exits 4", async () => {
      const { result, stderr } = await run(["keepalive", "not-a-session"]);
      expect(result).toBe(4);
      expect(stderr).toContain("no session");
    });

    test("gc reaps a session whose lease has run out", async () => {
      const name = await startFixture("gc-expired");
      /* Backdate the deadline rather than waiting out a real lease. */
      await setDeadline(name, Date.now() - 1000);

      const { result, stdout } = await run(["gc"]);
      expect(result).toBe(0);
      expect(stdout).toContain(name);
      expect((await run(["ls"])).stdout).not.toContain(name);
    }, 30_000);

    test("gc --json reports what it reaped", async () => {
      const name = await startFixture("gc-json");
      await setDeadline(name, Date.now() - 1000);

      const { result, stdout } = await run(["gc", "--json"]);
      expect(result).toBe(0);
      const { reaped } = JSON.parse(stdout) as { reaped: { name: string; reason: string }[] };
      expect(reaped.some((row) => row.name === name && row.reason === "expired")).toBe(true);
    }, 30_000);

    test("gc --max-age 0 kills everything, lease or not", async () => {
      const name = await startFixture("gc-maxage");
      const { result, stdout } = await run(["gc", "--max-age", "0"]);
      expect(result).toBe(0);
      expect(stdout).toContain(name);
      expect((await run(["ls"])).stdout).toContain("no sessions running");
    }, 30_000);

    test("gc with nothing to reap says so", async () => {
      const { result, stdout } = await run(["gc"]);
      expect(result).toBe(0);
      expect(stdout.toLowerCase()).toContain("nothing");
    });
  });

  describe("run", () => {
    test("--json emits the report, and --keep leaves the session up", async () => {
      const scenario = join(workDir, "keep.yaml");
      await Bun.write(
        scenario,
        `name: keep-run
session: run-keep
command: ["python3", ${JSON.stringify(MENU_FIXTURE)}]
size: ${FIXTURE_COLS}x${FIXTURE_ROWS}
steps:
  - wait: { text: "TUI DRIVER DEMO", timeout: 10s }
`,
      );

      const { result, stdout } = await run(["run", scenario, "--keep", "--json"]);
      expect(result).toBe(0);
      const report = JSON.parse(stdout) as { ok: boolean; steps: unknown[] };
      expect(report.ok).toBe(true);
      expect(report.steps).toHaveLength(1);

      expect((await run(["ls"])).stdout).toContain("run-keep");
      await run(["stop", "run-keep"]);
    }, 60_000);

    test("a missing scenario file is a usage error", async () => {
      const { result, stderr } = await run(["run", join(workDir, "absent.yaml")]);
      expect(result).toBe(2);
      expect(stderr).toContain("not found");
    });

    test("a failing step exits 1 and names the step", async () => {
      const scenario = join(workDir, "failing.yaml");
      await Bun.write(
        scenario,
        `name: failing-run
session: run-fail
command: ["python3", ${JSON.stringify(MENU_FIXTURE)}]
size: ${FIXTURE_COLS}x${FIXTURE_ROWS}
steps:
  - wait: { text: "TUI DRIVER DEMO", timeout: 10s }
  - expect: { text: "NOT ON THIS SCREEN" }
`,
      );

      const { result, stdout } = await run(["run", scenario, "--out", join(workDir, "fail-out")]);
      expect(result).toBe(1);
      expect(stdout).toContain("FAIL");
      /* The failing run still writes its report — that is the one you actually want on disk. */
      expect(await Bun.file(join(workDir, "fail-out", "report.json")).exists()).toBe(true);
    }, 60_000);
  });

  describe("output variants and warnings", () => {
    test("an action with --snap --json emits the snapshot as JSON", async () => {
      const name = await startFixture("act-json");
      const { result, stdout } = await run(["keys", name, "Down", "--snap", "--json"]);
      expect(result).toBe(0);
      const snapshot = JSON.parse(stdout) as { summary: string; text: string };
      expect(snapshot.summary).toContain("Down");
      expect(snapshot.text).toContain("SELECTED");
      await run(["stop", name]);
    }, 30_000);

    test("snap --out writes exactly where told and skips the frame store", async () => {
      const name = await startFixture("snap-out");
      const target = join(workDir, "explicit.svg");

      const { result, stdout } = await run(["snap", name, "--out", target, "--svg"]);
      expect(result).toBe(0);
      expect(stdout).toContain(target);
      expect(await Bun.file(target).exists()).toBe(true);
      /* --out means "this file, nothing else": no frame is recorded alongside it. */
      expect((await run(["frames", name])).stdout.toLowerCase()).toContain("no frames");
      await run(["stop", name]);
    }, 30_000);

    test("render --json reports the geometry and backend", async () => {
      const name = await startFixture("render-json");
      const { result, stdout } = await run(["render", name, "--svg", "--json"]);
      expect(result).toBe(0);
      const rendered = JSON.parse(stdout) as { path: string; format: string; width: number };
      expect(rendered.format).toBe("svg");
      expect(rendered.width).toBeGreaterThan(0);
      await run(["stop", name]);
    }, 30_000);

    test("diff --json reports identical and changed screens", async () => {
      const name = await startFixture("diff-json");
      await run(["snap", name, "--label", "base"]);

      const same = await run(["diff", name, "base", "live", "--json"]);
      expect(same.result).toBe(0);
      expect((JSON.parse(same.stdout) as { identical: boolean }).identical).toBe(true);

      await run(["keys", name, "Down"]);
      await run(["wait", name, "--stable", "200ms", "--quiet"]);
      const moved = await run(["diff", name, "base", "live", "--json"]);
      expect(moved.result).toBe(1);
      const report = JSON.parse(moved.stdout) as { identical: boolean; changed: unknown[] };
      expect(report.identical).toBe(false);
      expect(report.changed.length).toBeGreaterThan(0);
      await run(["stop", name]);
    }, 40_000);

    test("clicking a TUI that never enabled the mouse warns rather than failing", async () => {
      /* The bytes are delivered either way; the warning is what stops it looking like a no-op. */
      await run(["start", "--name", "mouse-off", "--shell", "sleep 30"]);
      const { result, stderr } = await run(["click", "mouse-off", "1", "1"]);
      expect(result).toBe(0);
      expect(stderr).toContain("has not enabled mouse reporting");
      await run(["stop", "mouse-off"]);
    }, 30_000);

    test("non-numeric coordinates are a usage error", async () => {
      const name = await startFixture("click-bad");
      const { result, stderr } = await run(["click", name, "left", "top"]);
      expect(result).toBe(2);
      expect(stderr).toContain("invalid coordinates");
      await run(["stop", name]);
    }, 30_000);

    test("--wait-text that never matches warns but still starts the session", async () => {
      const { result, stderr } = await run([
        "start",
        "--name",
        "wait-text-miss",
        "--wait-text",
        "NEVER-PRINTED",
        "--wait-timeout",
        "500ms",
        "--shell",
        "sleep 30",
      ]);
      expect(result).toBe(0);
      expect(stderr).toContain("never matched");
      await run(["stop", "wait-text-miss"]);
    }, 30_000);

    test("watch --status --json with no recorder reports null", async () => {
      const name = await startFixture("watch-nostatus-json");
      const { result, stdout } = await run(["watch", name, "--status", "--json"]);
      expect(result).toBe(0);
      expect(JSON.parse(stdout)).toBeNull();
      await run(["stop", name]);
    }, 30_000);

    test("the hidden watch-daemon subcommand runs the loop directly", async () => {
      /* This is what `tui watch` re-executes as a detached child; it is not in `tui help`. */
      const name = await startFixture("daemon-cmd");
      const { result } = await run([
        "watch-daemon",
        name,
        "--interval",
        "100",
        "--max-frames",
        "1",
        "--duration",
        "4000",
      ]);
      expect(result).toBe(0);
      expect((await run(["frames", name])).stdout).not.toContain("no frames");
      await run(["stop", name]);
    }, 40_000);
  });

  describe("cleanup between runs", () => {
    test("stop --all clears every session", async () => {
      await startFixture("stop-all-1");
      await startFixture("stop-all-2");
      const { result } = await run(["stop", "--all"]);
      expect(result).toBe(0);
      expect((await run(["ls"])).stdout).toContain("no sessions running");
    }, 40_000);

    test("stopping a session that is already gone is not an error", async () => {
      const { result } = await run(["stop", "never-existed"]);
      expect(result).toBe(0);
    });
  });
});

afterAll(async () => {
  await rm(join(stateDir, "work"), { recursive: true, force: true }).catch(() => undefined);
});
