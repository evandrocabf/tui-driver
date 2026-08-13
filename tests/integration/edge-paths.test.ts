import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { capture } from "../../src/capture.js";
import { main } from "../../src/cli.js";
import { DependencyError, SessionError } from "../../src/errors.js";
import { listFrames, saveFrame } from "../../src/frames.js";
import { detectBackends, svgToPng } from "../../src/png.js";
import { readMeta, writeMeta } from "../../src/meta.js";
import { framesIndexPath, watcherPath } from "../../src/paths.js";
import { requireSession, startSession, stopSession } from "../../src/session.js";
import { ensureConfig, tmuxOrThrow } from "../../src/tmux.js";
import { readWatcher } from "../../src/watch.js";
import {
  captureOutput,
  createState,
  destroyState,
  FIXTURE_COLS,
  FIXTURE_ROWS,
  MENU_FIXTURE,
  restoreHome,
  TOOLS_AVAILABLE,
} from "../helpers/tui.js";

/**
 * The paths that only run when something has gone wrong: a session reaped out from under a command,
 * tmux refusing an argument, a recorder whose process is gone, an environment with no tools at all.
 */

const previousHome = process.env["TUI_DRIVER_HOME"];
let stateDir = "";

function run(argv: string[]): Promise<{ result: number; stdout: string; stderr: string }> {
  return captureOutput(() => main(argv));
}

describe.skipIf(!TOOLS_AVAILABLE)("edge paths", () => {
  beforeAll(async () => {
    stateDir = await createState("edge-paths");
  });

  afterAll(async () => {
    await destroyState(stateDir);
    restoreHome(previousHome);
  });

  describe("a session that has gone away", () => {
    test("capture reports a session that no longer exists", () => {
      expect(capture("never-started-at-all")).rejects.toBeInstanceOf(SessionError);
    });

    test("requireSession distinguishes an expired session from a typo", async () => {
      /* The two need different responses — start it again with a longer lease, versus check the
         name — so the message has to say which happened. */
      const meta = await startSession({
        name: "expired-one",
        argv: ["sleep", "30"],
        cols: 40,
        rows: 10,
      });
      await stopSession("expired-one");
      await writeMeta({ ...meta, ttlMs: 600_000, expiresAtMs: Date.now() - 5_000 });

      let caught: unknown;
      try {
        await requireSession("expired-one");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SessionError);
      expect((caught as Error).message).toContain("expired");
      expect((caught as Error).message).toContain("keepalive");
    }, 30_000);

    test("a plain missing session says so instead", async () => {
      let caught: unknown;
      try {
        await requireSession("no-such-name");
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toContain("no session named");
      expect((caught as Error).message).not.toContain("expired");
    });

    test("acting on an expired session exits 4 through the CLI", async () => {
      const meta = await startSession({
        name: "expired-cli",
        argv: ["sleep", "30"],
        cols: 40,
        rows: 10,
      });
      await stopSession("expired-cli");
      await writeMeta({ ...meta, ttlMs: 600_000, expiresAtMs: Date.now() - 5_000 });

      const { result, stderr } = await run(["snap", "expired-cli"]);
      expect(result).toBe(4);
      expect(stderr).toContain("expired");
    }, 30_000);
  });

  describe("tmux refusing a command", () => {
    test("tmuxOrThrow turns a non-zero exit into a dependency error", () => {
      expect(tmuxOrThrow(["not-a-tmux-command"])).rejects.toBeInstanceOf(DependencyError);
    });

    test("the error carries what tmux actually said", async () => {
      let caught: unknown;
      try {
        await tmuxOrThrow(["has-session", "-t", "=absolutely-not-here"]);
      } catch (error) {
        caught = error;
      }
      expect((caught as Error).message).toContain("tmux has-session failed");
    });
  });

  describe("the config is reloaded into a running server", () => {
    test("a changed config file is sourced rather than only written", async () => {
      /* tmux accepts a `-f` file that does not exist and exits 0, so a server can silently come up
         on tmux's own defaults. The writer is keyed to the resolved path for that reason. */
      await startSession({ name: "config-reload", argv: ["sleep", "30"], cols: 40, rows: 10 });

      const confPath = join(stateDir, "tmux.conf");
      await Bun.write(confPath, "# clobbered\n");

      /* Move the root away and back so the path-keyed cache re-evaluates. */
      const original = process.env["TUI_DRIVER_HOME"];
      process.env["TUI_DRIVER_HOME"] = join(stateDir, "elsewhere");
      await ensureConfig();
      process.env["TUI_DRIVER_HOME"] = original;
      await ensureConfig();

      expect(await Bun.file(confPath).text()).toContain("remain-on-exit");
      await stopSession("config-reload");
    }, 30_000);
  });

  describe("frame ids never collide", () => {
    test("a repeated label gets a counter suffix", async () => {
      /* Timestamps have millisecond resolution and labels are caller-supplied, so two frames can
         genuinely want the same name — and the second must not overwrite the first's files. */
      const name = "frame-collide";
      await startSession({
        name,
        argv: ["python3", MENU_FIXTURE],
        cols: FIXTURE_COLS,
        rows: FIXTURE_ROWS,
      });
      await run(["wait", name, "--text", "TUI DRIVER DEMO", "--timeout", "10s", "--quiet"]);

      const snapshot = await capture(name);
      const first = await saveFrame(name, snapshot, { kind: "snap", label: "same" });
      const second = await saveFrame(name, snapshot, { kind: "snap", label: "same" });

      expect(second.id).not.toBe(first.id);
      expect(second.id).toBe(`${first.id}-1`);
      expect(await Bun.file(first.files.text).exists()).toBe(true);
      expect(await Bun.file(second.files.text).exists()).toBe(true);

      await stopSession(name, { purge: true });
    }, 40_000);
  });

  describe("a recorder whose process is gone", () => {
    test("the stale state file is cleaned up and reported as no recorder", async () => {
      const name = "stale-watcher";
      await startSession({ name, argv: ["sleep", "30"], cols: 40, rows: 10 });

      /* A pid that cannot be running: the recorder was killed with the rest of a process group,
         and its state file outlived it. */
      await Bun.write(
        watcherPath(name),
        JSON.stringify({ pid: 0x7ffffff0, session: name, startedAt: new Date().toISOString() }),
      );

      expect(await readWatcher(name)).toBeUndefined();
      expect(await Bun.file(watcherPath(name)).exists()).toBe(false);

      await stopSession(name, { purge: true });
    }, 30_000);
  });

  describe("input pacing", () => {
    test("--delay sends keys one at a time", async () => {
      const name = "delayed-keys";
      await startSession({
        name,
        argv: ["python3", MENU_FIXTURE],
        cols: FIXTURE_COLS,
        rows: FIXTURE_ROWS,
      });
      await run(["wait", name, "--text", "TUI DRIVER DEMO", "--timeout", "10s", "--quiet"]);

      const keys = await run(["keys", name, "Down", "--repeat", "2", "--delay", "20ms"]);
      expect(keys.result).toBe(0);

      const typed = await run(["type", name, "ab", "--delay", "20ms"]);
      expect(typed.result).toBe(0);

      await stopSession(name, { purge: true });
    }, 40_000);
  });

  describe("an environment with no tools at all", () => {
    test("rasterising with an empty PATH is a dependency error", async () => {
      /* Covers both the "nothing installed" branch and the chrome lookup that finds no binary
         under any of its packaging names. */
      const originalPath = process.env["PATH"];
      await mkdir(join(stateDir, "empty-bin"), { recursive: true });
      const svgPath = join(stateDir, "nopath.svg");
      await Bun.write(
        svgPath,
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
      );

      try {
        /* Not "": with PATH empty, POSIX lets the shell fall back to a default system path, and
           `command -v` then finds the tools anyway. An existing-but-empty directory is honoured. */
        process.env["PATH"] = join(stateDir, "empty-bin");
        expect(await detectBackends()).toEqual([]);

        let caught: unknown;
        try {
          await svgToPng(svgPath, join(stateDir, "nopath.png"), {
            width: 10,
            height: 10,
            scale: 1,
          });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(DependencyError);
        expect((caught as Error).message).toContain("no SVG rasterizer found");
        /* The advice has to name a flag the CLI actually accepts. It read "--format svg" for a
           while, which exits 2 as an unknown option — wrong at the one moment the reader has no
           rasterizer and needs the escape hatch to work. Checked against `help render` rather than
           a hard-coded name, so renaming the flag cannot leave the advice behind. */
        const advised = /--[a-z-]+/.exec((caught as Error).message)?.[0] ?? "";
        expect(advised).not.toBe("");
        expect((await run(["help", "render"])).stdout).toContain(advised);

        /* Chrome specifically: forced, with none of its four names resolvable. */
        let chromeError: unknown;
        try {
          await svgToPng(svgPath, join(stateDir, "nochrome.png"), {
            width: 10,
            height: 10,
            scale: 1,
            backend: "chrome",
          });
        } catch (error) {
          chromeError = error;
        }
        expect(chromeError).toBeInstanceOf(DependencyError);
      } finally {
        process.env["PATH"] = originalPath;
      }
    }, 60_000);
  });

  describe("metadata survives a session started by hand", () => {
    test("readMeta reports undefined for a session with no record", async () => {
      expect(await readMeta("no-metadata-anywhere")).toBeUndefined();
    });

    test("listFrames tolerates an index pointing at pruned files", async () => {
      const name = "pruned-index";
      await startSession({ name, argv: ["sleep", "30"], cols: 40, rows: 10 });
      await Bun.write(
        framesIndexPath(name),
        `${JSON.stringify({
          id: "gone",
          kind: "auto",
          capturedAt: new Date().toISOString(),
          files: { text: join(stateDir, "absent.txt"), ansi: join(stateDir, "absent.ansi") },
        })}\n`,
      );

      /* `watch --keep` deletes files without rewriting the append-only index, so an entry whose
         files are gone is a normal thing to read past. */
      expect(await listFrames(name)).toEqual([]);
      expect((await listFrames(name, { includePruned: true })).length).toBe(1);

      await stopSession(name, { purge: true });
    }, 30_000);
  });
});
