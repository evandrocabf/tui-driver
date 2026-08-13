import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  framesDir,
  framesIndexPath,
  metaPath,
  pipeLogPath,
  rootDir,
  sessionDir,
  socketPath,
  tmuxConfPath,
  watcherLogPath,
  watcherPath,
} from "../../src/paths.js";

const HOME_VAR = "TUI_DRIVER_HOME";
const XDG_VAR = "XDG_STATE_HOME";

let previousHome: string | undefined;
let previousXdg: string | undefined;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  previousHome = process.env[HOME_VAR];
  previousXdg = process.env[XDG_VAR];
});

afterEach(() => {
  setEnv(HOME_VAR, previousHome);
  setEnv(XDG_VAR, previousXdg);
});

describe("rootDir", () => {
  test("TUI_DRIVER_HOME wins over everything", () => {
    setEnv(HOME_VAR, "/tmp/explicit-root");
    setEnv(XDG_VAR, "/tmp/xdg-root");
    expect(rootDir()).toBe("/tmp/explicit-root");
  });

  test("falls back to XDG_STATE_HOME", () => {
    setEnv(HOME_VAR, undefined);
    setEnv(XDG_VAR, "/tmp/xdg-root");
    expect(rootDir()).toBe(join("/tmp/xdg-root", "tui-driver"));
  });

  test("falls back to ~/.local/state when neither is set", () => {
    setEnv(HOME_VAR, undefined);
    setEnv(XDG_VAR, undefined);
    expect(rootDir()).toBe(join(homedir(), ".local", "state", "tui-driver"));
  });

  test("treats an empty variable as unset", () => {
    /* An exported-but-empty variable is a normal thing to inherit from a shell, and reading it as
       a real root would put the state tree at the filesystem root. */
    setEnv(HOME_VAR, "");
    setEnv(XDG_VAR, "");
    expect(rootDir()).toBe(join(homedir(), ".local", "state", "tui-driver"));
  });
});

describe("socketPath", () => {
  test("sits inside the root when the path is short enough", () => {
    setEnv(HOME_VAR, "/tmp/short");
    expect(socketPath()).toBe("/tmp/short/tmux.sock");
  });

  test("falls back to a hashed name in the temp dir when the root is too long", () => {
    /* Unix socket paths are capped near 108 bytes and tmux appends to them, so a deep root has to
       be relocated or every command fails with a bind error. */
    const deep = `/tmp/${"nested-directory-name/".repeat(8)}root`;
    setEnv(HOME_VAR, deep);

    const socket = socketPath();
    expect(socket.startsWith(tmpdir())).toBe(true);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(108);
    expect(socket).toMatch(/tui-driver-\d+-[0-9a-f]{10}\.sock$/);
  });

  test("the fallback is stable for one root and distinct between roots", () => {
    const deepA = `/tmp/${"a-fairly-long-directory/".repeat(8)}root`;
    const deepB = `/tmp/${"b-fairly-long-directory/".repeat(8)}root`;

    setEnv(HOME_VAR, deepA);
    const first = socketPath();
    const again = socketPath();
    setEnv(HOME_VAR, deepB);
    const other = socketPath();

    /* Stable, or a second command would look for the server on a different socket. */
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });
});

describe("the per-session paths", () => {
  test("all hang off the session directory", () => {
    setEnv(HOME_VAR, "/tmp/root");
    const dir = sessionDir("app");

    expect(dir).toBe("/tmp/root/sessions/app");
    expect(framesDir("app")).toBe(join(dir, "frames"));
    expect(metaPath("app")).toBe(join(dir, "session.json"));
    expect(framesIndexPath("app")).toBe(join(dir, "frames.jsonl"));
    expect(watcherPath("app")).toBe(join(dir, "watcher.json"));
    expect(watcherLogPath("app")).toBe(join(dir, "watcher.log"));
    expect(pipeLogPath("app")).toBe(join(dir, "raw-output.log"));
    expect(tmuxConfPath()).toBe("/tmp/root/tmux.conf");
  });

  test("two sessions never share a directory", () => {
    setEnv(HOME_VAR, "/tmp/root");
    expect(sessionDir("one")).not.toBe(sessionDir("two"));
  });
});
