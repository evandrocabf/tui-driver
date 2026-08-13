/**
 * Scenarios: a repeatable script of steps against a TUI, and the "tester" half of the tool.
 *
 * A scenario declares the program to launch, the size to launch it at, and a list of steps. The
 * whole run is a single session that is always stopped at the end — including when the run ends
 * badly — so a failing test never leaves a process tree behind.
 */

import { dirname, join, resolve as resolvePath } from "node:path";

import { capture, type Snapshot } from "./capture.js";
import { diffText, formatDiff } from "./diff.js";
import { UsageError } from "./errors.js";
import { saveFrame } from "./frames.js";
import {
  mouseClick,
  mouseDrag,
  mouseMove,
  mouseScroll,
  pasteText,
  sendKeys,
  sendText,
} from "./input.js";
import { resolveTtlMs } from "./lifetime.js";
import { locate, pickMatch } from "./locate.js";
import { parseButton, parseModifiers } from "./mouse.js";
import { renderAnsiToFile } from "./render.js";
import { resizeSession, startSession, stopSession, suggestName } from "./session.js";
import { ensureDir, parseDuration, parseSize, sleep, writeJson } from "./util.js";
import { startWatcher, stopWatcher } from "./watch.js";
import { waitFor } from "./wait.js";

/** What one step did, and whether it worked. */
export interface StepResult {
  /** Zero-based position in the scenario, so a failure names the step you can count to. */
  index: number;
  /** The step's action, e.g. `wait`, `click`, `golden`. */
  action: string;
  ok: boolean;
  /** What happened, or why it failed. */
  detail: string;
  /** How long the step took. */
  durationMs: number;
}

/**
 * The outcome of a whole run, also written to `report.json` in the artifact directory.
 *
 * Written whether the run passed or failed — the failing case is the one worth having on disk.
 */
export interface ScenarioReport {
  /** The scenario's name, from its `name` key. */
  name: string;
  /** True only if every step passed. */
  ok: boolean;
  /** The session the run used. */
  session: string;
  /** When the run started, as an ISO-8601 string. */
  startedAt: string;
  /** Total wall-clock time. */
  durationMs: number;
  /** Every step attempted. A failing step is the last entry: the run stops there. */
  steps: StepResult[];
  /** Where artifacts were written. */
  outDir: string;
}

/** How to run a scenario. */
export interface RunScenarioOptions {
  /** Where to write artifacts. Defaults to `.tui-artifacts/<name>` beside the scenario file. */
  outDir?: string;
  /** Accept the current screens as the new goldens instead of comparing against them. */
  updateGolden?: boolean;
  /** Leave the session running after the run. It still expires on its lease. */
  keepSession?: boolean;
}

/** A parsed YAML or JSON object, before any of its keys have been validated. */
type Bag = Record<string, unknown>;

/**
 * Assert that a parsed value is an object.
 *
 * @throws {UsageError} Naming `context`, so the error points at the offending key.
 */
function asBag(value: unknown, context: string): Bag {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UsageError(`${context} must be a mapping`);
  }
  return value as Bag;
}

/**
 * Assert that a parsed value is a string.
 *
 * @throws {UsageError} Naming `context`.
 */
function asString(value: unknown, context: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  throw new UsageError(`${context} must be a string`);
}

/** Read an optional string key, ignoring a value of any other type. */
function optionalString(bag: Bag, key: string): string | undefined {
  const value = bag[key];
  return value === undefined || value === null ? undefined : asString(value, key);
}

/** Read an optional numeric key, accepting a numeric string as well as a number. */
function optionalNumber(bag: Bag, key: string): number | undefined {
  const value = bag[key];
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new UsageError(`${key} must be a number`);
  return parsed;
}

/** Read an optional boolean key. */
function optionalBoolean(bag: Bag, key: string): boolean | undefined {
  const value = bag[key];
  return value === undefined || value === null ? undefined : Boolean(value);
}

/**
 * Read an `{x, y}` pair from a step's payload.
 *
 * @throws {UsageError} If either coordinate is missing or not a number.
 */
function coordinatePair(value: unknown, context: string): { x: number; y: number } {
  if (Array.isArray(value) && value.length >= 2) {
    return { x: Number(value[0]), y: Number(value[1]) };
  }
  const bag = asBag(value, context);
  return { x: Number(bag["x"] ?? 0), y: Number(bag["y"] ?? 0) };
}

/**
 * Load a scenario from YAML or JSON.
 *
 * @throws {UsageError} If the file is missing, unparseable, or not an object at the top level.
 */
async function parseScenarioFile(path: string): Promise<Bag> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new UsageError(`scenario not found: ${path}`);
  const raw = await file.text();
  const parsed: unknown = path.endsWith(".json") ? JSON.parse(raw) : Bun.YAML.parse(raw);
  return asBag(parsed, "scenario");
}

/**
 * Work out which cell a mouse step means.
 *
 * A step can name a `text` target or give explicit coordinates. Text is preferred in scenarios for
 * the same reason it is at the command line: it survives layout changes that fixed coordinates do
 * not.
 *
 * @throws {UsageError} If the text is not on screen, or neither form of target was given.
 */
async function resolveTargetCell(
  session: string,
  bag: Bag,
): Promise<{ x: number; y: number; label: string }> {
  const pattern = optionalString(bag, "text");
  if (pattern === undefined) {
    const x = optionalNumber(bag, "x");
    const y = optionalNumber(bag, "y");
    if (x === undefined || y === undefined) throw new UsageError("click needs x/y or text");
    return { x, y, label: `${x},${y}` };
  }

  const snapshot = await capture(session);
  const matches = locate(snapshot.text, pattern, {
    all: true,
    ...(optionalBoolean(bag, "regex") ? { regex: true } : {}),
    ...(optionalBoolean(bag, "ignoreCase") ? { ignoreCase: true } : {}),
  });
  const match = pickMatch(matches, optionalNumber(bag, "nth"));
  if (!match) throw new UsageError(`no match for ${JSON.stringify(pattern)} on screen`);

  const anchor = optionalString(bag, "at") ?? "center";
  const x =
    anchor === "start"
      ? match.col
      : anchor === "end"
        ? match.col + Math.max(0, match.width - 1)
        : match.centerCol;
  return { x, y: match.row, label: `${JSON.stringify(pattern)} at ${x},${match.row}` };
}

/**
 * Run a scenario from a file, start to finish.
 *
 * Steps run in order and the first failure stops the run — later steps would be testing a screen
 * that never reached the state they assume, and their failures would say nothing useful.
 *
 * The session is stopped in a `finally`, so it goes away even when the scenario itself is malformed.
 *
 * @returns The report. A failed run is a returned report with `ok: false`, not an exception; the
 * caller turns that into exit code 1.
 */
export async function runScenario(
  path: string,
  options: RunScenarioOptions = {},
): Promise<ScenarioReport> {
  const scenario = await parseScenarioFile(path);
  const baseDir = dirname(path);
  const name = optionalString(scenario, "name") ?? "scenario";
  const outDir = options.outDir ?? join(baseDir, ".tui-artifacts", name.replace(/[^\w.-]+/g, "-"));
  const goldenDir = resolvePath(baseDir, optionalString(scenario, "goldenDir") ?? "golden");
  await ensureDir(outDir);

  const rawCommand = scenario["command"];
  const argv = Array.isArray(rawCommand)
    ? rawCommand.map((entry) => asString(entry, "command entry"))
    : typeof rawCommand === "string"
      ? [rawCommand]
      : [];
  const shell = optionalString(scenario, "shell");
  const size = parseSize(optionalString(scenario, "size"), { cols: 120, rows: 32 });

  const env: Record<string, string> = {};
  const rawEnv = scenario["env"];
  if (rawEnv !== undefined && rawEnv !== null) {
    for (const [key, value] of Object.entries(asBag(rawEnv, "env"))) {
      env[key] = asString(value, `env.${key}`);
    }
  }

  const sessionName =
    optionalString(scenario, "session") ?? `scn-${suggestName(argv, shell).slice(0, 20)}`;
  const startedAtMs = Date.now();
  const steps: StepResult[] = [];

  const ttl = optionalString(scenario, "ttl");
  const meta = await startSession({
    name: sessionName,
    argv,
    ...(shell ? { shell } : {}),
    cwd: resolvePath(baseDir, optionalString(scenario, "cwd") ?? "."),
    cols: size.cols,
    rows: size.rows,
    env,
    ...(ttl === undefined ? {} : { ttlMs: resolveTtlMs(ttl) }),
  });

  let failed = false;
  try {
    const recordInterval = optionalString(scenario, "record");
    if (recordInterval !== undefined) {
      await startWatcher(meta.name, {
        intervalMs: parseDuration(recordInterval, 500),
        stopOnExit: true,
      });
    }

    const settle = parseDuration(optionalString(scenario, "settle"), 400);
    if (settle > 0) await sleep(settle);

    const rawSteps = scenario["steps"];
    const stepList = Array.isArray(rawSteps) ? rawSteps : [];

    for (let index = 0; index < stepList.length; index += 1) {
      if (failed) break;
      const step = asBag(stepList[index], `steps[${index}]`);
      const action = Object.keys(step)[0] ?? "";
      const stepStart = Date.now();
      try {
        const detail = await runStep(meta.name, action, step[action], {
          outDir,
          goldenDir,
          updateGolden: options.updateGolden ?? false,
        });
        steps.push({
          index,
          action,
          ok: true,
          detail,
          durationMs: Date.now() - stepStart,
        });
      } catch (error) {
        failed = true;
        steps.push({
          index,
          action,
          ok: false,
          detail: (error as Error).message,
          durationMs: Date.now() - stepStart,
        });
      }
    }
  } finally {
    /* A malformed scenario throws outside the per-step catch, and a session left behind by a
       crashed run is exactly the leak this tool must not create. */
    if (!options.keepSession) {
      await stopWatcher(meta.name).catch(() => false);
      await stopSession(meta.name).catch(() => undefined);
    }
  }

  const report: ScenarioReport = {
    name,
    ok: !failed,
    session: meta.name,
    startedAt: new Date(startedAtMs).toISOString(),
    durationMs: Date.now() - startedAtMs,
    steps,
    outDir,
  };
  await writeJson(join(outDir, "report.json"), report);
  return report;
}

/** Per-run state the individual steps need. */
interface StepContext {
  /** Where to write artifacts. */
  outDir: string;
  /** Where the golden screens live. */
  goldenDir: string;
  /** Whether to rewrite goldens rather than compare against them. */
  updateGolden: boolean;
}

/**
 * Execute one step.
 *
 * @returns A one-line description of what happened, used as the step's detail.
 * @throws {Error} On a failed assertion or an unknown action; the caller records it as a failure.
 */
async function runStep(
  session: string,
  action: string,
  payload: unknown,
  context: StepContext,
): Promise<string> {
  switch (action) {
    case "wait": {
      const bag = typeof payload === "string" ? { text: payload } : asBag(payload, "wait");
      const result = await waitFor(session, {
        ...(bag["text"] !== undefined ? { text: asString(bag["text"], "wait.text") } : {}),
        ...(bag["gone"] !== undefined ? { gone: asString(bag["gone"], "wait.gone") } : {}),
        ...(optionalBoolean(bag, "exit") ? { exit: true } : {}),
        ...(bag["stable"] !== undefined
          ? { stableMs: parseDuration(asString(bag["stable"], "wait.stable"), 400) }
          : {}),
        ...(optionalBoolean(bag, "regex") ? { regex: true } : {}),
        ...(optionalBoolean(bag, "ignoreCase") ? { ignoreCase: true } : {}),
        timeoutMs: parseDuration(optionalString(bag, "timeout"), 15_000),
        intervalMs: parseDuration(optionalString(bag, "interval"), 100),
      });
      if (!result.ok) throw new Error(`wait timed out: ${result.pending.join("; ")}`);
      return `condition met in ${result.waitedMs}ms`;
    }

    case "sleep": {
      const ms = parseDuration(asString(payload, "sleep"), 0);
      await sleep(ms);
      return `slept ${ms}ms`;
    }

    case "snap": {
      const bag = typeof payload === "string" ? { label: payload } : asBag(payload ?? {}, "snap");
      const snapshot = await capture(session);
      const label = optionalString(bag, "label");
      /* Either flag asks for an image, so `||` is deliberate: `??` would let an explicit
         `png: false` suppress an explicit `image: true`. Compared against `true` to say so. */
      const wantsImage =
        optionalBoolean(bag, "png") === true || optionalBoolean(bag, "image") === true;
      const frame = await saveFrame(session, snapshot, {
        kind: "snap",
        ...(label ? { label } : {}),
        ...(wantsImage ? { image: "png" as const } : {}),
      });
      if (wantsImage && label) {
        await renderAnsiToFile(snapshot.ansi, join(context.outDir, `${label}.png`), {
          cols: snapshot.cols,
          rows: snapshot.rows,
          cursor: snapshot.cursor,
          format: "png",
        });
      }
      if (label) await Bun.write(join(context.outDir, `${label}.txt`), `${snapshot.text}\n`);
      return `frame ${frame.id}`;
    }

    case "keys": {
      const keys = Array.isArray(payload)
        ? payload.map((entry) => asString(entry, "keys entry"))
        : asString(payload, "keys").split(/\s+/).filter(Boolean);
      const sent = await sendKeys(session, keys);
      return `sent ${sent.join(" ")}`;
    }

    case "type": {
      const bag = typeof payload === "string" ? { text: payload } : asBag(payload, "type");
      const text = asString(bag["text"], "type.text");
      await sendText(session, text, {
        delayMs: parseDuration(optionalString(bag, "delay"), 0),
      });
      if (optionalBoolean(bag, "enter")) await sendKeys(session, ["Enter"]);
      return `typed ${JSON.stringify(text)}`;
    }

    case "paste": {
      const bag = typeof payload === "string" ? { text: payload } : asBag(payload, "paste");
      const file = optionalString(bag, "file");
      const text = file ? await Bun.file(file).text() : asString(bag["text"], "paste.text");
      await pasteText(session, text, {
        ...(optionalBoolean(bag, "bracketed") === false ? { bracketed: false } : {}),
      });
      if (optionalBoolean(bag, "enter")) await sendKeys(session, ["Enter"]);
      return `pasted ${text.length} characters`;
    }

    case "click": {
      const bag = asBag(payload, "click");
      const target = await resolveTargetCell(session, bag);
      const encoding = await mouseClick(
        session,
        target.x,
        target.y,
        parseButton(optionalString(bag, "button")),
        parseModifiers(optionalString(bag, "modifiers")),
        {
          ...(optionalNumber(bag, "count") !== undefined
            ? { count: optionalNumber(bag, "count") }
            : {}),
        },
      );
      return `clicked ${target.label} (${encoding})`;
    }

    case "move": {
      const bag = asBag(payload, "move");
      const target = await resolveTargetCell(session, bag);
      await mouseMove(
        session,
        target.x,
        target.y,
        parseModifiers(optionalString(bag, "modifiers")),
      );
      return `moved to ${target.label}`;
    }

    case "drag": {
      const bag = asBag(payload, "drag");
      const from = coordinatePair(bag["from"], "drag.from");
      const to = coordinatePair(bag["to"], "drag.to");
      await mouseDrag(
        session,
        from,
        to,
        parseButton(optionalString(bag, "button")),
        parseModifiers(optionalString(bag, "modifiers")),
        {
          ...(optionalNumber(bag, "steps") !== undefined
            ? { steps: optionalNumber(bag, "steps") }
            : {}),
        },
      );
      return `dragged ${from.x},${from.y} -> ${to.x},${to.y}`;
    }

    case "scroll": {
      const bag = typeof payload === "string" ? { direction: payload } : asBag(payload, "scroll");
      const direction = (optionalString(bag, "direction") ?? "down") as
        "up" | "down" | "left" | "right";
      const snapshot = await capture(session);
      const x = optionalNumber(bag, "x") ?? Math.floor(snapshot.cols / 2);
      const y = optionalNumber(bag, "y") ?? Math.floor(snapshot.rows / 2);
      await mouseScroll(
        session,
        x,
        y,
        direction,
        optionalNumber(bag, "amount") ?? 3,
        parseModifiers(optionalString(bag, "modifiers")),
      );
      return `scrolled ${direction} at ${x},${y}`;
    }

    case "resize": {
      const size = parseSize(asString(payload, "resize"), { cols: 120, rows: 32 });
      await resizeSession(session, size.cols, size.rows);
      return `resized to ${size.cols}x${size.rows}`;
    }

    case "expect": {
      const bag = typeof payload === "string" ? { text: payload } : asBag(payload, "expect");
      const snapshot = await capture(session);
      const options = {
        ...(optionalBoolean(bag, "regex") ? { regex: true } : {}),
        ...(optionalBoolean(bag, "ignoreCase") ? { ignoreCase: true } : {}),
      };
      const wanted = optionalString(bag, "text");
      if (wanted !== undefined) {
        const matches = locate(snapshot.text, wanted, options);
        if (matches.length === 0) {
          throw new Error(`expected ${JSON.stringify(wanted)} on screen:\n${snapshot.text}`);
        }
      }
      const forbidden = optionalString(bag, "notText");
      if (forbidden !== undefined) {
        const matches = locate(snapshot.text, forbidden, options);
        if (matches.length > 0) {
          throw new Error(`did not expect ${JSON.stringify(forbidden)} on screen`);
        }
      }
      return "expectation held";
    }

    case "golden": {
      const label = asString(payload, "golden");
      return compareGolden(session, label, context);
    }

    default:
      throw new UsageError(`unknown scenario step: ${action}`);
  }
}

/**
 * Compare the current screen against a stored golden, or write one.
 *
 * A missing golden is created rather than failed, so the first run of a new check records a
 * baseline instead of demanding one. On a mismatch the actual screen is written next to the golden,
 * which is what makes the difference reviewable after the fact.
 *
 * @throws {Error} If the screen differs from an existing golden.
 */
async function compareGolden(
  session: string,
  label: string,
  context: StepContext,
): Promise<string> {
  const snapshot: Snapshot = await capture(session);
  const goldenPath = join(context.goldenDir, `${label}.txt`);
  const goldenFile = Bun.file(goldenPath);

  const existed = await goldenFile.exists();
  if (context.updateGolden || !existed) {
    await ensureDir(context.goldenDir);
    await Bun.write(goldenPath, `${snapshot.text}\n`);
    /* `existed` is read before the write: afterwards the file always exists, and every run would
       report "updated" even when it had just created the golden. */
    return `${existed ? "updated" : "created"} golden ${goldenPath}`;
  }

  const expected = (await goldenFile.text()).replace(/\n$/, "");
  const difference = diffText(expected, snapshot.text);
  if (difference.identical) return `golden ${label} matches`;

  const actualPath = join(context.outDir, `${label}.actual.txt`);
  await Bun.write(actualPath, `${snapshot.text}\n`);
  throw new Error(
    `golden ${label} differs (actual written to ${actualPath}):\n${formatDiff(difference)}`,
  );
}

/** Render a report for the terminal: a PASS/FAIL headline, then one line per step. */
export function formatScenarioReport(report: ScenarioReport): string {
  const lines = [
    `${report.ok ? "PASS" : "FAIL"} ${report.name} · ${report.steps.length} steps · ${report.durationMs}ms`,
  ];
  for (const step of report.steps) {
    lines.push(
      `  ${step.ok ? "ok  " : "FAIL"} ${String(step.index).padStart(2, " ")} ${step.action}: ${step.detail}`,
    );
  }
  lines.push(`artifacts: ${report.outDir}`);
  return lines.join("\n");
}
