# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing is published to a registry yet — `package.json` carries `"private": true`. Install from the
repository with `install.sh`.

### Added

- **Driving a TUI from the shell.** `tui start` runs any terminal program inside a private tmux
  server, and `snap`, `keys`, `type`, `paste`, `click`, `move`, `drag`, `scroll`, `wait`, `find`,
  `resize` and `stop` act on it. Every command has a `--json` form, so a program — or an agent — can
  read the result rather than parse the display.
- **Seeing the screen.** `tui snap` prints the pane as text or ANSI; `tui render` turns any frame
  into an SVG or a PNG through whichever rasterizer is installed (`rsvg-convert`, ImageMagick or
  headless Chrome). `--svg` needs no external tool at all. Images are written next to the frame in
  the session store rather than into the working directory, unless `--out` says otherwise.
- **Real mouse support.** Clicks are encoded in the wire protocol the application itself turned on —
  `sgr(1006)`, `utf8(1005)` or `x10`, detected per event through tmux's mode flags — and injected as
  raw bytes.
- **Recording over time.** `tui watch` records every screen change in the background, `tui frames`
  lists what it captured, and `tui diff` compares any two frames, including against `live`.
- **Repeatable checks.** `tui run <scenario.yaml>` drives a session through a scripted list of steps
  with `expect` and `golden` assertions. `examples/menu-smoke.yaml` is a working example, exercised
  by the test suite.
- **Sessions expire on their own.** Every session carries a lease (10 minutes by default) and a
  detached `sh` watchdog that kills it when the lease runs out, so a forgotten `tui start` cannot
  keep a process tree alive indefinitely. `--ttl` asks for longer (60m ceiling), `tui keepalive`
  extends a running session, `tui gc` reaps on demand, and every command sweeps before it runs.
  `TUI_DRIVER_TTL` sets the default per machine.
- **An agent skill.** `skills/tui-driver/SKILL.md` is written for any coding agent that can run a
  shell command, with no vendor-specific tool names in it. `install.sh` places it wherever the agents
  on the machine look — Claude Code, Codex, Cursor, opencode, Gemini, Cline, Windsurf, and the
  shared `~/.agents/skills` location — alongside a `tui` shim on `PATH`.
- **Diagnostics.** `tui doctor` checks tmux, terminfo and image rendering. A missing rasterizer is a
  warning; only tmux and terminfo affect the exit code.
- Documented exit codes: `0` success, `1` condition not met, `2` usage error, `3` missing dependency,
  `4` no such session (or one that expired).
- Continuous integration on Linux and macOS, with lint, formatting, type checks, and a line-coverage
  floor of 98% over shipped code.

[Unreleased]: https://github.com/evandrocabf/tui-driver/commits/main
