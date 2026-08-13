import { describe, expect, test } from "bun:test";

import { UsageError } from "../../src/errors.js";
import { buildMatcher, locate, pickMatch } from "../../src/locate.js";

const SCREEN = ["  Dashboard", "  Settings", "  Reports", "  Reports again"].join("\n");

describe("locate", () => {
  test("returns the first match with column, width and centre", () => {
    const [match] = locate(SCREEN, "Reports");
    expect(match).toEqual({
      row: 2,
      col: 2,
      width: 7,
      text: "Reports",
      /* centre of a 7-cell label starting at column 2 */
      centerCol: 5,
    });
  });

  test("stops at the first match unless all or nth is given", () => {
    expect(locate(SCREEN, "Reports")).toHaveLength(1);
    expect(locate(SCREEN, "Reports", { all: true })).toHaveLength(2);
  });

  test("escapes the pattern unless regex is requested", () => {
    expect(locate("a.b acb", ".")).toHaveLength(1);
    expect(locate("a.b acb", ".", { regex: true, all: true }).length).toBeGreaterThan(1);
  });

  test("supports regex and case-insensitive matching", () => {
    expect(locate(SCREEN, "^\\s+Set", { regex: true })).toHaveLength(1);
    expect(locate(SCREEN, "reports")).toHaveLength(0);
    expect(locate(SCREEN, "reports", { ignoreCase: true })).toHaveLength(1);
  });

  test("measures columns in display cells, not code units", () => {
    /* Three double-width glyphs plus a space occupy seven cells before "OK". */
    const [match] = locate("日本語 OK", "OK");
    expect(match?.col).toBe(7);
    expect(match?.width).toBe(2);
  });

  test("returns nothing when there is no match", () => {
    expect(locate(SCREEN, "Nowhere", { all: true })).toEqual([]);
  });

  test("does not loop forever on a zero-width match", () => {
    expect(locate("abc", "x*", { regex: true, all: true }).length).toBeGreaterThan(0);
  });
});

describe("buildMatcher", () => {
  test("rejects an invalid regex with a usage error", () => {
    expect(() => buildMatcher("[", { regex: true })).toThrow(UsageError);
    expect(() => buildMatcher("[", { regex: true })).toThrow(/invalid regex/);
  });
});

describe("pickMatch", () => {
  const matches = locate(SCREEN, "e", { all: true });

  test("defaults to the first match", () => {
    expect(pickMatch(matches, undefined)).toBe(matches[0]);
  });

  test("counts negative indexes back from the end", () => {
    expect(pickMatch(matches, -1)).toBe(matches[matches.length - 1]);
  });

  test("returns undefined for an empty set or an out-of-range index", () => {
    expect(pickMatch([], 0)).toBeUndefined();
    expect(pickMatch(matches, 999)).toBeUndefined();
  });
});
