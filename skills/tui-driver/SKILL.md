---
name: tui-driver
description: Open, see, click and navigate any terminal UI (TUI) from the shell, and write repeatable TUI tests. Use whenever the task involves running or inspecting a full-screen terminal program — htop, vim, lazygit, a curses/ink/ratatui/opentui app, an installer or a CLI wizard — or asks to screenshot a TUI, click a button in a TUI, check what a TUI renders, drive it with the keyboard or mouse, record what it does over time, or assert that its screen is correct.
---

# Driving a TUI with tui-driver

A TUI cannot be driven by running it as an ordinary shell command: it takes over the terminal,
expects a pty, and produces no useful stdout. `tui-driver` runs it inside a private tmux server
instead, and turns every interaction into a one-shot command that prints the screen back as plain
text. Everything below is a shell command, so whatever your shell/terminal tool is called, that is
the only capability you need.

**`tui-driver` is the instrument, never the subject.** The program you are driving is whatever the
project you are working in builds, ships or depends on — an app, a CLI wizard, an installer, or a
third-party tool like `htop` or `lazygit`. Nothing below asks you to run or test tui-driver itself.

The command is `tui`. If it is not on `PATH`, it can be run from the tui-driver checkout with
`bun run <tui-driver>/bin/tui.ts` — that path locates _the tool_, and has nothing to do with the
program under test. `tui doctor` checks the environment; `tui help <command>` lists any options.

## Step one: work out what to launch

This is the part that is specific to each project, and the part worth being careful about. Do not
guess a command — find the real one:

- `package.json` scripts, `Cargo.toml` `[[bin]]`, `pyproject.toml` entry points, `Makefile` targets
- a built binary under `target/`, `dist/`, `build/` or `bin/`
- the project's own README quickstart, or how its docs tell a human to start it

If the project must be built or installed first, do that before starting a session. A TUI that dies
on a missing artifact looks exactly like a broken harness, and you will waste a turn on it.

Then launch it from its own directory. Everything after `--` is taken literally:

```bash
tui start --name myapp --cwd /path/to/project -- npm run dev
tui start --name myapp -- ./target/debug/myapp --config ./dev.toml
tui start --name myapp --env API_URL=http://localhost:3000 -- python3 -m myapp
tui start --name htop -- htop                    # third-party tools work the same way
```

Name the session after the program, not `app`, so parallel work never collides. Ask the user how to
start it only when the project genuinely does not say.

## The loop

Once it is running, every turn is the same shape (`app` below is your session name):

```bash
tui snap app                                  # read the screen at any time
tui keys app Down Enter --snap                # act, then print the resulting screen
tui wait app --text "Saved" --timeout 10s     # synchronise on content, never on sleep
tui stop app                                  # clean up when done (or let the 10m lease do it)
```

`--snap` on any action command captures after the screen settles, so one command is one full turn:
act and observe together. Prefer it over a separate `snap`.

## Rules that matter

1. **Never `sleep` and hope.** Use `tui wait --text <pattern>` for content, `--stable 300ms` for
   "stopped redrawing", `--exit` for termination. `wait` exits 1 on timeout and prints the screen it
   gave up on, which is exactly what you need to diagnose it.
2. **Coordinates are 0-based**, top-left is `0,0`. `tui snap app --ruler` prints row and column
   numbers alongside the screen; use it before aiming a click.
3. **Prefer targeting text over coordinates.** `tui click app --text "Save"` finds the label and
   clicks its centre — it survives layout changes, hard-coded numbers do not.
4. **Still `tui stop` when finished** — but nothing leaks if you do not. Every session carries a
   10-minute lease and kills itself when it runs out, whether or not any command is ever run again.
   `tui ls` shows what is alive and how long each has left; `tui stop --all` clears everything now.
   If work on one TUI will take longer than the lease, ask for it upfront with
   `tui start --ttl 30m`, or extend a running session with `tui keepalive app 20m`. Acting on an
   expired session exits 4 and says so — start it again.
5. **Check the header.** Every capture starts with a line like
   `── app · 120x32 · cursor 4,10 · vim · mouse button-event(1002)/sgr(1006) · +2.2s · alt-screen`.
   It tells you the size, where the cursor is, whether the process already exited, and whether the
   TUI accepts mouse input at all.

## Reading the screen

```bash
tui snap app                    # header + plain text (default; this is what you usually want)
tui snap app --ruler            # with row/column numbers, for aiming clicks
tui snap app --raw              # screen only, no header
tui snap app --json             # full metadata: size, cursor, mouse modes, exit status, hash
tui snap app --scrollback 200   # include scrollback history
tui find app "Settings"         # locate text, get clickable coordinates
tui find app "^\\s*Error" --regex --all
```

To _look_ at the TUI rather than read it — layout, colour, alignment, or anything text cannot
convey — render an image, then open that file with whatever tool you have for viewing images:

```bash
tui render app --out /tmp/shot.png    # then open /tmp/shot.png with your file/image viewer
tui snap app --png                    # capture and rasterise in one step
tui render app                        # no --out: writes into the session store, prints the path
```

Text is cheaper and usually enough. Reach for the image when the question is visual — and if you
cannot display images at all, stay with `tui snap`, which answers most questions on its own.

## Keyboard

```bash
tui keys app Down Down Enter
tui keys app C-c                 # also accepts ctrl+c, ctrl-c, ^c
tui keys app Escape Tab F5 PPage # esc, pgup, backspace, del … all have friendly aliases
tui keys app j --repeat 10 --delay 30ms
tui type app "hello world" --enter
tui paste app --file notes.txt   # bracketed paste, for multi-line input
```

## Mouse

The wire encoding is auto-detected from what the TUI itself enabled, so clicks land correctly in
both modern (SGR) and legacy (x10) applications. If the header says `mouse off`, the application
does not listen to the mouse and the commands will warn you.

```bash
tui click app --text "Reports"          # by label (preferred)
tui click app 12 4                      # by coordinate
tui click app 12 4 --button right
tui click app 12 4 --count 2            # double click
tui click app 12 4 --modifiers ctrl+shift
tui move  app 20 6                      # hover / motion
tui drag  app 1 1 40 10 --steps 8
tui scroll app --down --amount 5
```

## Watching over time

For a TUI that changes on its own — a progress bar, a log tail, a long build:

```bash
tui watch app --interval 500ms   # background recorder; saves a frame on every change
tui frames app --last 10         # what it captured
tui frame app -2                 # print the third-newest frame
tui diff app -1 live             # what changed since the previous frame
tui watch app --stop
```

Frames are content-hashed, so an idle screen costs nothing. Every frame keeps its ANSI form, so
`tui render app <ref> --out shot.png` can rasterise any past frame after the fact.

## Repeatable tests

When the goal is a check the project can re-run — not a one-off inspection — write a scenario
instead of a command sequence. `command` and `cwd` describe _the project's_ program, exactly as you
worked out above; `cwd` is relative to the scenario file:

```yaml
name: settings-smoke
command: ["npm", "run", "start", "--silent"]
cwd: ../..
size: 100x30
steps:
  - wait: { text: "READY", timeout: 10s }
  - expect: { text: "Dashboard" }
  - keys: [Down, Down]
  - wait: { stable: 250ms }
  - click: { text: "Settings" }
  - expect: { text: "Settings" }
  - expect: { notText: "Traceback" }
  - golden: settings-screen
  - keys: [q]
  - wait: { exit: true }
```

```bash
tui run tests/tui/settings-smoke.yaml                  # exit 1 on the first failing step
tui run tests/tui/settings-smoke.yaml --update-golden  # accept the current screens as the baseline
```

Steps available: `wait`, `sleep`, `snap`, `keys`, `type`, `paste`, `click`, `move`, `drag`,
`scroll`, `resize`, `expect`, `golden`.

**Where the files belong.** Put the scenario in the project under test, next to its other tests —
`tests/tui/` is a good default. Goldens are written to `golden/` beside the scenario and should be
committed; artifacts from a run go to `.tui-artifacts/`, which belongs in that project's
`.gitignore`. Wire it into their existing test command or CI the way that project already does it,
rather than inventing a parallel one.

## Exit codes

`0` success · `1` condition not met (wait timed out, no match, step failed, diff found changes) ·
`2` usage error · `3` missing dependency · `4` no such session.

Branch on these rather than parsing the output.

## Troubleshooting

- **Blank screen right after start** — the app had not drawn yet. `tui start` already waits for the
  first paint; if the app is slow, add `--wait-text "<something it prints>"`.
- **Keys seem ignored** — the TUI may debounce. Retry with `--delay 40ms`, and confirm with
  `tui wait app --stable 300ms` that it is not still redrawing.
- **Clicks do nothing** — check the header for `mouse off`. Many TUIs only enable the mouse in
  certain modes or need a config flag.
- **Session already exists** — a previous run is still inside its lease. `tui ls`, then
  `tui stop <name>` (or `tui gc` to sweep everything already expired).
- **"session … expired after its lease"** — it was reaped for you. Start it again, with
  `--ttl 30m` if the work genuinely takes that long.
- **Need to watch it yourself** — `tui start` prints a `tmux -S … attach -t <name>` command. The
  window size stays pinned, so attaching does not change what the TUI sees.
