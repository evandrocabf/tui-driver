# Contributing

Thanks for taking a look. This is a small, dependency-free CLI; the bar for a change is that it
keeps working on someone else's machine.

## Getting set up

```bash
bun install          # dev tooling only — the CLI itself has zero runtime dependencies
bun run typecheck
bun test tests
./install.sh         # optional: `tui` on your PATH + the skill in your agents (--dry-run first)
```

You need `tmux` ≥ 3.2 and `python3` for the integration tests. Without them those tests skip
themselves, so a green local run does not necessarily mean much — CI runs them on Linux and macOS.

`bun run bin/tui.ts <command>` works without installing anything. `tui doctor` checks your
environment. `./install.sh` symlinks to your checkout rather than copying it, so your edits are live
in every agent immediately; `./install.sh --uninstall` reverses it.

## Lint, format, types

Three tools, three jobs, no overlap:

```bash
bun run typecheck     # tsc — is it well-typed?
bun run lint          # eslint — is it well-typed *and still wrong*?
bun run format:check  # prettier — does it look like everything else?
```

`bun run lint:fix` and `bun run format` apply what they can. CI runs all three, plus `shellcheck`
on the shell scripts.

The lint config is type-aware on purpose. `tsc` already rejects anything ill-typed, so the rules
that earn their place are the ones about code that type-checks and is still wrong — a dropped
promise, an `async` callback handed to something that discards it. Prettier owns layout entirely;
`eslint-config-prettier` switches off every formatting rule so the two never disagree.

Prettier covers **every** file it understands — TypeScript, Markdown, JSON, YAML — driven by
`.prettierignore` rather than a glob list, so a new file type is covered the day it appears. If a
lint rule fights a deliberate decision in this codebase, change the rule and say why in
`eslint.config.js`; do not reshape the code to please a default.

## Comments and documentation

Exported symbols carry TSDoc (`/** … */`), and there are no `//` comments anywhere in the codebase —
an in-body note that earns its place is a `/* … */` block. Document _why_, not what: the reader can
see what the code does, and the useful comment is the one recording the tmux quirk, the ordering
constraint or the failure mode that made the code look like that.

## How the code is laid out

| Area               | Files                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Command surface    | `src/cli.ts` (every command), `src/args.ts` (parser)                                           |
| tmux plumbing      | `src/tmux.ts` (private server + config), `src/session.ts`, `src/capture.ts`                    |
| Driving the TUI    | `src/input.ts` (keys, text, paste, mouse), `src/mouse.ts` (wire encodings)                     |
| Reading the screen | `src/ansi.ts` (parser, char widths), `src/locate.ts`, `src/diff.ts`, `src/format.ts`           |
| Images             | `src/svg.ts` (ANSI → SVG), `src/render.ts`, `src/png.ts` (rasterizer backends), `src/theme.ts` |
| Over time          | `src/watch.ts` (recorder), `src/frames.ts` (frame store)                                       |
| Repeatable runs    | `src/scenario.ts`                                                                              |
| Agent instructions | `skills/tui-driver/SKILL.md`                                                                   |

Everything that touches disk goes through `src/paths.ts`, so the whole state tree can be relocated
with `TUI_DRIVER_HOME` — that is what the tests do.

## Conventions

- **Strict TypeScript.** `noUncheckedIndexedAccess` is on; if the compiler makes you check an index,
  check it rather than asserting.
- **No runtime dependencies.** Adding one needs a good reason. Everything currently ships as source.
- **Errors carry exit codes.** Throw the class from `src/errors.ts` that matches the meaning
  (`UsageError` → 2, `DependencyError` → 3, `SessionError` → 4, `ConditionError` → 1) instead of a
  bare `Error`. The exit codes are a documented contract that agents branch on.
- **Never shell out with an interpolated path.** `tmux` runs some arguments through `/bin/sh`; use
  `shellQuote` from `src/util.ts`.
- **Synchronise, do not sleep.** New behaviour should be observable through `waitFor`, not a timer.
- `bun run format` before committing; CI runs `format:check`.

## Tests

```bash
bun run test:unit         # fast, no tmux needed
bun run test:integration  # drives real tmux sessions
bun run test:coverage     # the gate CI enforces
```

Unit tests cover the pure pieces (parsing, matching, colours, SVG). Integration tests drive a real
curses app through a real tmux server, with each file isolated in its own `TUI_DRIVER_HOME` — use the
helpers in `tests/helpers/tui.ts` rather than rolling your own setup.

The demo fixture `tests/fixtures/menu.py` needs a terminal of at least 58x12. Anything smaller and
curses aborts, the pane dies, and the failure looks like a bug in the harness. Use the exported
`FIXTURE_COLS`/`FIXTURE_ROWS`.

Coverage is gated by `scripts/check-coverage.ts` at 99% of lines. It reads the lcov report, because
bunfig's own `coverageThreshold` is reported but does not affect `bun test`'s exit code.

The last fraction of a percent is deliberate. What remains uncovered needs a broken environment to
reach — tmux missing, a runtime that is not bun, tmux dying mid-command — and each of those lines is
a safety net worth keeping. Delete a guard to make the number reach 100 and you have made the tool
worse; write the test if you can reach it, and leave it alone if you cannot.

## Changing what agents are told

`skills/tui-driver/SKILL.md` is the single source of the agent-facing instructions, and `AGENTS.md`
is a symlink to it. Edit the skill, not the symlink. If you add or change a command, that file
usually needs the same edit as the README.

Keep it vendor-neutral: no agent's tool names (`Read`, `Bash`, …) and no agent's directory committed
to this repo. It has to read the same to every agent that loads it.

## Pull requests

Keep the diff to one concern, describe what you observed rather than only what you changed, and
include a test that would have failed before. If the change affects what an agent should do, say so
explicitly — that file is read by machines that cannot ask follow-up questions.
