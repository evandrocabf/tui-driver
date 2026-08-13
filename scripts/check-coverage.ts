#!/usr/bin/env bun
/**
 * Coverage gate for CI.
 *
 * `coverageThreshold` in bunfig.toml is reported but does not change bun test's exit code
 * (bun 1.3.11), so a threshold set there would pass silently no matter how far coverage fell.
 * This reads the lcov report instead and fails the build itself.
 *
 * Run it after `bun test --coverage`.
 */

export {};

/** Where `bun test --coverage` leaves its report. */
const LCOV_PATH = "coverage/lcov.info";

/**
 * The line-coverage floor the build fails below.
 *
 * Kept under the current number (98.96%) so CI fails on a real regression rather than on noise: a
 * runner with no rasterizer and no Chrome skips those tests and legitimately covers less.
 *
 * The ~20 lines still uncovered are the ones that need a broken environment to reach: tmux absent
 * (`doctor`'s failure branch), a runtime that is not bun (the recorder's guard), a /proc entry that
 * exists for kill(0) but cannot be read, and tmux dying mid-command. Each is a real safety net, so
 * none should be deleted to make a number go up.
 */
const MIN_LINE_RATE = 0.98;

/** Line counts for one file, or for the run as a whole. */
interface Totals {
  /** Lines that could have been covered. */
  found: number;
  /** Lines that were. */
  hit: number;
}

/** Covered fraction, treating a file with no measurable lines as fully covered. */
function ratio({ found, hit }: Totals): number {
  return found === 0 ? 1 : hit / found;
}

const file = Bun.file(LCOV_PATH);
if (!(await file.exists())) {
  console.error(`no coverage report at ${LCOV_PATH} — run: bun test tests --coverage`);
  process.exit(2);
}

const totals: Totals = { found: 0, hit: 0 };
const perFile = new Map<string, Totals>();
let current = "";

/**
 * Whether a path counts toward the gate.
 *
 * Only the shipped product does. Test helpers are test infrastructure: measuring them would let a
 * well-covered helper mask a poorly-covered command, and there is no such thing as a bug in a
 * helper that its own tests would catch.
 */
function isProductCode(path: string): boolean {
  return !path.includes("tests/") && !path.includes("scripts/");
}

for (const line of (await file.text()).split("\n")) {
  if (line.startsWith("SF:")) {
    const path = line.slice(3).trim();
    current = isProductCode(path) ? path : "";
    if (current !== "") perFile.set(current, { found: 0, hit: 0 });
    continue;
  }
  const entry = perFile.get(current);
  if (!entry) continue;
  if (line.startsWith("LF:")) {
    const value = Number(line.slice(3));
    entry.found += value;
    totals.found += value;
  } else if (line.startsWith("LH:")) {
    const value = Number(line.slice(3));
    entry.hit += value;
    totals.hit += value;
  }
}

if (totals.found === 0) {
  console.error(`${LCOV_PATH} contained no line records`);
  process.exit(2);
}

const rate = ratio(totals);
/** Format a coverage ratio for display. */
const asPercent = (value: number): string => `${(value * 100).toFixed(2)}%`;

if (rate < MIN_LINE_RATE) {
  console.error(`line coverage ${asPercent(rate)} is below the ${asPercent(MIN_LINE_RATE)} floor`);
  const worst = [...perFile.entries()]
    .filter(([, entry]) => entry.found > 0)
    .sort((a, b) => ratio(a[1]) - ratio(b[1]))
    .slice(0, 5);
  for (const [path, entry] of worst) {
    console.error(`  ${asPercent(ratio(entry))}  ${path}`);
  }
  process.exit(1);
}

console.log(`line coverage ${asPercent(rate)} (floor ${asPercent(MIN_LINE_RATE)})`);
