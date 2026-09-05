/**
 * Scenarios: a repeatable script of steps against a TUI, and the "tester" half of the tool.
 *
 * A scenario declares the program to launch, the size to launch it at, and a list of steps. The
 * whole run is a single session that is always stopped at the end — including when the run ends
 * badly — so a failing test never leaves a process tree behind.
 */

import { dirname, join, resolve as resolvePath } from "node:path";

import { defaultStyle, stringWidth, type CellColor, type CellStyle } from "./ansi.js";
import { capture, type Snapshot } from "./capture.js";
import { diffText, formatDiff } from "./diff.js";
import { UsageError } from "./errors.js";
import { saveFrame } from "./frames.js";
import {
  mouseClick,
  mouseDrag,
  mouseMove,
  mouseScroll,
  parseMouseEncoding,
  pasteText,
  sendFocus,
  sendKittyKeyEvent,
  sendKeys,
  sendRawBytes,
  sendText,
} from "./input.js";
import { resolveTtlMs } from "./lifetime.js";
import { locate, pickMatch } from "./locate.js";
import { parseButton, parseModifiers } from "./mouse.js";
import { renderAnsiToFile } from "./render.js";
import { resizeSession, startSession, stopSession, suggestName } from "./session.js";
import { ensureDir, parseDuration, parseSize, sleep, writeJson, writePrivateFile } from "./util.js";
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
  /** Diagnostic files captured when this step failed. */
  artifacts?: string[];
}

/**
 * The outcome of a whole run, also written to `report.json` in the artifact directory.
 *
 * Written whether the run passed or failed — the failing case is the one worth having on disk.
 */
export interface ScenarioReport {
  schemaVersion: 1;
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
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new UsageError(`${key} must be a boolean`);
  return value;
}

/**
 * Read an `{x, y}` pair from a step's payload.
 *
 * @throws {UsageError} If either coordinate is missing or not a number.
 */
function coordinatePair(value: unknown, context: string): { x: number; y: number } {
  let x: number;
  let y: number;
  if (Array.isArray(value) && value.length === 2) {
    x = Number(value[0]);
    y = Number(value[1]);
  } else {
    const bag = asBag(value, context);
    if (bag["x"] === undefined || bag["y"] === undefined) {
      throw new UsageError(`${context} needs x and y`);
    }
    x = Number(bag["x"]);
    y = Number(bag["y"]);
  }
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    throw new UsageError(`${context} coordinates must be non-negative integers`);
  }
  return { x, y };
}

function assertOnlyKeys(bag: Bag, allowed: readonly string[], context: string): void {
  const unknown = Object.keys(bag).filter((key) => !allowed.includes(key));
  if (unknown.length > 0)
    throw new UsageError(`${context} has unknown field: ${unknown.join(", ")}`);
}

const TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "name",
  "session",
  "command",
  "shell",
  "cwd",
  "size",
  "env",
  "ttl",
  "settle",
  "record",
  "goldenDir",
  "masks",
  "steps",
] as const;

const STEP_ACTIONS = new Set([
  "wait",
  "sleep",
  "snap",
  "keys",
  "bytes",
  "focus",
  "keyEvent",
  "type",
  "paste",
  "click",
  "move",
  "drag",
  "scroll",
  "resize",
  "expect",
  "golden",
]);

interface MaskRule {
  pattern: string;
  replacement: string;
  regex: boolean;
}

function parseMasks(value: unknown): MaskRule[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new UsageError("masks must be a list");
  return value.map((entry, index) => {
    if (typeof entry === "string") return { pattern: entry, replacement: "<masked>", regex: false };
    const bag = asBag(entry, `masks[${index}]`);
    assertOnlyKeys(bag, ["pattern", "replacement", "regex"], `masks[${index}]`);
    return {
      pattern: asString(bag["pattern"], `masks[${index}].pattern`),
      replacement: optionalString(bag, "replacement") ?? "<masked>",
      regex: optionalBoolean(bag, "regex") ?? false,
    };
  });
}

function applyMasks(input: string, rules: readonly MaskRule[]): string {
  let output = input;
  for (const rule of rules) {
    output = rule.regex
      ? output.replace(new RegExp(rule.pattern, "gu"), rule.replacement)
      : output.replaceAll(rule.pattern, rule.replacement);
  }
  return output;
}

function cellAt(snapshot: Snapshot, x: number, y: number): { text: string; style: CellStyle } {
  assertCellBounds(snapshot, x, y);
  const row = snapshot.grid.lines[y];
  for (const run of row?.runs ?? []) {
    if (x < run.col || x >= run.col + run.width) continue;
    let column = run.col;
    for (const character of run.text) {
      const width = stringWidth(character);
      if (x >= column && x < column + Math.max(1, width)) {
        return { text: character, style: run.style };
      }
      column += width;
    }
    return { text: " ", style: run.style };
  }
  return { text: " ", style: defaultStyle() };
}

function colorDescription(color: CellColor): string | number {
  if (color.kind === "default") return "default";
  if (color.kind === "index") return color.index;
  return `#${[color.rgb.r, color.rgb.g, color.rgb.b]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("")}`;
}

function sliceCells(line: string, start: number, width: number): string {
  let column = 0;
  let result = "";
  for (const character of line) {
    const cellWidth = stringWidth(character);
    if (column + cellWidth > start && column < start + width) result += character;
    column += cellWidth;
    if (column >= start + width) break;
  }
  return result;
}

function assertStructuredExpectations(snapshot: Snapshot, bag: Bag): void {
  if (bag["cursor"] !== undefined) {
    let expectedX: number | undefined;
    let expectedY: number | undefined;
    let expectedVisible: boolean | undefined;
    if (Array.isArray(bag["cursor"])) {
      const cursor = coordinatePair(bag["cursor"], "expect.cursor");
      expectedX = cursor.x;
      expectedY = cursor.y;
    } else {
      const cursor = asBag(bag["cursor"], "expect.cursor");
      assertOnlyKeys(cursor, ["x", "y", "visible"], "expect.cursor");
      expectedX = optionalNumber(cursor, "x");
      expectedY = optionalNumber(cursor, "y");
      expectedVisible = optionalBoolean(cursor, "visible");
    }
    if (expectedX !== undefined && snapshot.cursor.x !== expectedX) {
      throw new Error(`expected cursor x=${expectedX}, found ${snapshot.cursor.x}`);
    }
    if (expectedY !== undefined && snapshot.cursor.y !== expectedY) {
      throw new Error(`expected cursor y=${expectedY}, found ${snapshot.cursor.y}`);
    }
    if (expectedVisible !== undefined && snapshot.cursor.visible !== expectedVisible) {
      throw new Error(
        `expected cursor visible=${expectedVisible}, found ${snapshot.cursor.visible}`,
      );
    }
  }

  if (bag["cell"] !== undefined) {
    const expected = asBag(bag["cell"], "expect.cell");
    assertOnlyKeys(
      expected,
      [
        "x",
        "y",
        "text",
        "fg",
        "bg",
        "bold",
        "dim",
        "italic",
        "underline",
        "reverse",
        "hidden",
        "strike",
      ],
      "expect.cell",
    );
    const x = optionalNumber(expected, "x");
    const y = optionalNumber(expected, "y");
    if (x === undefined || y === undefined) throw new UsageError("expect.cell needs x and y");
    const actual = cellAt(snapshot, x, y);
    const expectedText = optionalString(expected, "text");
    if (expectedText !== undefined && actual.text !== expectedText) {
      throw new Error(
        `expected cell ${x},${y} text ${JSON.stringify(expectedText)}, found ${JSON.stringify(actual.text)}`,
      );
    }
    for (const name of [
      "bold",
      "dim",
      "italic",
      "underline",
      "reverse",
      "hidden",
      "strike",
    ] as const) {
      const value = optionalBoolean(expected, name);
      if (value !== undefined && actual.style[name] !== value) {
        throw new Error(`expected cell ${x},${y} ${name}=${value}, found ${actual.style[name]}`);
      }
    }
    for (const name of ["fg", "bg"] as const) {
      if (expected[name] === undefined) continue;
      const wanted = asString(expected[name], `expect.cell.${name}`).toLowerCase();
      const found = String(colorDescription(actual.style[name])).toLowerCase();
      if (wanted !== found)
        throw new Error(`expected cell ${x},${y} ${name}=${wanted}, found ${found}`);
    }
  }

  if (bag["region"] !== undefined) {
    const region = asBag(bag["region"], "expect.region");
    assertOnlyKeys(region, ["x", "y", "width", "height", "text"], "expect.region");
    const x = optionalNumber(region, "x");
    const y = optionalNumber(region, "y");
    const width = optionalNumber(region, "width");
    const height = optionalNumber(region, "height");
    if ([x, y, width, height].some((value) => value === undefined)) {
      throw new UsageError("expect.region needs x, y, width and height");
    }
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      (width ?? 0) < 1 ||
      (height ?? 0) < 1
    ) {
      throw new UsageError("expect.region width and height must be positive integers");
    }
    assertCellBounds(snapshot, x ?? 0, y ?? 0);
    if ((x ?? 0) + (width ?? 0) > snapshot.cols || (y ?? 0) + (height ?? 0) > snapshot.rows) {
      throw new UsageError("expect.region extends outside the screen");
    }
    const lines = snapshot.text.split("\n");
    const actual = Array.from({ length: height ?? 0 }, (_, offset) =>
      sliceCells(lines[(y ?? 0) + offset] ?? "", x ?? 0, width ?? 0),
    ).join("\n");
    const wanted = asString(region["text"], "expect.region.text");
    if (actual !== wanted) {
      throw new Error(
        `expected region text ${JSON.stringify(wanted)}, found ${JSON.stringify(actual)}`,
      );
    }
  }
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
): Promise<{ x: number; y: number; label: string; stateHash: string }> {
  const pattern = optionalString(bag, "text");
  if (pattern === undefined) {
    const x = optionalNumber(bag, "x");
    const y = optionalNumber(bag, "y");
    if (x === undefined || y === undefined) throw new UsageError("click needs x/y or text");
    const snapshot = await capture(session);
    assertCellBounds(snapshot, x, y);
    return { x, y, label: `${x},${y}`, stateHash: snapshot.stateHash };
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
  assertCellBounds(snapshot, x, match.row);
  return {
    x,
    y: match.row,
    label: `${JSON.stringify(pattern)} at ${x},${match.row}`,
    stateHash: snapshot.stateHash,
  };
}

function assertCellBounds(snapshot: Snapshot, x: number, y: number): void {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) {
    throw new UsageError(`coordinates must be non-negative integers, got ${x},${y}`);
  }
  if (x >= snapshot.cols || y >= snapshot.rows) {
    throw new UsageError(`coordinate ${x},${y} is outside ${snapshot.cols}x${snapshot.rows}`);
  }
}

async function scenarioMouseOptions(session: string, bag: Bag, stateHash: string) {
  const snapshot = await capture(session);
  if (snapshot.stateHash !== stateHash) {
    throw new Error(`screen changed before mouse action (${stateHash} -> ${snapshot.stateHash})`);
  }
  return {
    modes: snapshot.mouse,
    ...(parseMouseEncoding(optionalString(bag, "encoding"))
      ? { encoding: parseMouseEncoding(optionalString(bag, "encoding")) }
      : {}),
    ...(optionalBoolean(bag, "force") ? { force: true } : {}),
  };
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
  assertOnlyKeys(scenario, TOP_LEVEL_FIELDS, "scenario");
  const schemaVersion = scenario["schemaVersion"] ?? 1;
  if (schemaVersion !== 1) {
    throw new UsageError(`unsupported scenario schemaVersion: ${JSON.stringify(schemaVersion)}`);
  }
  const rawSteps = scenario["steps"];
  if (!Array.isArray(rawSteps)) throw new UsageError("steps must be a list");
  const stepList = rawSteps.map((value, index) => {
    const step = asBag(value, `steps[${index}]`);
    const actions = Object.keys(step);
    if (actions.length !== 1)
      throw new UsageError(`steps[${index}] must contain exactly one action`);
    const action = actions[0] ?? "";
    if (!STEP_ACTIONS.has(action)) throw new UsageError(`unknown scenario step: ${action}`);
    return step;
  });
  const baseDir = dirname(path);
  const name = optionalString(scenario, "name") ?? "scenario";
  const outDir = options.outDir ?? join(baseDir, ".tui-artifacts", name.replace(/[^\w.-]+/g, "-"));
  const goldenDir = resolvePath(baseDir, optionalString(scenario, "goldenDir") ?? "golden");
  const masks = parseMasks(scenario["masks"]);
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
          baseDir,
          masks,
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
        const artifacts = await writeFailureArtifacts(meta.name, index, outDir).catch(() => []);
        steps.push({
          index,
          action,
          ok: false,
          detail: (error as Error).message,
          durationMs: Date.now() - stepStart,
          ...(artifacts.length > 0 ? { artifacts } : {}),
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
    schemaVersion: 1,
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
  /** Directory scenario-relative file references resolve against. */
  baseDir: string;
  /** Normalisation rules applied before golden comparison. */
  masks: MaskRule[];
}

async function writeFailureArtifacts(
  session: string,
  index: number,
  outDir: string,
): Promise<string[]> {
  const snapshot = await capture(session);
  const stem = join(outDir, `failure-step-${index}`);
  const paths = [`${stem}.txt`, `${stem}.ansi`, `${stem}.json`, `${stem}.svg`];
  await writePrivateFile(paths[0] ?? "", `${snapshot.text}\n`);
  await writePrivateFile(paths[1] ?? "", snapshot.ansi);
  await writePrivateFile(paths[2] ?? "", `${JSON.stringify(snapshot, null, 2)}\n`);
  await renderAnsiToFile(snapshot.ansi, paths[3] ?? "", {
    cols: snapshot.cols,
    rows: snapshot.rows,
    cursor: snapshot.cursor,
    format: "svg",
    title: `${session} failed at step ${index}`,
  });
  return paths;
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
      assertOnlyKeys(
        bag,
        ["text", "gone", "exit", "stable", "regex", "ignoreCase", "timeout", "interval"],
        "wait",
      );
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
      assertOnlyKeys(bag, ["label", "png", "svg", "image"], "snap");
      const snapshot = await capture(session);
      const label = optionalString(bag, "label");
      /* Either flag asks for an image, so `||` is deliberate: `??` would let an explicit
         `png: false` suppress an explicit `image: true`. Compared against `true` to say so. */
      const image = optionalBoolean(bag, "svg")
        ? ("svg" as const)
        : optionalBoolean(bag, "png") === true || optionalBoolean(bag, "image") === true
          ? ("png" as const)
          : undefined;
      const frame = await saveFrame(session, snapshot, {
        kind: "snap",
        ...(label ? { label } : {}),
        ...(image ? { image } : {}),
      });
      if (image && label) {
        await renderAnsiToFile(snapshot.ansi, join(context.outDir, `${label}.${image}`), {
          cols: snapshot.cols,
          rows: snapshot.rows,
          cursor: snapshot.cursor,
          format: image,
        });
      }
      if (label) {
        await writePrivateFile(join(context.outDir, `${label}.txt`), `${snapshot.text}\n`);
      }
      return `frame ${frame.id}`;
    }

    case "keys": {
      const keys = Array.isArray(payload)
        ? payload.map((entry) => asString(entry, "keys entry"))
        : asString(payload, "keys").split(/\s+/).filter(Boolean);
      const sent = await sendKeys(session, keys);
      return `sent ${sent.join(" ")}`;
    }

    case "bytes": {
      const bag = asBag(payload, "bytes");
      assertOnlyKeys(bag, ["hex", "base64", "file"], "bytes");
      const sourceCount = ["hex", "base64", "file"].filter((key) => bag[key] !== undefined).length;
      if (sourceCount !== 1) throw new UsageError("bytes needs exactly one of hex, base64 or file");
      let bytes: number[];
      if (bag["hex"] !== undefined) {
        const compact = asString(bag["hex"], "bytes.hex").replace(/[\s,:_-]+/g, "");
        if (compact === "" || compact.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(compact)) {
          throw new UsageError("bytes.hex expects complete hexadecimal byte pairs");
        }
        bytes = compact.match(/../g)?.map((part) => Number.parseInt(part, 16)) ?? [];
      } else if (bag["base64"] !== undefined) {
        bytes = [...Buffer.from(asString(bag["base64"], "bytes.base64"), "base64")];
      } else {
        const file = resolvePath(context.baseDir, asString(bag["file"], "bytes.file"));
        bytes = [...new Uint8Array(await Bun.file(file).arrayBuffer())];
      }
      await sendRawBytes(session, [bytes]);
      return `sent ${bytes.length} raw bytes`;
    }

    case "focus": {
      const value = asString(payload, "focus").toLowerCase();
      if (value !== "in" && value !== "out") throw new UsageError("focus must be in or out");
      await sendFocus(session, value === "in");
      return `sent focus-${value}`;
    }

    case "keyEvent": {
      const bag = asBag(payload, "keyEvent");
      assertOnlyKeys(bag, ["codePoint", "character", "event", "modifiers"], "keyEvent");
      const character = optionalString(bag, "character");
      const numeric = optionalNumber(bag, "codePoint");
      if ((character === undefined) === (numeric === undefined)) {
        throw new UsageError("keyEvent needs exactly one of character or codePoint");
      }
      const characters = character === undefined ? [] : [...character];
      if (character !== undefined && characters.length !== 1) {
        throw new UsageError("keyEvent.character must contain one character");
      }
      const codePoint = numeric ?? characters[0]?.codePointAt(0) ?? 0;
      const event = optionalString(bag, "event") ?? "press";
      if (event !== "press" && event !== "repeat" && event !== "release") {
        throw new UsageError("keyEvent.event must be press, repeat or release");
      }
      const rawModifiers = bag["modifiers"];
      const modifiers =
        rawModifiers === undefined
          ? []
          : Array.isArray(rawModifiers)
            ? rawModifiers.map((entry) => asString(entry, "keyEvent.modifiers entry"))
            : asString(rawModifiers, "keyEvent.modifiers")
                .split(/[,+\s]+/)
                .filter(Boolean);
      await sendKittyKeyEvent(session, codePoint, modifiers, event);
      return `sent Kitty ${event} for U+${codePoint.toString(16).toUpperCase()}`;
    }

    case "type": {
      const bag = typeof payload === "string" ? { text: payload } : asBag(payload, "type");
      assertOnlyKeys(bag, ["text", "delay", "enter"], "type");
      const text = asString(bag["text"], "type.text");
      await sendText(session, text, {
        delayMs: parseDuration(optionalString(bag, "delay"), 0),
      });
      if (optionalBoolean(bag, "enter")) await sendKeys(session, ["Enter"]);
      return `typed ${JSON.stringify(text)}`;
    }

    case "paste": {
      const bag = typeof payload === "string" ? { text: payload } : asBag(payload, "paste");
      assertOnlyKeys(bag, ["text", "file", "bracketed", "enter"], "paste");
      const file = optionalString(bag, "file");
      const text = file
        ? await Bun.file(resolvePath(context.baseDir, file)).text()
        : asString(bag["text"], "paste.text");
      await pasteText(session, text, {
        ...(optionalBoolean(bag, "bracketed") === false ? { bracketed: false } : {}),
      });
      if (optionalBoolean(bag, "enter")) await sendKeys(session, ["Enter"]);
      return `pasted ${text.length} characters`;
    }

    case "click": {
      const bag = asBag(payload, "click");
      assertOnlyKeys(
        bag,
        [
          "x",
          "y",
          "text",
          "regex",
          "ignoreCase",
          "nth",
          "at",
          "button",
          "modifiers",
          "count",
          "encoding",
          "force",
        ],
        "click",
      );
      const target = await resolveTargetCell(session, bag);
      const mouseOptions = await scenarioMouseOptions(session, bag, target.stateHash);
      const encoding = await mouseClick(
        session,
        target.x,
        target.y,
        parseButton(optionalString(bag, "button")),
        parseModifiers(optionalString(bag, "modifiers")),
        {
          ...mouseOptions,
          ...(optionalNumber(bag, "count") !== undefined
            ? { count: optionalNumber(bag, "count") }
            : {}),
        },
      );
      return `clicked ${target.label} (${encoding})`;
    }

    case "move": {
      const bag = asBag(payload, "move");
      assertOnlyKeys(
        bag,
        [
          "x",
          "y",
          "text",
          "regex",
          "ignoreCase",
          "nth",
          "at",
          "button",
          "modifiers",
          "encoding",
          "force",
        ],
        "move",
      );
      const target = await resolveTargetCell(session, bag);
      const mouseOptions = await scenarioMouseOptions(session, bag, target.stateHash);
      await mouseMove(
        session,
        target.x,
        target.y,
        parseModifiers(optionalString(bag, "modifiers")),
        {
          ...mouseOptions,
          ...(optionalString(bag, "button")
            ? { button: parseButton(optionalString(bag, "button")) }
            : {}),
        },
      );
      return `moved to ${target.label}`;
    }

    case "drag": {
      const bag = asBag(payload, "drag");
      assertOnlyKeys(
        bag,
        ["from", "to", "button", "modifiers", "steps", "encoding", "force"],
        "drag",
      );
      const from = coordinatePair(bag["from"], "drag.from");
      const to = coordinatePair(bag["to"], "drag.to");
      const snapshot = await capture(session);
      assertCellBounds(snapshot, from.x, from.y);
      assertCellBounds(snapshot, to.x, to.y);
      const mouseOptions = await scenarioMouseOptions(session, bag, snapshot.stateHash);
      await mouseDrag(
        session,
        from,
        to,
        parseButton(optionalString(bag, "button")),
        parseModifiers(optionalString(bag, "modifiers")),
        {
          ...mouseOptions,
          ...(optionalNumber(bag, "steps") !== undefined
            ? { steps: optionalNumber(bag, "steps") }
            : {}),
        },
      );
      return `dragged ${from.x},${from.y} -> ${to.x},${to.y}`;
    }

    case "scroll": {
      const bag = typeof payload === "string" ? { direction: payload } : asBag(payload, "scroll");
      assertOnlyKeys(
        bag,
        ["direction", "x", "y", "amount", "modifiers", "encoding", "force"],
        "scroll",
      );
      const direction = optionalString(bag, "direction") ?? "down";
      if (
        direction !== "up" &&
        direction !== "down" &&
        direction !== "left" &&
        direction !== "right"
      ) {
        throw new UsageError("scroll.direction must be up, down, left or right");
      }
      const snapshot = await capture(session);
      const x = optionalNumber(bag, "x") ?? Math.floor(snapshot.cols / 2);
      const y = optionalNumber(bag, "y") ?? Math.floor(snapshot.rows / 2);
      assertCellBounds(snapshot, x, y);
      const mouseOptions = await scenarioMouseOptions(session, bag, snapshot.stateHash);
      await mouseScroll(
        session,
        x,
        y,
        direction,
        optionalNumber(bag, "amount") ?? 3,
        parseModifiers(optionalString(bag, "modifiers")),
        mouseOptions,
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
      assertOnlyKeys(
        bag,
        ["text", "notText", "regex", "ignoreCase", "count", "cursor", "cell", "region"],
        "expect",
      );
      const snapshot = await capture(session);
      const options = {
        ...(optionalBoolean(bag, "regex") ? { regex: true } : {}),
        ...(optionalBoolean(bag, "ignoreCase") ? { ignoreCase: true } : {}),
      };
      const wanted = optionalString(bag, "text");
      if (wanted !== undefined) {
        const matches = locate(snapshot.text, wanted, options);
        const count = optionalNumber(bag, "count");
        if (count !== undefined && matches.length !== count) {
          throw new Error(
            `expected ${count} matches for ${JSON.stringify(wanted)}, found ${matches.length}`,
          );
        }
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
      if (wanted === undefined && bag["count"] !== undefined) {
        throw new UsageError("expect.count requires expect.text");
      }
      assertStructuredExpectations(snapshot, bag);
      return "expectation held";
    }

    case "golden": {
      const bag = typeof payload === "string" ? { label: payload } : asBag(payload, "golden");
      assertOnlyKeys(bag, ["label", "format"], "golden");
      return compareGolden(
        session,
        asString(bag["label"], "golden.label"),
        context,
        optionalString(bag, "format"),
      );
    }

    default:
      throw new UsageError(`unknown scenario step: ${action}`);
  }
}

/**
 * Compare the current screen against a stored golden, or write one in explicit update mode.
 * A missing baseline fails so CI can never approve a screen nobody reviewed.
 *
 * @throws {Error} If the screen differs from an existing golden.
 */
async function compareGolden(
  session: string,
  label: string,
  context: StepContext,
  requestedFormat?: string,
): Promise<string> {
  const snapshot: Snapshot = await capture(session);
  const format = requestedFormat ?? "text";
  if (format !== "text" && format !== "ansi" && format !== "state") {
    throw new UsageError("golden.format must be text, ansi or state");
  }
  const extension = format === "text" ? "txt" : format === "ansi" ? "ansi" : "json";
  const goldenPath = join(context.goldenDir, `${label}.${extension}`);
  const goldenFile = Bun.file(goldenPath);
  const rawActual =
    format === "text"
      ? snapshot.text
      : format === "ansi"
        ? snapshot.ansi
        : JSON.stringify(
            {
              cols: snapshot.cols,
              rows: snapshot.rows,
              cursor: snapshot.cursor,
              alternateScreen: snapshot.alternateScreen,
              mouse: snapshot.mouse,
              grid: snapshot.grid,
            },
            null,
            2,
          );
  const actual = applyMasks(rawActual, context.masks);

  const existed = await goldenFile.exists();
  if (!existed && !context.updateGolden) {
    throw new Error(`golden ${label} is missing; create it with --update-golden`);
  }
  if (context.updateGolden) {
    await ensureDir(context.goldenDir);
    await writePrivateFile(goldenPath, `${actual}\n`);
    return `${existed ? "updated" : "created"} golden ${goldenPath}`;
  }

  const expected = (await goldenFile.text()).replace(/\n$/, "");
  const difference = diffText(expected, actual);
  if (difference.identical) return `golden ${label} matches`;

  const actualPath = join(context.outDir, `${label}.actual.${extension}`);
  await writePrivateFile(actualPath, `${actual}\n`);
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
