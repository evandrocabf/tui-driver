import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DependencyError } from "../../src/errors.js";
import { detectBackends, svgToPng, type PngBackend } from "../../src/png.js";
import { hasBinary } from "../helpers/tui.js";

/**
 * Each rasterizer backend, driven individually.
 *
 * `svgToPng` normally picks a backend itself, which means only the best one installed on a given
 * machine is ever exercised. Forcing each in turn is the only way to reach the others — and forcing
 * one that is *not* installed is what covers the failure path every backend shares.
 */

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20">
<rect width="100%" height="100%" fill="#1e1e1e"/><text x="2" y="14" fill="#ccc">hi</text></svg>`;

/** Which binary has to exist for a backend to be able to succeed. */
const BINARY: Record<PngBackend, string[]> = {
  "rsvg-convert": ["rsvg-convert"],
  magick: ["magick"],
  convert: ["convert"],
  chrome: ["google-chrome", "chromium", "chromium-browser", "google-chrome-stable"],
};

let workDir = "";
let installed: PngBackend[] = [];

async function anyPresent(backend: PngBackend): Promise<boolean> {
  for (const binary of BINARY[backend]) if (await hasBinary(binary)) return true;
  return false;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "tui-driver-png-"));
  installed = await detectBackends();
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("detectBackends", () => {
  test("reports only names the type allows", () => {
    for (const backend of installed) {
      expect(["rsvg-convert", "magick", "convert", "chrome"]).toContain(backend);
    }
  });

  test("never reports both magick and convert", () => {
    /* They are the same tool across ImageMagick versions, and on v7 `convert` is a deprecated shim
       that prints warnings — reporting both would just mean trying it twice. */
    expect(installed.includes("magick") && installed.includes("convert")).toBe(false);
  });
});

describe.each(["rsvg-convert", "magick", "convert", "chrome"] as PngBackend[])(
  "the %s backend",
  (backend) => {
    test("rasterises a real PNG when its binary is installed", async () => {
      if (!(await anyPresent(backend))) return;

      const svgPath = join(workDir, `${backend}.svg`);
      const pngPath = join(workDir, `${backend}.png`);
      await Bun.write(svgPath, SVG);

      const result = await svgToPng(svgPath, pngPath, {
        width: 40,
        height: 20,
        scale: 1,
        backend,
      });

      expect(result.backend).toBe(backend);
      expect(result.width).toBe(40);
      expect(result.height).toBe(20);

      const bytes = new Uint8Array(await Bun.file(pngPath).arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual(PNG_MAGIC);
    }, 90_000);

    test("reports a dependency failure when its binary is absent", async () => {
      if (await anyPresent(backend)) return;

      const svgPath = join(workDir, `${backend}-missing.svg`);
      await Bun.write(svgPath, SVG);

      /* Forcing an uninstalled backend runs the same command-building code, fails, and falls
         through to the shared error — which is the branch worth covering. */
      expect(
        svgToPng(svgPath, join(workDir, `${backend}-missing.png`), {
          width: 40,
          height: 20,
          scale: 1,
          backend,
        }),
      ).rejects.toThrow(/rasterization failed/);
    }, 60_000);
  },
);

describe("svgToPng", () => {
  test("scales the output by the requested factor", async () => {
    if (installed.length === 0) return;
    const svgPath = join(workDir, "scaled.svg");
    await Bun.write(svgPath, SVG);

    const result = await svgToPng(svgPath, join(workDir, "scaled.png"), {
      width: 40,
      height: 20,
      scale: 3,
    });
    expect(result.width).toBe(120);
    expect(result.height).toBe(60);
  }, 90_000);

  test("a scale below 1 is floored rather than shrinking the image", async () => {
    if (installed.length === 0) return;
    const svgPath = join(workDir, "tiny.svg");
    await Bun.write(svgPath, SVG);

    const result = await svgToPng(svgPath, join(workDir, "tiny.png"), {
      width: 40,
      height: 20,
      scale: 0.1,
    });
    expect(result.width).toBe(40);
  }, 90_000);

  test("a missing binary is a dependency error, never an unhandled crash", async () => {
    /* Regression: Bun.spawn throws when the executable is not on PATH. detectBackends normally
       makes that unreachable, but an explicitly chosen backend skips detection — and the raw throw
       escaped `instanceof CliError`, so the CLI exited 70 instead of the documented 3. */
    const absent = (["rsvg-convert", "magick", "convert", "chrome"] as PngBackend[]).find(
      (backend) => !installed.includes(backend),
    );
    if (!absent) return;

    const svgPath = join(workDir, "spawn-fail.svg");
    await Bun.write(svgPath, SVG);

    let caught: unknown;
    try {
      await svgToPng(svgPath, join(workDir, "spawn-fail.png"), {
        width: 40,
        height: 20,
        scale: 1,
        backend: absent,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DependencyError);
    expect((caught as DependencyError).exitCode).toBe(3);
  }, 90_000);

  test("chrome leaves no profile directory behind", async () => {
    if (!(await anyPresent("chrome"))) return;

    const svgPath = join(workDir, "profile.svg");
    await Bun.write(svgPath, SVG);
    await svgToPng(svgPath, join(workDir, "profile.png"), {
      width: 40,
      height: 20,
      scale: 1,
      backend: "chrome",
    }).catch(() => undefined);

    /* Chrome insists on a profile directory; it is a directory rather than a file, so an unlink()
       would always fail and leak one per render. */
    const profile = join(tmpdir(), `tui-driver-chrome-${process.pid}`);
    expect(await Bun.file(join(profile, "Local State")).exists()).toBe(false);
  }, 90_000);
});
