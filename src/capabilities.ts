/** Runtime capability discovery for one managed pane. */

import { queryMouseModes } from "./input.js";
import { exactTarget, tmux, tmuxVersion } from "./tmux.js";

export interface SessionCapabilities {
  schemaVersion: 1;
  backend: "tmux";
  scope: "single-pane-cell-grid";
  tmux: {
    version: string;
    paneKeyMode: string;
    extendedKeys: boolean;
    extendedKeysFormat: string;
    focusEvents: boolean;
  };
  input: {
    tmuxKeys: true;
    literalText: true;
    bracketedPaste: true;
    rawBytes: true;
    focusEvents: true;
    kittyCsiUEvents: readonly ["press", "repeat", "release"];
  };
  capture: {
    text: true;
    ansi: true;
    styledCellGrid: true;
    cursor: true;
    paneState: true;
    scrollback: true;
    terminalGraphics: false;
  };
  mouse: Awaited<ReturnType<typeof queryMouseModes>>;
  limitations: string[];
}

async function option(args: string[]): Promise<string> {
  const result = await tmux(args);
  return result.code === 0 ? result.stdout.trim() : "";
}

/** Report capabilities actually configured on the private server and active pane. */
export async function sessionCapabilities(name: string): Promise<SessionCapabilities> {
  const target = `${exactTarget(name)}:`;
  const pane = await option(["display-message", "-p", "-t", target, "#{pane_key_mode}"]);
  const extendedKeys = await option(["show-options", "-sv", "extended-keys"]);
  const extendedKeysFormat = await option(["show-options", "-gv", "extended-keys-format"]);
  const focusEvents = await option(["show-options", "-gv", "focus-events"]);
  return {
    schemaVersion: 1,
    backend: "tmux",
    scope: "single-pane-cell-grid",
    tmux: {
      version: await tmuxVersion(),
      paneKeyMode: pane || "normal",
      extendedKeys: extendedKeys === "on",
      extendedKeysFormat: extendedKeysFormat || "unknown",
      focusEvents: focusEvents === "on",
    },
    input: {
      tmuxKeys: true,
      literalText: true,
      bracketedPaste: true,
      rawBytes: true,
      focusEvents: true,
      kittyCsiUEvents: ["press", "repeat", "release"],
    },
    capture: {
      text: true,
      ansi: true,
      styledCellGrid: true,
      cursor: true,
      paneState: true,
      scrollback: true,
      terminalGraphics: false,
    },
    mouse: await queryMouseModes(name),
    limitations: [
      "one tmux pane per managed session",
      "cell-grid capture cannot represent sixel, Kitty graphics or iTerm images",
      "PTY behavior does not prove identical behavior in a physical terminal emulator",
    ],
  };
}
