#!/usr/bin/env bash

set -euo pipefail

ARCHIVE="${1:?usage: scripts/test-release-install.sh <release.tar.gz>}"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tui-driver-release-install.XXXXXX")"
EXPECTED_VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' package.json | head -n 1)"

cleanup() {
  rm -rf "$ROOT"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$ROOT/home" "$ROOT/project"

install_release() {
  env \
    HOME="$ROOT/home" \
    XDG_DATA_HOME="$ROOT/data" \
    XDG_BIN_HOME="$ROOT/bin" \
    ./install.sh \
      --archive "$ARCHIVE" \
      --agents agents \
      --project "$ROOT/project" \
      "$@"
}

install_release
install_release --version "v$EXPECTED_VERSION"

EXPECTED="$ROOT/data/tui-driver/current/bin/tui"
test "$(readlink "$ROOT/bin/tui")" = "$EXPECTED"
test "$(readlink "$ROOT/bin/tui-driver")" = "tui"
test -L "$ROOT/project/.agents/skills/tui-driver"
test "$(env PATH=/usr/bin:/bin "$ROOT/bin/tui" --version)" = "tui-driver $EXPECTED_VERSION"

env \
  HOME="$ROOT/home" \
  XDG_DATA_HOME="$ROOT/data" \
  XDG_BIN_HOME="$ROOT/bin" \
  ./install.sh \
    --agents agents \
    --project "$ROOT/project" \
    --uninstall

test ! -e "$ROOT/bin/tui"
test ! -e "$ROOT/bin/tui-driver"
test ! -e "$ROOT/project/.agents/skills/tui-driver"
test ! -e "$ROOT/data/tui-driver/current"
test ! -e "$ROOT/data/tui-driver"

echo "release installer smoke test passed"
