import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { formatScenarioReport, runScenario } from "../../src/scenario.js";
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
let stateDir = "";
let workDir = "";

function scenarioYaml(session: string, extraSteps = ""): string {
  return `name: fixture-smoke
session: ${session}
command: ["python3", ${JSON.stringify(MENU_FIXTURE)}]
size: ${FIXTURE_COLS}x${FIXTURE_ROWS}

steps:
  - wait: { text: "TUI DRIVER DEMO", timeout: 10s }
  - expect: { text: "SELECTED: Dashboard" }
  - expect: { notText: "Traceback" }
  - keys: [Down]
  - wait: { stable: 200ms }
  - expect: { text: "SELECTED: Settings" }
  - click: { text: "Reports" }
  - wait: { stable: 200ms }
  - expect: { text: "ACTIVATED: Reports" }
  - snap: { label: reports }
${extraSteps}`;
}

/** A cheap stable hash, only to give each malformed case its own filename. */
function hashOf(input: string): number {
  let hash = 0;
  for (const char of input) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hash;
}

async function writeScenario(name: string, body: string): Promise<string> {
  const path = join(workDir, `${name}.yaml`);
  await Bun.write(path, body);
  return path;
}

describe.skipIf(!TOOLS_AVAILABLE)("scenario runner", () => {
  beforeAll(async () => {
    stateDir = await createState("scenario");
    workDir = join(stateDir, "work");
    await mkdir(workDir, { recursive: true });
  });

  afterAll(async () => {
    await destroyState(stateDir);
    restoreHome(previousHome);
  });

  test("runs every step and writes a report", async () => {
    const path = await writeScenario("smoke", scenarioYaml("scn-smoke"));
    const report = await runScenario(path, { outDir: join(workDir, "out-smoke") });

    expect(report.ok).toBe(true);
    expect(report.steps).toHaveLength(10);
    expect(report.steps.every((step) => step.ok)).toBe(true);
    expect(await Bun.file(join(report.outDir, "report.json")).exists()).toBe(true);
    expect(await Bun.file(join(report.outDir, "reports.txt")).text()).toContain(
      "ACTIVATED: Reports",
    );

    const rendered = formatScenarioReport(report);
    expect(rendered).toContain("PASS fixture-smoke");
    expect(rendered).toContain("artifacts:");
  }, 60_000);

  test("the example shipped in examples/ still passes against its committed golden", async () => {
    /* The README points users at this file and it ships in the package, so it has to keep working.
       Nothing else exercises it: without this the example can rot silently while the docs still
       tell people to run it.

       outDir is redirected into the test's own state directory. Left to itself the run would write
       .tui-artifacts/ next to the scenario — i.e. into the repo — on every `bun test`. */
    const example = join(import.meta.dir, "..", "..", "examples", "menu-smoke.yaml");
    const report = await runScenario(example, { outDir: join(workDir, "out-example") });

    /* Assert on the failing steps rather than on `ok` alone. This test runs a real curses app on
       whatever machine CI happens to give us, so it is the one most likely to fail somewhere the
       author cannot reach — and `expected true, got false` says nothing about which step broke. */
    const failures = report.steps
      .filter((step) => !step.ok)
      .map((step) => `step ${step.index} (${step.action}): ${step.detail}`);
    expect(failures).toEqual([]);
    expect(report.ok).toBe(true);
    /* The golden must MATCH, not be created: a missing golden would silently pass otherwise. */
    expect(report.steps.find((step) => step.action === "golden")?.detail).toContain("matches");
  }, 90_000);

  test("a malformed scenario is rejected before anything is launched", async () => {
    /* Structural errors throw out of runScenario rather than becoming failed steps: there is no
       session yet, so there is nothing to report against. */
    const cases: [string, RegExp][] = [
      ["- not a mapping\n", /scenario must be a mapping/],
      [`name: ok\ncommand: [{}]\nsteps: []\n`, /must be a string/],
      [`name: ok\ncommand: ["sleep","1"]\nenv: notamapping\nsteps: []\n`, /must be a mapping/],
    ];

    for (const [body, expected] of cases) {
      const path = await writeScenario(`bad-${Math.abs(hashOf(body))}`, body);
      expect(runScenario(path, { outDir: join(workDir, "out-bad") })).rejects.toThrow(expected);
    }
  }, 60_000);

  test("a malformed step is a failed step, not a thrown error", async () => {
    /* By this point a session exists, so the failure belongs in the report — and the `finally`
       still has to stop the session. */
    const path = await writeScenario(
      "bad-step",
      `name: bad-step
session: scn-badstep
command: ["python3", ${JSON.stringify(MENU_FIXTURE)}]
size: ${FIXTURE_COLS}x${FIXTURE_ROWS}
steps:
  - wait: { text: "TUI DRIVER DEMO", timeout: 10s }
  - click: 42
`,
    );
    const report = await runScenario(path, { outDir: join(workDir, "out-badstep") });
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)?.detail).toMatch(/must be a mapping/);
  }, 60_000);

  test("numbers and booleans are accepted where a string is expected", async () => {
    /* YAML types a bare 3000 as a number; demanding quotes everywhere would be a trap. */
    const path = await writeScenario(
      "coerced",
      `name: coerced
session: scn-coerced
command: ["python3", ${JSON.stringify(MENU_FIXTURE)}]
size: ${FIXTURE_COLS}x${FIXTURE_ROWS}
env:
  TUI_DRIVER_NUMBER: 3000
  TUI_DRIVER_FLAG: true
steps:
  - wait: { text: "TUI DRIVER DEMO", timeout: 10s }
  - click: { x: 2, y: 3 }
  - move: { x: 1, y: 1 }
`,
    );
    const report = await runScenario(path, { outDir: join(workDir, "out-coerced") });
    expect(report.ok).toBe(true);
  }, 60_000);

  test("a bare string command is run as a single program", async () => {
    /* The string form takes the whole value as one argv entry, so it suits a bare program name.
       Anything with arguments belongs in the array form or in `shell`. */
    const path = await writeScenario(
      "string-command",
      `name: string-command
session: scn-string
command: cat
size: ${FIXTURE_COLS}x${FIXTURE_ROWS}
steps:
  - wait: { stable: 300ms, timeout: 10s }
`,
    );
    const report = await runScenario(path, { outDir: join(workDir, "out-string") });
    expect(report.ok).toBe(true);
  }, 60_000);

  test("a scenario can start its own recorder", async () => {
    const path = await writeScenario(
      "recorded",
      `name: recorded
session: scn-recorded
command: ["python3", ${JSON.stringify(MENU_FIXTURE)}]
size: ${FIXTURE_COLS}x${FIXTURE_ROWS}
record: 200ms
steps:
  - wait: { text: "TUI DRIVER DEMO", timeout: 10s }
  - keys: [Down]
  - wait: { stable: 300ms }
`,
    );
    const report = await runScenario(path, { outDir: join(workDir, "out-recorded") });
    expect(report.ok).toBe(true);
  }, 60_000);

  test("creates a golden on the first run and matches it on the second", async () => {
    const path = await writeScenario(
      "golden",
      scenarioYaml("scn-golden", "  - golden: reports-screen\n"),
    );
    const outDir = join(workDir, "out-golden");

    const first = await runScenario(path, { outDir });
    expect(first.ok).toBe(true);
    expect(first.steps.at(-1)?.detail).toContain("created golden");

    const second = await runScenario(path, { outDir });
    expect(second.ok).toBe(true);
    expect(second.steps.at(-1)?.detail).toContain("matches");
  }, 90_000);

  test("fails the run when the screen drifts from the golden", async () => {
    const path = await writeScenario(
      "drift",
      scenarioYaml("scn-drift", "  - golden: drifted\n  - expect: { text: 'Quit' }\n"),
    );
    const outDir = join(workDir, "out-drift");
    const goldenPath = join(workDir, "golden", "drifted.txt");

    await runScenario(path, { outDir });
    await Bun.write(goldenPath, "a completely different screen\n");

    const failed = await runScenario(path, { outDir });
    expect(failed.ok).toBe(false);

    const goldenStep = failed.steps.at(-1);
    expect(goldenStep?.action).toBe("golden");
    expect(goldenStep?.ok).toBe(false);
    expect(goldenStep?.detail).toContain("differs");
    /* The golden is step 10 of 12; the expect that follows it must never have run. */
    expect(goldenStep?.index).toBe(10);
    expect(failed.steps).toHaveLength(11);
    expect(await Bun.file(join(outDir, "drifted.actual.txt")).text()).toContain("ACTIVATED");
    expect(formatScenarioReport(failed)).toContain("FAIL fixture-smoke");
  }, 90_000);

  test("--update-golden accepts the current screen as the new baseline", async () => {
    const path = await writeScenario("update", scenarioYaml("scn-update", "  - golden: drifted\n"));
    const outDir = join(workDir, "out-drift");

    const updated = await runScenario(path, { outDir, updateGolden: true });
    expect(updated.ok).toBe(true);
    expect(updated.steps.at(-1)?.detail).toContain("updated golden");

    const verified = await runScenario(path, { outDir });
    expect(verified.ok).toBe(true);
    expect(verified.steps.at(-1)?.detail).toContain("matches");
  }, 90_000);

  test("stops at a failed expectation and reports the screen", async () => {
    const path = await writeScenario(
      "expect",
      scenarioYaml("scn-expect", "  - expect: { text: 'NEVER ON SCREEN' }\n  - keys: [q]\n"),
    );
    const report = await runScenario(path, { outDir: join(workDir, "out-expect") });

    expect(report.ok).toBe(false);
    const failing = report.steps.at(-1);
    expect(failing?.action).toBe("expect");
    expect(failing?.detail).toContain("NEVER ON SCREEN");
    expect(failing?.detail).toContain("SELECTED");
    /* The `keys` step after the failure never ran. */
    expect(report.steps.some((step) => step.action === "keys" && step.index > 10)).toBe(false);
  }, 60_000);

  test("rejects an unknown step and a missing file", async () => {
    const path = await writeScenario(
      "unknown",
      scenarioYaml("scn-unknown", "  - teleport: somewhere\n"),
    );
    const report = await runScenario(path, { outDir: join(workDir, "out-unknown") });
    expect(report.ok).toBe(false);
    expect(report.steps.at(-1)?.detail).toContain("unknown scenario step: teleport");

    expect(runScenario(join(workDir, "missing.yaml"))).rejects.toThrow(/scenario not found/);
  }, 60_000);

  test("leaves no session behind unless keepSession is set", async () => {
    const { listSessionNames } = await import("../../src/tmux.js");
    const path = await writeScenario("cleanup", scenarioYaml("scn-cleanup"));
    await runScenario(path, { outDir: join(workDir, "out-cleanup") });
    expect(await listSessionNames()).not.toContain("scn-cleanup");
  }, 60_000);

  test("runs every step kind the format documents", async () => {
    const path = await writeScenario(
      "all-steps",
      `name: all-steps
session: scn-all
command: ["python3", ${JSON.stringify(MENU_FIXTURE)}]
size: ${FIXTURE_COLS}x${FIXTURE_ROWS}
settle: 100ms

steps:
  - wait: "TUI DRIVER DEMO"
  - sleep: 50ms
  - type: { text: "x" }
  - paste: { text: "y", bracketed: false }
  - move: { x: 10, y: 5 }
  - drag: { from: [2, 3], to: [8, 6], steps: 2 }
  - scroll: { direction: down, amount: 2 }
  - keys: "Down Down"
  - wait: { stable: 200ms }
  - expect: "SELECTED:"
  - resize: 70x16
  - wait: { stable: 200ms }
  - snap: plain-label
  - keys: [q]
  - wait: { exit: true, timeout: 5s }
`,
    );

    const report = await runScenario(path, { outDir: join(workDir, "out-all") });
    const failures = report.steps.filter((step) => !step.ok);
    expect(failures).toEqual([]);
    expect(report.ok).toBe(true);

    const actions = report.steps.map((step) => step.action);
    expect(actions).toEqual([
      "wait",
      "sleep",
      "type",
      "paste",
      "move",
      "drag",
      "scroll",
      "keys",
      "wait",
      "expect",
      "resize",
      "wait",
      "snap",
      "keys",
      "wait",
    ]);
    expect(report.steps.find((step) => step.action === "resize")?.detail).toContain("70x16");
  }, 90_000);
});
