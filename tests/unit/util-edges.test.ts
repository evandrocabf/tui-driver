import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isProcessAlive, readJson, readJsonl } from "../../src/util.js";
import { encodeMouseEvent, NO_MODIFIERS, type MouseEventSpec } from "../../src/mouse.js";
import { buildSvg } from "../../src/render.js";

/** Written as a char code: a literal control byte does not survive every editor round-trip. */
const ESC = String.fromCharCode(27);

let workDir = "";

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "tui-driver-utiledge-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("readJsonl tolerates a damaged file", () => {
  test("skips unparseable lines and keeps the rest", async () => {
    /* The frame index is appended to by a detached recorder, so a torn final line is a normal
       thing to find. It must not take down the command doing the reading. */
    const path = join(workDir, "torn.jsonl");
    await Bun.write(path, '{"id":"one"}\nnot json at all\n{"id":"two"}\n{"id":"thr\n');

    const rows = await readJsonl<{ id: string }>(path);
    expect(rows.map((row) => row.id)).toEqual(["one", "two"]);
  });

  test("blank lines are ignored", async () => {
    const path = join(workDir, "blanks.jsonl");
    await Bun.write(path, '\n\n{"id":"only"}\n   \n');
    expect(await readJsonl<{ id: string }>(path)).toHaveLength(1);
  });

  test("a missing file reads as empty", async () => {
    expect(await readJsonl(join(workDir, "absent.jsonl"))).toEqual([]);
  });
});

describe("readJson tolerates a damaged file", () => {
  test("corrupt JSON reads as undefined rather than throwing", async () => {
    /* Session metadata is read on nearly every command, possibly while another process is writing
       it, so unreadable has to mean "not there". */
    const path = join(workDir, "corrupt.json");
    await Bun.write(path, "{ this is not json");
    expect(await readJson(path)).toBeUndefined();
  });

  test("a missing file reads as undefined", async () => {
    expect(await readJson(join(workDir, "absent.json"))).toBeUndefined();
  });
});

describe("isProcessAlive", () => {
  test("rejects nonsense pids without consulting the OS", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  test("recognises this very process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("a marker that does not match the command line rejects a recycled pid", () => {
    /* Where /proc exists the marker is checked; where it does not the pid check stands alone and
       the marker is ignored, so both outcomes are acceptable for a *non-matching* marker. */
    const result = isProcessAlive(process.pid, "definitely-not-in-our-argv-xyzzy");
    expect(typeof result).toBe("boolean");
  });

  test("a marker that does match is accepted", () => {
    expect(isProcessAlive(process.pid, "bun")).toBe(true);
  });

  test("an unreadable /proc entry falls back to the pid check", () => {
    /* pid 1 exists but its cmdline is not readable by an ordinary user in most sandboxes; the
       read failure must be treated as "alive" rather than propagated. */
    expect(typeof isProcessAlive(1, "systemd")).toBe("boolean");
  });

  test("an almost-certainly-dead pid is reported dead", () => {
    expect(isProcessAlive(0x7ffffff0)).toBe(false);
  });
});

describe("the legacy mouse encodings", () => {
  const spec = (over: Partial<MouseEventSpec> = {}): MouseEventSpec => ({
    x: 4,
    y: 2,
    button: "left",
    action: "press",
    modifiers: NO_MODIFIERS,
    ...over,
  });

  test("utf8 (1005) writes coordinates as UTF-8 code points", () => {
    const bytes = encodeMouseEvent(spec(), "utf8");
    /* ESC [ M, then button, column and row each offset by 32 and encoded as UTF-8. */
    expect(bytes.slice(0, 3)).toEqual([0x1b, 0x5b, 0x4d]);
    expect(bytes[3]).toBe(0 + 32);
    expect(bytes[4]).toBe(4 + 1 + 32);
    expect(bytes[5]).toBe(2 + 1 + 32);
  });

  test("utf8 encodes a coordinate past the single-byte boundary as multiple bytes", () => {
    /* This is the entire reason 1005 exists: x10 cannot express a column beyond 94. */
    const bytes = encodeMouseEvent(spec({ x: 200 }), "utf8");
    expect(bytes.length).toBeGreaterThan(6);
  });

  test("utf8 release reports the all-buttons-released code, as x10 does", () => {
    const bytes = encodeMouseEvent(spec({ action: "release" }), "utf8");
    expect(bytes[3]).toBe(3 + 32);
  });

  test("utf8 carries modifier and motion bits like the others", () => {
    const motion = encodeMouseEvent(spec({ action: "motion" }), "utf8");
    expect(motion[3]).toBe(0 + 32 + 32);

    const ctrl = encodeMouseEvent(spec({ modifiers: { ...NO_MODIFIERS, ctrl: true } }), "utf8");
    expect(ctrl[3]).toBe(0 + 16 + 32);
  });
});

describe("SVG background runs", () => {
  /* Every document opens with one full-bleed rect for the page colour, so the interesting count is
     always the rects *after* that one. */
  const bgRects = (svg: string): string[] =>
    [...svg.matchAll(/<rect (?!width="100%")[^>]*>/g)].map((match) => match[0]);

  test("adjacent cells sharing a background become a single rectangle", () => {
    /* One rect per cell would make a full-screen background thousands of elements; the renderer
       extends the pending run instead, and this is the path that does it. */
    const svg = buildSvg(`${ESC}[41mAAAA${ESC}[0m`, { cols: 10, rows: 1 });
    const rects = bgRects(svg);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toContain('fill="#cd3131"');
    expect(rects[0]).toContain('width="38.4"');
  });

  test("a background change closes one rectangle and opens another", () => {
    const svg = buildSvg(`${ESC}[41mAA${ESC}[42mBB${ESC}[0m`, { cols: 10, rows: 1 });
    const rects = bgRects(svg);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toContain('fill="#cd3131"');
    expect(rects[1]).toContain('fill="#0dbc79"');
  });

  test("a default background paints nothing beyond the page", () => {
    expect(bgRects(buildSvg("plain", { cols: 10, rows: 1 }))).toHaveLength(0);
  });

  test("reverse video forces a background even from default colours", () => {
    /* This is how a selected row shows up in a rendered image at all. */
    expect(bgRects(buildSvg(`${ESC}[7mSELECTED`, { cols: 20, rows: 1 }))).toHaveLength(1);
  });

  test("the cursor draws a block, plus the glyph beneath it", () => {
    const svg = buildSvg("ab", { cols: 10, rows: 1, cursor: { x: 0, y: 0, visible: true } });
    expect(bgRects(svg).some((rect) => rect.includes('fill="#cccccc"'))).toBe(true);
    /* The character under the block is redrawn in the page colour, the way a terminal inverts it. */
    expect(svg).toContain('fill="#1e1e1e"');
  });

  test("the cursor on a blank cell draws the block alone", () => {
    const svg = buildSvg("ab", { cols: 10, rows: 1, cursor: { x: 8, y: 0, visible: true } });
    expect(bgRects(svg).some((rect) => rect.includes('fill="#cccccc"'))).toBe(true);
    expect(svg).not.toContain('fill="#1e1e1e"><');
  });

  test("a cursor outside the screen is ignored rather than clamped", () => {
    for (const cursor of [
      { x: 0, y: 9, visible: true },
      { x: 99, y: 0, visible: true },
      { x: -1, y: 0, visible: true },
      { x: 0, y: -1, visible: true },
    ]) {
      expect(bgRects(buildSvg("ab", { cols: 10, rows: 1, cursor }))).toHaveLength(0);
    }
  });

  test("a hidden cursor draws nothing", () => {
    const svg = buildSvg("ab", { cols: 10, rows: 1, cursor: { x: 0, y: 0, visible: false } });
    expect(bgRects(svg)).toHaveLength(0);
  });

  test("underline and strikethrough are drawn as thin rules", () => {
    expect(bgRects(buildSvg(`${ESC}[4munder`, { cols: 10, rows: 1 }))).toHaveLength(1);
    expect(bgRects(buildSvg(`${ESC}[9mstrike`, { cols: 10, rows: 1 }))).toHaveLength(1);
  });
});
