import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectBackends } from "../../src/png.js";
import { renderAnsiToFile } from "../../src/render.js";

const BACKENDS = await detectBackends();
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

let workDir = "";

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "tui-driver-render-it-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("detectBackends", () => {
  test("reports the rasterizers present on this machine", () => {
    expect(Array.isArray(BACKENDS)).toBe(true);
    for (const backend of BACKENDS) {
      expect(["rsvg-convert", "magick", "convert", "chrome"]).toContain(backend);
    }
  });
});

describe("renderAnsiToFile", () => {
  test("writes an SVG without needing any external tool", async () => {
    const out = join(workDir, "frame.svg");
    const result = await renderAnsiToFile("[31mhello", out, { cols: 20, rows: 3 });
    expect(result.format).toBe("svg");
    expect(result.backend).toBeUndefined();
    expect(await Bun.file(out).text()).toContain("<svg xmlns=");
  });

  test("infers png from an explicit format even when the path says otherwise", async () => {
    const out = join(workDir, "explicit.svg");
    const result = await renderAnsiToFile("plain", out, { cols: 10, rows: 2, format: "svg" });
    expect(result.format).toBe("svg");
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
  });

  test.skipIf(BACKENDS.length === 0)(
    "rasterises to a real PNG",
    async () => {
      const out = join(workDir, "frame.png");
      const result = await renderAnsiToFile("[1;32mhello world", out, {
        cols: 20,
        rows: 3,
        format: "png",
        scale: 1,
        cursor: { x: 0, y: 0, visible: true },
      });

      expect(result.format).toBe("png");
      expect(result.backend).toBeDefined();
      expect(BACKENDS).toContain(result.backend!);

      const bytes = new Uint8Array(await Bun.file(out).arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual(PNG_MAGIC);
      expect(bytes.byteLength).toBeGreaterThan(100);
    },
    60_000,
  );

  test.skipIf(BACKENDS.length === 0)(
    "scales the output",
    async () => {
      const out = join(workDir, "scaled.png");
      const result = await renderAnsiToFile("hi", out, {
        cols: 10,
        rows: 2,
        format: "png",
        scale: 3,
      });
      expect(result.width).toBeGreaterThan(10 * 16 * 0.6 * 2);
    },
    60_000,
  );

  test("creates the output directory when it is missing", async () => {
    const out = join(workDir, "nested", "deeper", "frame.svg");
    await renderAnsiToFile("nested", out, { cols: 8, rows: 1 });
    expect(await Bun.file(out).exists()).toBe(true);
  });

  test("leaves no temporary files behind", async () => {
    const { readdir } = await import("node:fs/promises");
    const before = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("tui-driver-render-"),
    ).length;
    await renderAnsiToFile("temp check", join(workDir, "temp.svg"), { cols: 12, rows: 1 });
    const after = (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("tui-driver-render-"),
    ).length;
    expect(after).toBe(before);
  });
});
