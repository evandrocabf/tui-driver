# Security

## Reporting a vulnerability

Please report privately through
[GitHub security advisories](https://github.com/evandrocabf/tui-driver/security/advisories/new)
rather than opening a public issue. We aim to acknowledge a report within a week.

## What this tool does, by design

`tui-driver` exists to run programs and send input to them. Several capabilities are intentional and
are not vulnerabilities in themselves:

- **`tui start` runs whatever you pass it**, and `--shell` runs a raw shell command string. Treat a
  scenario file the way you would treat a shell script: only run ones you trust.
- **Sessions outlive the command that created them.** They keep running until `tui stop`, and any
  process on the machine running as your user can talk to the tmux socket.
- **Captured frames are written to disk unencrypted** under `TUI_DRIVER_HOME`
  (`~/.local/state/tui-driver` by default). If a TUI displays a secret, that secret lands in the frame
  store, in any PNG or SVG rendered from it, and in `report.json` for a failing scenario step. Use
  `tui stop --purge` or `tui clean` when that matters.
- **`--raw-log` mirrors everything the pane emits** into `raw-output.log`, including keystrokes echoed
  back by the application.

## What we do treat as a vulnerability

- Anything that lets scenario or session input escape the intended process — for example a session
  name, label, or path that reaches a shell unquoted.
- Predictable paths in a shared temporary directory that another local user could pre-create or
  substitute.
- Reading or writing outside `TUI_DRIVER_HOME` and the paths you explicitly pass on the command line.

## Isolation

The tool runs its own tmux server on a private socket with its own config, so it cannot see or
disturb tmux sessions you started yourself. The socket lives inside `TUI_DRIVER_HOME`, or under the
temp directory with a hashed name when that path would exceed the ~108-byte unix socket limit.

## Note on the Chrome rendering backend

When neither `rsvg-convert` nor ImageMagick is installed, PNG rendering falls back to headless Chrome
and passes `--no-sandbox`, because the input is an SVG this tool generated itself and the sandbox
often cannot start in containers. If that trade-off is not acceptable in your environment, install
`librsvg2-tools` or ImageMagick, or use `--svg`, which needs no external tool at all.
