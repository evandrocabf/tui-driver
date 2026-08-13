import { describe, expect, test } from "bun:test";

import { diffText, formatDiff } from "../../src/diff.js";

describe("diffText", () => {
  test("reports identical screens", () => {
    const result = diffText("a\nb", "a\nb");
    expect(result.identical).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.totalRows).toBe(2);
  });

  test("records the row, before and after of every change", () => {
    const result = diffText("a\nb\nc", "a\nB\nc");
    expect(result.identical).toBe(false);
    expect(result.changed).toEqual([{ row: 1, before: "b", after: "B" }]);
  });

  test("pads the shorter screen with empty rows", () => {
    const result = diffText("a", "a\nb");
    expect(result.totalRows).toBe(2);
    expect(result.changed).toEqual([{ row: 1, before: "", after: "b" }]);
  });
});

describe("formatDiff", () => {
  test("summarises an identical pair", () => {
    expect(formatDiff(diffText("x", "x"))).toBe("screens are identical");
  });

  test("prints a unified-style block and a tally", () => {
    const rendered = formatDiff(diffText("a\nb", "a\nB"));
    expect(rendered).toContain("@ row 1");
    expect(rendered).toContain("- b");
    expect(rendered).toContain("+ B");
    expect(rendered).toContain("1 of 2 rows differ");
  });
});
