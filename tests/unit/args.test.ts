import { describe, expect, test } from "bun:test";

import { formatOptions, parseArgs, type OptionSpecs } from "../../src/args.js";
import { UsageError } from "../../src/errors.js";

const SPECS: OptionSpecs = {
  name: { type: "string", describe: "session name" },
  count: { type: "number", describe: "how many", alias: "c" },
  env: { type: "string[]", describe: "extra environment" },
  snap: { type: "boolean", describe: "capture afterwards" },
  save: { type: "boolean", describe: "save the frame" },
};

describe("parseArgs", () => {
  test("keeps negative frame references as positionals", () => {
    /* Regression: `tui frame app -1` used to fail with "unknown option -1". */
    for (const reference of ["-1", "-0", "-2", "-12"]) {
      const args = parseArgs(["app", reference], SPECS);
      expect(args.positionals).toEqual(["app", reference]);
    }
  });

  test("still accepts negative numbers as option values", () => {
    const args = parseArgs(["--count", "-1", "app"], SPECS);
    expect(args.number("count")).toBe(-1);
    expect(args.positionals).toEqual(["app"]);
  });

  test("treats a lone dash as a positional", () => {
    expect(parseArgs(["-"], SPECS).positionals).toEqual(["-"]);
  });

  test("parses --key value, --key=value and aliases", () => {
    expect(parseArgs(["--name", "app"], SPECS).string("name")).toBe("app");
    expect(parseArgs(["--name=app"], SPECS).string("name")).toBe("app");
    expect(parseArgs(["-c", "3"], SPECS).number("count")).toBe(3);
  });

  test("handles booleans, --no- prefixes and explicit false", () => {
    expect(parseArgs(["--snap"], SPECS).boolean("snap")).toBe(true);
    expect(parseArgs(["--no-save"], SPECS).boolean("save", true)).toBe(false);
    expect(parseArgs(["--snap=false"], SPECS).boolean("snap")).toBe(false);
    expect(parseArgs(["--snap=0"], SPECS).boolean("snap")).toBe(false);
    expect(parseArgs([], SPECS).boolean("save", true)).toBe(true);
  });

  test("collects repeatable string[] options", () => {
    const args = parseArgs(["--env", "A=1", "--env", "B=2"], SPECS);
    expect(args.list("env")).toEqual(["A=1", "B=2"]);
    expect(args.list("name")).toEqual([]);
  });

  test("splits passthrough arguments at --", () => {
    const args = parseArgs(["--name", "app", "--", "python3", "-u", "app.py"], SPECS);
    expect(args.sawPassthrough).toBe(true);
    expect(args.passthrough).toEqual(["python3", "-u", "app.py"]);
    expect(args.positionals).toEqual([]);
  });

  test("reports has() only for options that were given", () => {
    const args = parseArgs(["--name", "app"], SPECS);
    expect(args.has("name")).toBe(true);
    expect(args.has("count")).toBe(false);
  });

  test("rejects unknown options, missing values and bad numbers", () => {
    expect(() => parseArgs(["--nope"], SPECS)).toThrow(UsageError);
    expect(() => parseArgs(["--no-name"], SPECS)).toThrow(/unknown option/);
    expect(() => parseArgs(["--name"], SPECS)).toThrow(/expects a value/);
    expect(() => parseArgs(["--count", "abc"], SPECS)).toThrow(/expects a number/);
  });
});

describe("Args accessors", () => {
  test("requirePositional throws a labelled usage error", () => {
    const args = parseArgs(["app"], SPECS);
    expect(args.requirePositional(0, "session name")).toBe("app");
    expect(() => args.requirePositional(1, "search pattern")).toThrow(/missing search pattern/);
  });

  test("typed getters ignore values of the wrong type", () => {
    const args = parseArgs(["--name", "app"], SPECS);
    expect(args.number("name")).toBeUndefined();
    expect(args.string("count")).toBeUndefined();
    expect(args.positional(9)).toBeUndefined();
  });
});

describe("formatOptions", () => {
  test("renders aliases and placeholders", () => {
    const rendered = formatOptions(SPECS);
    expect(rendered).toContain("--name <value>");
    expect(rendered).toContain("-c, --count <n>");
    expect(rendered).toContain("--snap ");
    expect(formatOptions({})).toBe("");
  });
});
