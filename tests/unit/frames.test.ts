import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";

import { UsageError } from "../../src/errors.js";
import {
  assertLabel,
  listFrames,
  readFrameAnsi,
  readFrameText,
  resolveFrame,
  saveFrame,
  type FrameRecord,
} from "../../src/frames.js";
import { createState, makeSnapshot, restoreHome } from "../helpers/tui.js";

const SESSION = "frames-unit";
const previousHome = process.env["TUI_DRIVER_HOME"];

let stateDir = "";
let saved: FrameRecord[] = [];

beforeAll(async () => {
  stateDir = await createState("frames");
  /* Distinct timestamps so the generated ids sort the way the frames were written. */
  saved = [
    await saveFrame(SESSION, makeSnapshot({ capturedAtMs: 1000, text: "one" }), {
      kind: "snap",
      label: "boot",
    }),
    await saveFrame(SESSION, makeSnapshot({ capturedAtMs: 2000, text: "two" }), { kind: "auto" }),
    await saveFrame(SESSION, makeSnapshot({ capturedAtMs: 3000, text: "three" }), {
      kind: "snap",
      label: "final",
    }),
  ];
});

afterAll(async () => {
  await rm(stateDir, { recursive: true, force: true });
  restoreHome(previousHome);
});

describe("assertLabel", () => {
  test("accepts letters, digits, dot, dash and underscore", () => {
    expect(() => assertLabel("01-boot_v1.2")).not.toThrow();
  });

  test("rejects separators that would escape the frame directory", () => {
    expect(() => assertLabel("../etc/passwd")).toThrow(UsageError);
    expect(() => assertLabel("with space")).toThrow(UsageError);
  });
});

describe("saveFrame", () => {
  test("writes the text and ansi bodies and indexes the record", async () => {
    const first = saved[0]!;
    expect(first.label).toBe("boot");
    expect(first.kind).toBe("snap");
    expect(await readFrameText(first)).toBe("one\n");
    expect(await readFrameAnsi(first)).toBe("one");
    expect(first.files.image).toBeUndefined();
  });

  test("puts the label in the frame id", () => {
    expect(saved[0]!.id).toContain("boot");
    expect(saved[1]!.id).not.toContain("boot");
  });
});

describe("listFrames", () => {
  test("returns every frame that still has a body on disk", async () => {
    expect(await listFrames(SESSION)).toHaveLength(3);
  });

  test("returns nothing for a session that never recorded", async () => {
    expect(await listFrames("never-recorded")).toEqual([]);
  });
});

describe("resolveFrame", () => {
  test("last and -0 are the newest frame", async () => {
    expect((await resolveFrame(SESSION, undefined)).id).toBe(saved[2]!.id);
    expect((await resolveFrame(SESSION, "last")).id).toBe(saved[2]!.id);
    expect((await resolveFrame(SESSION, "-0")).id).toBe(saved[2]!.id);
  });

  test("first is the oldest frame", async () => {
    expect((await resolveFrame(SESSION, "first")).id).toBe(saved[0]!.id);
  });

  test("-N counts back from the newest", async () => {
    expect((await resolveFrame(SESSION, "-1")).id).toBe(saved[1]!.id);
    expect((await resolveFrame(SESSION, "-2")).id).toBe(saved[0]!.id);
  });

  test("a bare number is an absolute index", async () => {
    expect((await resolveFrame(SESSION, "0")).id).toBe(saved[0]!.id);
    expect((await resolveFrame(SESSION, "2")).id).toBe(saved[2]!.id);
  });

  test("resolves by id and by label", async () => {
    expect((await resolveFrame(SESSION, saved[1]!.id)).id).toBe(saved[1]!.id);
    expect((await resolveFrame(SESSION, "final")).id).toBe(saved[2]!.id);
  });

  test("reports an out-of-range reference with the frame count", () => {
    expect(resolveFrame(SESSION, "-9")).rejects.toThrow(/out of range \(3 frames\)/);
  });

  test("reports an unknown reference and an empty session", () => {
    expect(resolveFrame(SESSION, "nope")).rejects.toThrow(/no frame matching/);
    expect(resolveFrame("never-recorded", "last")).rejects.toThrow(/no frames recorded/);
  });
});
