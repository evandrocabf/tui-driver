/**
 * Rasterising SVG to PNG through whichever external tool is installed.
 *
 * There is no rasterizer in the runtime, and bundling one would dwarf the rest of the tool, so this
 * shells out. Every backend is optional by design: `--svg` needs none of them, and `tui doctor`
 * reports a missing rasterizer as a warning rather than a failure.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { DependencyError } from "./errors.js";

/**
 * A tool that can turn SVG into PNG, in preference order.
 *
 * `rsvg-convert` is first because it is small, exact and fast; ImageMagick is common; headless
 * Chrome is the last resort, since starting a browser to draw one image is slow but it is installed
 * almost everywhere.
 */
export type PngBackend = "rsvg-convert" | "magick" | "convert" | "chrome";

/** What was rasterised, and by what. */
export interface PngResult {
  /** The tool that produced the image. */
  backend: PngBackend;
  /** Where it was written. */
  path: string;
  /** Final width in px, after the scale factor. */
  width: number;
  /** Final height in px, after the scale factor. */
  height: number;
}

/** The names Chrome ships under across distributions and package managers. */
const CHROME_CANDIDATES = ["google-chrome", "chromium", "chromium-browser", "google-chrome-stable"];

/**
 * Resolve a binary on PATH, or `undefined` if it is not there.
 *
 * The environment is passed explicitly, as {@link tmuxEnv} does for tmux: Bun snapshots the
 * environment at startup for spawned children, so a PATH adjusted at runtime would otherwise be
 * ignored and detection would report tools the caller has deliberately put out of reach.
 */
async function which(binary: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["sh", "-c", `command -v ${binary} 2>/dev/null`], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      env: { ...process.env },
    });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return undefined;
    const path = stdout.trim();
    return path === "" ? undefined : path;
  } catch {
    /* Even `sh` can be unreachable — a scrubbed PATH, a stripped container. "Cannot tell" has to
       mean "not available" rather than an unhandled throw: PNG output is optional, so the right
       outcome is `--svg` still working and `doctor` warning, not the whole command crashing. */
    return undefined;
  }
}

/**
 * Which rasterizers are installed, best first.
 *
 * `magick` and `convert` are the same tool across ImageMagick versions, so only one is reported —
 * on ImageMagick 7 `convert` is a deprecated shim that prints warnings.
 *
 * @returns Possibly empty, which is what makes PNG output optional rather than required.
 */
export async function detectBackends(): Promise<PngBackend[]> {
  const found: PngBackend[] = [];
  if (await which("rsvg-convert")) found.push("rsvg-convert");
  if (await which("magick")) found.push("magick");
  else if (await which("convert")) found.push("convert");
  for (const candidate of CHROME_CANDIDATES) {
    if (await which(candidate)) {
      found.push("chrome");
      break;
    }
  }
  return found;
}

/**
 * Run a command to completion, capturing stderr for diagnostics.
 *
 * A missing binary is reported as exit 127 rather than allowed to throw. `Bun.spawn` raises when
 * the executable is not on PATH, and {@link detectBackends} normally makes that impossible — but an
 * explicitly chosen backend bypasses detection, and a tool that is simply absent has to surface as
 * a {@link DependencyError} (exit 3) rather than an unhandled crash (exit 70).
 */
async function run(command: string[]): Promise<{ code: number; stderr: string }> {
  try {
    const proc = Bun.spawn(command, {
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
      env: { ...process.env },
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { code, stderr };
  } catch (error) {
    return { code: 127, stderr: (error as Error).message };
  }
}

/** Target geometry for rasterization. */
export interface SvgToPngOptions {
  /** Logical width in px, before scaling. */
  width: number;
  /** Logical height in px, before scaling. */
  height: number;
  /** Pixel scale factor; 2 gives a legible image on a high-density display. */
  scale: number;
  /** Force one backend instead of trying them in order. Mostly useful for tests. */
  backend?: PngBackend;
}

/**
 * Rasterise an SVG file to PNG, trying each available backend until one succeeds.
 *
 * Falling through on failure rather than on absence matters: a backend can be installed and still
 * fail on a particular SVG, and the next one usually handles it.
 *
 * @throws {DependencyError} If no backend is installed, or every one of them failed.
 */
export async function svgToPng(
  svgPath: string,
  pngPath: string,
  options: SvgToPngOptions,
): Promise<PngResult> {
  const scale = Math.max(1, options.scale);
  const width = Math.round(options.width * scale);
  const height = Math.round(options.height * scale);
  const available = options.backend ? [options.backend] : await detectBackends();

  if (available.length === 0) {
    throw new DependencyError(
      "no SVG rasterizer found — install rsvg-convert (librsvg2-bin, librsvg2-tools, or brew librsvg) or ImageMagick, or use --svg",
    );
  }

  const failures: string[] = [];
  for (const backend of available) {
    const result = await rasterize(backend, svgPath, pngPath, width, height, scale);
    if (result) return { backend, path: pngPath, width, height };
    failures.push(backend);
  }
  throw new DependencyError(`SVG rasterization failed with: ${failures.join(", ")}`);
}

/**
 * Run one backend.
 *
 * Success is checked by looking for the output file, not just the exit status: some of these tools
 * report 0 while writing nothing.
 *
 * @returns True if the PNG now exists.
 */
async function rasterize(
  backend: PngBackend,
  svgPath: string,
  pngPath: string,
  width: number,
  height: number,
  scale: number,
): Promise<boolean> {
  if (backend === "rsvg-convert") {
    const { code } = await run([
      "rsvg-convert",
      "-w",
      String(width),
      "-h",
      String(height),
      "-o",
      pngPath,
      svgPath,
    ]);
    return code === 0 && (await Bun.file(pngPath).exists());
  }

  if (backend === "magick" || backend === "convert") {
    const { code } = await run([
      backend,
      "-density",
      String(Math.round(96 * scale)),
      "-background",
      "none",
      svgPath,
      "-resize",
      `${width}x${height}!`,
      pngPath,
    ]);
    return code === 0 && (await Bun.file(pngPath).exists());
  }

  const chrome = await firstChrome();
  if (!chrome) return false;
  const profile = join(tmpdir(), `tui-driver-chrome-${process.pid}`);
  const { code } = await run([
    chrome,
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--force-device-scale-factor=${scale}`,
    `--screenshot=${pngPath}`,
    `file://${svgPath}`,
  ]);
  /* Chrome insists on a profile directory, so this has to be a recursive remove — unlink() would
     always fail here and leak a directory per render. */
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  return code === 0 && (await Bun.file(pngPath).exists());
}

/** The first Chrome-like binary on PATH, under any of its packaging names. */
async function firstChrome(): Promise<string | undefined> {
  for (const candidate of CHROME_CANDIDATES) {
    const found = await which(candidate);
    if (found) return found;
  }
  return undefined;
}
