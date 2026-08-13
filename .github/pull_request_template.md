## What this changes

<!-- One or two sentences. What behaviour is different afterwards? -->

## Why

<!-- The problem this solves. Link an issue if there is one. -->

## How it was verified

<!--
What you actually ran, and what you observed. If it touches how a TUI is driven or captured,
paste the before/after screen.
-->

## Checklist

- [ ] `bun run typecheck` and `bun run format:check` pass
- [ ] `bun run test:coverage` passes
- [ ] A test covers this, and it would have failed before the change
- [ ] `skills/tui-driver/SKILL.md` updated if the agent-facing behaviour changed
- [ ] `README.md` updated if a command or flag changed
- [ ] `CHANGELOG.md` updated under `Unreleased`
