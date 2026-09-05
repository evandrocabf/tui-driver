#!/usr/bin/env bash

set -euo pipefail

TUI="${1:?usage: scripts/smoke-release.sh <standalone-tui>}"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tui-driver-release-smoke.XXXXXX")"
SESSION="release-smoke-$$"
EXPECTED_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)"

cleanup() {
  TUI_DRIVER_HOME="$ROOT/state" "$TUI" stop "$SESSION" --purge >/dev/null 2>&1 || true
  rm -rf "$ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

test "$(env PATH=/usr/bin:/bin "$TUI" --version)" = "tui-driver $EXPECTED_VERSION"

TUI_DRIVER_HOME="$ROOT/state" "$TUI" start \
  --name "$SESSION" \
  --cwd "$PWD" \
  --record 100ms \
  --wait-text Settings \
  -- python3 tests/fixtures/menu.py >/dev/null

TUI_DRIVER_HOME="$ROOT/state" "$TUI" keys "$SESSION" Down >/dev/null
TUI_DRIVER_HOME="$ROOT/state" "$TUI" wait "$SESSION" --text "SELECTED: Settings" --timeout 5s >/dev/null
TUI_DRIVER_HOME="$ROOT/state" "$TUI" wait "$SESSION" --stable 200ms --timeout 5s >/dev/null

FRAME_COUNT="$(TUI_DRIVER_HOME="$ROOT/state" "$TUI" frames "$SESSION" --json | \
  awk '/"id"/ { count++ } END { print count + 0 }')"
test "$FRAME_COUNT" -ge 2

TUI_DRIVER_HOME="$ROOT/state" "$TUI" watch "$SESSION" --stop >/dev/null
TUI_DRIVER_HOME="$ROOT/state" "$TUI" stop "$SESSION" --purge >/dev/null

echo "standalone release smoke test passed"
