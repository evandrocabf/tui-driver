import { describe, expect, test } from "bun:test";

import { normalizeKey } from "../../src/input.js";
import { locate, pickMatch } from "../../src/locate.js";
import { diffText, formatDiff } from "../../src/diff.js";
import { formatElapsed, parseDuration, parseSize, shellQuote, stampFor } from "../../src/util.js";
import { parseArgs } from "../../src/args.js";

describe("parseDuration", () => {
  test("accepts unit suffixes", () => {
    expect(parseDuration("250ms", 0)).toBe(250);
    expect(parseDuration("2s", 0)).toBe(2000);
    expect(parseDuration("1.5s", 0)).toBe(1500);
    expect(parseDuration("2m", 0)).toBe(120_000);
  });

  test("treats bare numbers as milliseconds and falls back when absent", () => {
    expect(parseDuration("500", 0)).toBe(500);
    expect(parseDuration(undefined, 400)).toBe(400);
  });

  test("rejects nonsense", () => {
    expect(() => parseDuration("soon", 0)).toThrow();
  });
});

describe("formatElapsed", () => {
  test("switches unit with the magnitude", () => {
    expect(formatElapsed(250)).toBe("250ms");
    expect(formatElapsed(2500)).toBe("2.5s");
    expect(formatElapsed(90_000)).toBe("1m30s");
  });

  test("carries rounded seconds into the minute", () => {
    expect(formatElapsed(1_499_600)).toBe("25m00s");
  });
});

describe("parseSize", () => {
  test("parses COLSxROWS", () => {
    expect(parseSize("120x32", { cols: 1, rows: 1 })).toEqual({ cols: 120, rows: 32 });
  });

  test("rejects out of range and malformed sizes", () => {
    expect(() => parseSize("5x5", { cols: 1, rows: 1 })).toThrow();
    expect(() => parseSize("wide", { cols: 1, rows: 1 })).toThrow();
  });
});

describe("shellQuote", () => {
  test("leaves safe words alone and quotes the rest", () => {
    expect(shellQuote(["vim", "src/a.ts"])).toBe("vim src/a.ts");
    expect(shellQuote(["echo", "hello world"])).toBe("echo 'hello world'");
    expect(shellQuote(["echo", "it's"])).toBe(`echo 'it'\\''s'`);
  });
});

describe("stampFor", () => {
  test("produces a sortable filesystem-safe id", () => {
    expect(stampFor(new Date("2026-08-09T23:59:59.123Z"))).toBe("20260809T235959123");
  });
});

describe("normalizeKey", () => {
  test("maps friendly names to tmux key names", () => {
    expect(normalizeKey("esc")).toBe("Escape");
    expect(normalizeKey("enter")).toBe("Enter");
    expect(normalizeKey("pgdn")).toBe("NPage");
    expect(normalizeKey("f5")).toBe("F5");
  });

  test("maps modifier spellings", () => {
    expect(normalizeKey("ctrl+c")).toBe("C-c");
    expect(normalizeKey("ctrl-c")).toBe("C-c");
    expect(normalizeKey("^c")).toBe("C-c");
    expect(normalizeKey("alt+Left")).toBe("M-Left");
    expect(normalizeKey("C-c")).toBe("C-c");
  });

  test("passes single characters through untouched", () => {
    expect(normalizeKey("q")).toBe("q");
    expect(normalizeKey("M")).toBe("M");
  });
});

describe("locate", () => {
  const screen = ["  Dashboard", "  Settings", "  Dashboard again"].join("\n");

  test("finds the first match with display coordinates", () => {
    const [match] = locate(screen, "Settings");
    expect(match).toMatchObject({ row: 1, col: 2, width: 8 });
  });

  test("computes a clickable centre", () => {
    const [match] = locate(screen, "Quit\n") ?? [];
    expect(match).toBeUndefined();
    const [dashboard] = locate(screen, "Dashboard");
    expect(dashboard?.centerCol).toBe(2 + 4);
  });

  test("returns every match when asked", () => {
    expect(locate(screen, "Dashboard", { all: true })).toHaveLength(2);
  });

  test("supports regex and case-insensitive matching", () => {
    expect(locate(screen, "^\\s+Set", { regex: true })).toHaveLength(1);
    expect(locate(screen, "settings", { ignoreCase: true })).toHaveLength(1);
  });

  test("accounts for wide characters when reporting columns", () => {
    const [match] = locate("漢字 OK", "OK");
    expect(match?.col).toBe(5);
  });

  test("pickMatch supports negative indexes", () => {
    const matches = locate(screen, "Dashboard", { all: true });
    expect(pickMatch(matches, -1)?.row).toBe(2);
  });
});

describe("diffText", () => {
  test("reports the rows that changed", () => {
    const result = diffText("a\nb\nc", "a\nB\nc");
    expect(result.identical).toBe(false);
    expect(result.changed).toEqual([{ row: 1, before: "b", after: "B" }]);
    expect(formatDiff(result)).toContain("@ row 1");
  });

  test("detects identical screens", () => {
    expect(diffText("same", "same").identical).toBe(true);
  });
});

describe("parseArgs", () => {
  const specs = {
    name: { type: "string" as const, describe: "" },
    count: { type: "number" as const, describe: "" },
    save: { type: "boolean" as const, describe: "" },
    env: { type: "string[]" as const, describe: "" },
  };

  test("parses values, flags, negations and repeats", () => {
    const args = parseArgs(
      ["session", "--name", "demo", "--count=3", "--no-save", "--env", "A=1", "--env", "B=2"],
      specs,
    );
    expect(args.positional(0)).toBe("session");
    expect(args.string("name")).toBe("demo");
    expect(args.number("count")).toBe(3);
    expect(args.boolean("save", true)).toBe(false);
    expect(args.list("env")).toEqual(["A=1", "B=2"]);
  });

  test("splits the command after a double dash", () => {
    const args = parseArgs(["--name", "x", "--", "vim", "-u", "NONE"], specs);
    expect(args.passthrough).toEqual(["vim", "-u", "NONE"]);
  });

  test("rejects unknown options and missing values", () => {
    expect(() => parseArgs(["--nope"], specs)).toThrow();
    expect(() => parseArgs(["--name"], specs)).toThrow();
  });
});
