#!/usr/bin/env bash
#
# tui-driver installer.
#
#   curl -fsSL https://github.com/evandrocabf/tui-driver/releases/latest/download/install.sh | bash
#   ./install.sh --agents claude,codex
#   ./install.sh --project .
#
# It does two separable things:
#
#   1. downloads and checksum-verifies the release archive for this OS/CPU and
#      puts its standalone `tui` / `tui-driver` executable on your PATH;
#   2. links skills/tui-driver/ into wherever your coding agents look for skills.
#
# Everything it writes is named as it writes it, `--dry-run` shows the plan
# without touching anything, and `--uninstall` removes exactly what was added.

set -euo pipefail

REPOSITORY="${TUI_DRIVER_REPOSITORY:-evandrocabf/tui-driver}"
RELEASE_BASE="${TUI_DRIVER_RELEASE_BASE:-https://github.com/$REPOSITORY/releases}"
SKILL_NAME="tui-driver"
MARKER="tui-driver-installer"
COPY_STAMP=".tui-driver-installed"
ROOT_MARKER=".tui-driver-release-install"

MIN_TMUX="3.2"

# ── options ──────────────────────────────────────────────────────────────────

AGENTS_ARG=""
INSTALL_ALL=0
NO_AGENTS=0
NO_BIN=0
PROJECT_DIR=""
PREFIX="${XDG_BIN_HOME:-$HOME/.local/bin}"
INSTALL_ROOT="${TUI_DRIVER_INSTALL_ROOT:-${XDG_DATA_HOME:-$HOME/.local/share}/tui-driver}"
RELEASE_VERSION="${TUI_DRIVER_VERSION:-latest}"
LOCAL_ARCHIVE=""
COPY=0
FORCE=0
DRY_RUN=0
UNINSTALL=0
LOCK_DIR=""

# ── output ───────────────────────────────────────────────────────────────────

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; R=$'\033[0m'
else
  B=""; DIM=""; RED=""; YEL=""; GRN=""; R=""
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s%s%s\n' "$B" "$*" "$R"; }
info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GRN" "$R" "$*"; }
skip() { printf '  %s·%s %s%s%s\n' "$DIM" "$R" "$DIM" "$*" "$R"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$R" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# Confirmation for something that was actually done. In a dry run the `would:`
# lines already narrate the plan, so a ✓ on top of them would just be a lie.
did()  { if [ "$DRY_RUN" -eq 0 ]; then ok "$@"; fi; }

# Every filesystem mutation goes through here, so --dry-run stays honest by
# construction rather than by remembering to check the flag at each call site.
act() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  %swould:%s %s\n' "$DIM" "$R" "$*"
    return 0
  fi
  "$@"
}

usage() {
  cat <<EOF
${B}tui-driver installer${R}

  install.sh [options]

${B}What gets installed${R}
  the release  a versioned standalone package under ${INSTALL_ROOT}
  the CLI      \`tui\` / \`tui-driver\` links in ${PREFIX}
  the skill    skills/${SKILL_NAME}/ linked into each agent's skill directory

${B}Options${R}
  --agents LIST     comma-separated: claude, codex, cursor, opencode, gemini,
                    agents, cline, windsurf. Default: whatever is detected.
  --all             install for every supported agent, detected or not
  --no-agents       install the CLI only
  --no-bin          install the skill only
  --project [DIR]   install into a project (.claude/skills/…) instead of \$HOME
  --prefix DIR      where the CLI links go (default: \$XDG_BIN_HOME or ~/.local/bin)
  --install-dir DIR where versioned releases live (default: \$XDG_DATA_HOME/tui-driver)
  --version VERSION install a release tag such as v0.1.0 (default: latest)
  --repository REPO download from OWNER/REPO instead
  --archive FILE    install a local release archive (requires FILE.sha256)
  --copy            copy the skill instead of symlinking it (no live updates)
  --force           replace files this installer does not recognise
  --dry-run         print the plan, change nothing
  --uninstall       remove what this installer added
  -h, --help        this

${B}Examples${R}
  ./install.sh                          # detect agents, link everything
  ./install.sh --version v0.1.0         # pin an exact release
  ./install.sh --agents claude,codex    # only those two
  ./install.sh --project .              # into the current project instead
  ./install.sh --uninstall --all        # take it all back out
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --agents)
      if [ $# -lt 2 ] || [ -z "$2" ]; then die "--agents needs a value"; fi
      AGENTS_ARG="$2"; shift 2 ;;
    --agents=*)   AGENTS_ARG="${1#*=}"; shift ;;
    --all)        INSTALL_ALL=1; shift ;;
    --no-agents)  NO_AGENTS=1; shift ;;
    --no-bin)     NO_BIN=1; shift ;;
    --project)
      # The directory is optional: `--project` on its own means "here".
      if [ $# -ge 2 ] && [ -n "${2:-}" ] && [ "${2#-}" = "${2:-}" ]; then
        PROJECT_DIR="$2"; shift 2
      else
        PROJECT_DIR="."; shift
      fi ;;
    --project=*)  PROJECT_DIR="${1#*=}"; shift ;;
    --prefix)
      if [ $# -lt 2 ] || [ -z "$2" ]; then die "--prefix needs a value"; fi
      PREFIX="$2"; shift 2 ;;
    --prefix=*)   PREFIX="${1#*=}"; shift ;;
    --install-dir)
      if [ $# -lt 2 ] || [ -z "$2" ]; then die "--install-dir needs a value"; fi
      INSTALL_ROOT="$2"; shift 2 ;;
    --install-dir=*) INSTALL_ROOT="${1#*=}"; shift ;;
    --version)
      if [ $# -lt 2 ] || [ -z "$2" ]; then die "--version needs a value"; fi
      RELEASE_VERSION="$2"; shift 2 ;;
    --version=*)     RELEASE_VERSION="${1#*=}"; shift ;;
    --repository)
      if [ $# -lt 2 ] || [ -z "$2" ]; then die "--repository needs a value"; fi
      REPOSITORY="$2"; RELEASE_BASE="https://github.com/$REPOSITORY/releases"; shift 2 ;;
    --repository=*) REPOSITORY="${1#*=}"; RELEASE_BASE="https://github.com/$REPOSITORY/releases"; shift ;;
    --archive)
      if [ $# -lt 2 ] || [ -z "$2" ]; then die "--archive needs a value"; fi
      LOCAL_ARCHIVE="$2"; shift 2 ;;
    --archive=*)     LOCAL_ARCHIVE="${1#*=}"; shift ;;
    --copy)       COPY=1; shift ;;
    --force)      FORCE=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "unknown option: $1 (try --help)" ;;
  esac
done

[ -n "$PREFIX" ] || die "--prefix needs a value"
[ -n "$INSTALL_ROOT" ] || die "--install-dir needs a value"
[ -n "$RELEASE_VERSION" ] || die "--version needs a value"
[ -n "$REPOSITORY" ] || die "--repository needs a value"
[ -z "$LOCAL_ARCHIVE" ] || [ -f "$LOCAL_ARCHIVE" ] || die "no such release archive: $LOCAL_ARCHIVE"

case "$PREFIX" in
  /*) ;;
  *) PREFIX="$PWD/$PREFIX" ;;
esac
case "$INSTALL_ROOT" in
  /*) ;;
  *) INSTALL_ROOT="$PWD/$INSTALL_ROOT" ;;
esac
[ "$PREFIX" != "/" ] || die "refusing to use / as --prefix"
[ "$INSTALL_ROOT" != "/" ] || die "refusing to use / as --install-dir"

if [ "$RELEASE_VERSION" = "latest" ]; then
  RELEASE_TAG="latest"
elif printf '%s\n' "$RELEASE_VERSION" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  RELEASE_TAG="v${RELEASE_VERSION#v}"
else
  die "invalid release version: $RELEASE_VERSION (expected latest or vMAJOR.MINOR.PATCH)"
fi

printf '%s\n' "$REPOSITORY" | grep -Eq '^[0-9A-Za-z_.-]+/[0-9A-Za-z_.-]+$' || \
  die "invalid repository: $REPOSITORY (expected OWNER/REPO)"

case "$(uname -s)" in
  Linux)  PLATFORM="linux" ;;
  Darwin) PLATFORM="darwin" ;;
  *) die "unsupported platform: $(uname -s). tui-driver drives tmux; use WSL on Windows." ;;
esac
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

ASSET="tui-driver-$PLATFORM-$ARCH.tar.gz"

# ── the agent table ──────────────────────────────────────────────────────────
#
# Paths come from each tool's own documentation. `~/.agents/skills` is the
# cross-tool convention that opencode, Cursor and Gemini/Antigravity all read,
# so it is worth having even when no single agent is detected.

ALL_AGENTS="claude codex cursor opencode gemini agents cline windsurf"

agent_label() {
  case "$1" in
    claude)   echo "Claude Code" ;;
    codex)    echo "Codex CLI" ;;
    cursor)   echo "Cursor" ;;
    opencode) echo "opencode" ;;
    gemini)   echo "Gemini CLI / Antigravity" ;;
    agents)   echo "AGENTS.md standard (.agents)" ;;
    cline)    echo "Cline" ;;
    windsurf) echo "Windsurf" ;;
    *)        echo "$1" ;;
  esac
}

# "dir"  → the skill directory is linked whole and loaded on demand.
# "file" → the agent has no skill loader, only an always-on rules directory,
#          so a single markdown file goes there instead.
agent_kind() {
  case "$1" in
    cline|windsurf) echo "file" ;;
    *)              echo "dir" ;;
  esac
}

cline_rules_dir() {
  # Cline documents ~/Documents/Cline/Rules, with ~/Cline/Rules as the Linux/WSL
  # fallback. Prefer whichever already exists.
  if [ -d "$HOME/Cline/Rules" ] && [ ! -d "$HOME/Documents/Cline/Rules" ]; then
    echo "$HOME/Cline/Rules"
  else
    echo "$HOME/Documents/Cline/Rules"
  fi
}

agent_home_target() {
  case "$1" in
    claude)   echo "$HOME/.claude/skills/$SKILL_NAME" ;;
    codex)    echo "$HOME/.codex/skills/$SKILL_NAME" ;;
    cursor)   echo "$HOME/.cursor/skills/$SKILL_NAME" ;;
    opencode) echo "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/skills/$SKILL_NAME" ;;
    gemini)   echo "$HOME/.gemini/skills/$SKILL_NAME" ;;
    agents)   echo "$HOME/.agents/skills/$SKILL_NAME" ;;
    cline)    echo "$(cline_rules_dir)/$SKILL_NAME.md" ;;
    # Windsurf's only global slot is memories/global_rules.md: one shared file,
    # always on, capped at 6000 characters. SKILL.md neither fits nor is that
    # file ours to own, so Windsurf is project-scoped only.
    windsurf) echo "" ;;
  esac
}

agent_project_target() {
  case "$1" in
    claude)   echo "$PROJECT_DIR/.claude/skills/$SKILL_NAME" ;;
    codex)    echo "$PROJECT_DIR/.codex/skills/$SKILL_NAME" ;;
    cursor)   echo "$PROJECT_DIR/.cursor/skills/$SKILL_NAME" ;;
    opencode) echo "$PROJECT_DIR/.opencode/skills/$SKILL_NAME" ;;
    gemini)   echo "$PROJECT_DIR/.gemini/skills/$SKILL_NAME" ;;
    agents)   echo "$PROJECT_DIR/.agents/skills/$SKILL_NAME" ;;
    cline)    echo "$PROJECT_DIR/.clinerules/$SKILL_NAME.md" ;;
    windsurf) echo "$PROJECT_DIR/.windsurf/rules/$SKILL_NAME.md" ;;
  esac
}

agent_target() {
  if [ -n "$PROJECT_DIR" ]; then agent_project_target "$1"; else agent_home_target "$1"; fi
}

agent_detected() {
  if [ -n "$PROJECT_DIR" ]; then
    case "$1" in
      claude)   [ -d "$PROJECT_DIR/.claude" ] ;;
      codex)    [ -d "$PROJECT_DIR/.codex" ] || [ -e "$PROJECT_DIR/AGENTS.md" ] ;;
      cursor)   [ -d "$PROJECT_DIR/.cursor" ] ;;
      opencode) [ -d "$PROJECT_DIR/.opencode" ] ;;
      gemini)   [ -d "$PROJECT_DIR/.gemini" ] ;;
      agents)   [ -d "$PROJECT_DIR/.agents" ] ;;
      cline)    [ -d "$PROJECT_DIR/.clinerules" ] ;;
      windsurf) [ -d "$PROJECT_DIR/.windsurf" ] ;;
      *)        false ;;
    esac
    return
  fi
  case "$1" in
    claude)   [ -d "$HOME/.claude" ] || have claude ;;
    codex)    [ -d "$HOME/.codex" ] || have codex ;;
    cursor)   [ -d "$HOME/.cursor" ] || have cursor-agent ;;
    opencode) [ -d "${XDG_CONFIG_HOME:-$HOME/.config}/opencode" ] || have opencode ;;
    gemini)   [ -d "$HOME/.gemini" ] || [ -d "$HOME/.antigravity" ] || have gemini ;;
    agents)   [ -d "$HOME/.agents" ] ;;
    cline)    [ -d "$HOME/Documents/Cline/Rules" ] || [ -d "$HOME/Cline/Rules" ] ;;
    windsurf) [ -d "$HOME/.codeium/windsurf" ] ;;
    *)        false ;;
  esac
}

known_agent() {
  local a
  for a in $ALL_AGENTS; do
    if [ "$a" = "$1" ]; then return 0; fi
  done
  return 1
}

# ── release package ──────────────────────────────────────────────────────────

release_url() {
  if [ "$RELEASE_TAG" = "latest" ]; then
    printf '%s/latest/download/%s' "$RELEASE_BASE" "$ASSET"
  else
    printf '%s/download/%s/%s' "$RELEASE_BASE" "$RELEASE_TAG" "$ASSET"
  fi
}

sha256_file() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    die "sha256sum or shasum is required to verify the release"
  fi
}

verify_checksum() {
  local archive="$1" checksum="$2" expected actual
  expected="$(awk 'NR == 1 { print $1 }' "$checksum")"
  case "$expected" in
    *[!0-9a-fA-F]*|'') die "invalid checksum file: $checksum" ;;
  esac
  [ "${#expected}" -eq 64 ] || die "invalid checksum file: $checksum"
  actual="$(sha256_file "$archive")"
  [ "$actual" = "$expected" ] || die "checksum mismatch for $archive"
  ok "SHA-256 verified"
}

validate_archive() {
  local archive="$1" entry saw_bin=0 saw_skill=0 saw_meta=0
  while IFS= read -r entry; do
    case "$entry" in
      tui-driver|tui-driver/*) ;;
      *) die "release archive contains an unsafe path: $entry" ;;
    esac
    case "/$entry/" in
      */../*|*/./*) die "release archive contains an unsafe path: $entry" ;;
    esac
    case "$entry" in
      tui-driver/bin/tui) saw_bin=1 ;;
      tui-driver/skills/tui-driver/SKILL.md) saw_skill=1 ;;
      tui-driver/release.json) saw_meta=1 ;;
    esac
  done < <(tar -tzf "$archive")
  [ "$saw_bin" -eq 1 ] && [ "$saw_skill" -eq 1 ] && [ "$saw_meta" -eq 1 ] || \
    die "release archive is missing the executable, skill, or metadata"
  if tar -tvzf "$archive" | awk 'substr($1, 1, 1) == "l" || substr($1, 1, 1) == "h" { found=1 } END { exit !found }'; then
    die "release archive contains a symbolic or hard link"
  fi
}

json_string() {
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -n 1
}

acquire_install_lock() {
  [ "$DRY_RUN" -eq 0 ] || return
  mkdir -p "$INSTALL_ROOT"
  LOCK_DIR="$INSTALL_ROOT/.install.lock"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    die "another install is using $INSTALL_ROOT (remove $LOCK_DIR if it is stale)"
  fi
}

release_install_lock() {
  if [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ]; then rmdir "$LOCK_DIR"; fi
  LOCK_DIR=""
}

fetch_release() {
  local url archive checksum extracted version metadata_platform metadata_arch version_dir staged
  TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tui-driver-install.XXXXXX")"
  archive="$TMP_ROOT/$ASSET"
  checksum="$archive.sha256"

  step "Fetching tui-driver release"
  if [ -n "$LOCAL_ARCHIVE" ]; then
    [ -f "$LOCAL_ARCHIVE" ] || die "no such release archive: $LOCAL_ARCHIVE"
    [ -f "$LOCAL_ARCHIVE.sha256" ] || die "missing checksum: $LOCAL_ARCHIVE.sha256"
    cp "$LOCAL_ARCHIVE" "$archive"
    cp "$LOCAL_ARCHIVE.sha256" "$checksum"
    info "archive: $LOCAL_ARCHIVE"
  else
    have curl || die "curl is required to download the release"
    url="$(release_url)"
    curl -fL --retry 3 --proto '=https' --tlsv1.2 -o "$archive" "$url"
    curl -fL --retry 3 --proto '=https' --tlsv1.2 -o "$checksum" "$url.sha256"
    info "release: ${RELEASE_TAG} ($PLATFORM/$ARCH)"
  fi

  verify_checksum "$archive" "$checksum"
  validate_archive "$archive"
  tar -xzf "$archive" -C "$TMP_ROOT"
  extracted="$TMP_ROOT/tui-driver"
  version="$(json_string version "$extracted/release.json")"
  metadata_platform="$(json_string platform "$extracted/release.json")"
  metadata_arch="$(json_string arch "$extracted/release.json")"
  [ -n "$version" ] || die "release metadata has no version"
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || \
    die "release metadata has an invalid version: $version"
  [ "$metadata_platform" = "$PLATFORM" ] || die "release is for $metadata_platform, expected $PLATFORM"
  [ "$metadata_arch" = "$ARCH" ] || die "release is for $metadata_arch, expected $ARCH"
  if [ "$RELEASE_TAG" != "latest" ] && [ "$RELEASE_TAG" != "v$version" ]; then
    die "release metadata version $version does not match requested $RELEASE_TAG"
  fi
  [ -x "$extracted/bin/tui" ] || die "release executable is not executable"

  if [ -e "$INSTALL_ROOT" ] && [ ! -f "$INSTALL_ROOT/$ROOT_MARKER" ] && \
     [ ! -d "$INSTALL_ROOT/.git" ] && [ -n "$(ls -A "$INSTALL_ROOT" 2>/dev/null)" ] && \
     [ "$FORCE" -eq 0 ]; then
    die "$INSTALL_ROOT exists and is not managed by this installer (use --force or --install-dir)"
  fi

  acquire_install_lock
  version_dir="$INSTALL_ROOT/releases/$version"
  step "Installing release $version"
  mkdir -p "$INSTALL_ROOT/releases"
  printf '%s\n' "$MARKER" > "$INSTALL_ROOT/$ROOT_MARKER"
  if [ -e "$version_dir" ]; then
    if [ -x "$version_dir/bin/tui" ] && [ "$(json_string version "$version_dir/release.json")" = "$version" ]; then
      skip "$version_dir (already installed)"
    elif [ "$FORCE" -eq 1 ]; then
      rm -rf "$version_dir"
      mv "$extracted" "$version_dir"
      did "$version_dir"
    else
      die "$version_dir exists but is not a valid tui-driver release (use --force)"
    fi
  else
    staged="$INSTALL_ROOT/releases/.${version}.new.$$"
    mv "$extracted" "$staged"
    mv "$staged" "$version_dir"
    did "$version_dir"
  fi

  ln -sfn "$version_dir" "$INSTALL_ROOT/.current.new.$$"
  mv -f "$INSTALL_ROOT/.current.new.$$" "$INSTALL_ROOT/current"
  SRC="$INSTALL_ROOT/current"
  ok "current → $version"
}

plan_release() {
  SRC="$INSTALL_ROOT/current"
  step "Fetching tui-driver release"
  if [ -n "$LOCAL_ARCHIVE" ]; then
    info "would: verify and unpack $LOCAL_ARCHIVE"
  else
    info "would: download $(release_url)"
    info "would: verify $(release_url).sha256"
  fi
  info "would: install under $INSTALL_ROOT/releases and update $INSTALL_ROOT/current"
}

uninstall_release() {
  step "Removing installed releases"
  if [ -f "$INSTALL_ROOT/$ROOT_MARKER" ]; then
    acquire_install_lock
    act rm -rf "$INSTALL_ROOT/releases"
    act rm -f "$INSTALL_ROOT/current" "$INSTALL_ROOT/$ROOT_MARKER"
    if [ -d "$INSTALL_ROOT/.git" ]; then
      did "removed release files; legacy checkout left at $INSTALL_ROOT"
    else
      if [ "$DRY_RUN" -eq 0 ]; then
        release_install_lock
        rmdir "$INSTALL_ROOT" 2>/dev/null || true
      fi
      did "removed releases from $INSTALL_ROOT"
    fi
  elif [ -e "$INSTALL_ROOT" ]; then
    warn "$INSTALL_ROOT is not marked as a release install — left alone"
  else
    skip "$INSTALL_ROOT (not present)"
  fi
}

# ── dependency checks ────────────────────────────────────────────────────────

# Deliberately not `sort -V`: BSD sort on older macOS does not have it.
version_at_least() {
  local have_v="$1" want_v="$2" oldifs h1 h2 h3 w1 w2 w3
  oldifs="${IFS:- }"
  IFS='.'
  # shellcheck disable=SC2086
  set -- $have_v; h1="${1:-0}"; h2="${2:-0}"; h3="${3:-0}"
  # shellcheck disable=SC2086
  set -- $want_v; w1="${1:-0}"; w2="${2:-0}"; w3="${3:-0}"
  IFS="$oldifs"

  h1=$(digits "$h1"); h2=$(digits "$h2"); h3=$(digits "$h3")
  w1=$(digits "$w1"); w2=$(digits "$w2"); w3=$(digits "$w3")

  if [ "$h1" -ne "$w1" ]; then [ "$h1" -gt "$w1" ]; return; fi
  if [ "$h2" -ne "$w2" ]; then [ "$h2" -gt "$w2" ]; return; fi
  [ "$h3" -ge "$w3" ]
}

digits() {
  local n
  n="$(printf '%s' "${1:-0}" | tr -cd '0-9')"
  # 10# keeps "08" from being read as an invalid octal literal.
  printf '%s' "$((10#${n:-0}))"
}

check_deps() {
  step "Checking dependencies"

  local tv
  if have tmux; then
    tv="$(tmux -V 2>/dev/null | sed 's/^tmux //')"
    if version_at_least "$(printf '%s' "$tv" | sed 's/[^0-9.].*$//')" "$MIN_TMUX"; then
      ok "tmux $tv"
    else
      warn "tmux $tv is older than the required $MIN_TMUX"
    fi
  else
    TMUX_MISSING=1
    warn "tmux is not installed — it is what tui-driver drives. Install it with:"
    case "$(uname -s)" in
      Darwin) info "      brew install tmux" ;;
      *)      info "      sudo apt install tmux ncurses-term   # or dnf/pacman/zypper" ;;
    esac
  fi

  # PNG output is optional everywhere: --svg needs nothing, and `tui doctor`
  # reports a missing rasterizer as a warning rather than a failure.
  if have rsvg-convert || have magick || have convert || have chromium || have google-chrome; then
    ok "a rasterizer for --png output"
  else
    skip "no PNG rasterizer (rsvg-convert / ImageMagick / Chrome) — --svg still works"
  fi
}

# ── the CLI links ────────────────────────────────────────────────────────────

is_our_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && grep -q "$MARKER" "$1" 2>/dev/null
}

is_our_dir() {
  [ -f "$1/$COPY_STAMP" ]
}

install_bin() {
  step "Installing the CLI into $PREFIX"

  local shim="$PREFIX/tui" alt="$PREFIX/tui-driver" executable="$INSTALL_ROOT/current/bin/tui"

  if [ -L "$shim" ] && [ "$(readlink "$shim")" = "$executable" ]; then
    ok "$shim ${DIM}(already linked)${R}"
  elif { [ -e "$shim" ] || [ -L "$shim" ]; } && ! is_our_file "$shim" && [ "$FORCE" -eq 0 ]; then
    warn "$shim exists and was not written by this installer — skipping (use --force)"
    return
  else
    act mkdir -p "$PREFIX"
    act rm -f "$shim"
    act ln -s "$executable" "$shim"
    did "$shim → $executable"
  fi

  if [ -L "$alt" ] && [ "$(readlink "$alt")" = "tui" ]; then
    ok "$alt ${DIM}(already linked)${R}"
  elif { [ -e "$alt" ] || [ -L "$alt" ]; } && ! is_our_file "$alt" && [ "$FORCE" -eq 0 ]; then
    warn "$alt exists and was not written by this installer — skipping (use --force)"
  else
    act rm -f "$alt"
    act ln -s "tui" "$alt"
    did "$alt → tui"
  fi

  case ":${PATH}:" in
    *":$PREFIX:"*) ;;
    *) PATH_HINT="$PREFIX" ;;
  esac
}

uninstall_bin() {
  step "Removing the CLI from $PREFIX"
  local shim="$PREFIX/tui" alt="$PREFIX/tui-driver"

  if [ -L "$shim" ] && [ "$(readlink "$shim")" = "$INSTALL_ROOT/current/bin/tui" ]; then
    act rm -f "$shim"; did "removed $shim"
  elif is_our_file "$shim"; then
    # Migrate/uninstall the source-checkout shim written by installer versions <= 0.1.0.
    act rm -f "$shim"; did "removed $shim"
  elif [ -e "$shim" ] || [ -L "$shim" ]; then
    warn "$shim was not written by this installer — left alone"
  else
    skip "$shim (not present)"
  fi

  if [ -L "$alt" ] && [ "$(readlink "$alt")" = "tui" ]; then
    act rm -f "$alt"; did "removed $alt"
  elif [ -e "$alt" ] || [ -L "$alt" ]; then
    warn "$alt was not written by this installer — left alone"
  else
    skip "$alt (not present)"
  fi
}

# ── the skill ────────────────────────────────────────────────────────────────

links_to() {
  [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ]
}

install_skill_dir() {
  local target="$1" src="$SRC/skills/$SKILL_NAME"

  if links_to "$target" "$src"; then
    ok "$target ${DIM}(already linked)${R}"
    return
  fi

  if [ -L "$target" ] || [ -e "$target" ]; then
    # A symlink under this exact name is ours to replace; a real directory only
    # if it carries our stamp, or the user insists.
    if [ -L "$target" ] || is_our_dir "$target" || [ "$FORCE" -eq 1 ]; then
      act rm -rf "$target"
    else
      warn "$target exists and was not created by this installer — skipping (use --force)"
      return
    fi
  fi

  act mkdir -p "$(dirname "$target")"
  if [ "$COPY" -eq 1 ]; then
    act cp -R "$src" "$target"
    if [ "$DRY_RUN" -eq 0 ]; then
      printf '%s\n' "written by $MARKER from $SRC" >"$target/$COPY_STAMP"
    fi
    did "$target ${DIM}(copied)${R}"
  else
    act ln -s "$src" "$target"
    did "$target ${DIM}→ $src${R}"
  fi
}

install_skill_file() {
  local target="$1" src="$SRC/skills/$SKILL_NAME/SKILL.md"

  if links_to "$target" "$src"; then
    ok "$target ${DIM}(already linked)${R}"
    return
  fi

  if [ -L "$target" ] || [ -e "$target" ]; then
    if [ -L "$target" ] || is_our_file "$target" || [ "$FORCE" -eq 1 ]; then
      act rm -f "$target"
    else
      warn "$target exists and was not created by this installer — skipping (use --force)"
      return
    fi
  fi

  act mkdir -p "$(dirname "$target")"
  if [ "$COPY" -eq 1 ]; then
    act cp "$src" "$target"
    # The trailing comment is what --uninstall recognises later; it is inert
    # markdown, so it changes nothing for the agent reading the file.
    if [ "$DRY_RUN" -eq 0 ]; then
      printf '\n<!-- %s: from %s -->\n' "$MARKER" "$SRC" >>"$target"
    fi
    did "$target ${DIM}(copied)${R}"
  else
    act ln -s "$src" "$target"
    did "$target ${DIM}→ $src${R}"
  fi
}

uninstall_skill() {
  local target="$1" kind="$2" dest

  if [ ! -L "$target" ] && [ ! -e "$target" ]; then
    skip "$target (not present)"
    return
  fi

  if [ -L "$target" ]; then
    dest="$(readlink "$target")"
    case "$dest" in
      */skills/"$SKILL_NAME"|*/skills/"$SKILL_NAME"/SKILL.md)
        act rm -f "$target"; did "removed $target"; return ;;
    esac
    if [ "$FORCE" -eq 1 ]; then
      act rm -f "$target"; did "removed $target ${DIM}(forced)${R}"
    else
      warn "$target points at $dest, not at a tui-driver skill — left alone"
    fi
    return
  fi

  if [ "$kind" = "dir" ] && is_our_dir "$target"; then
    act rm -rf "$target"; did "removed $target"
  elif [ "$kind" = "file" ] && is_our_file "$target"; then
    act rm -f "$target"; did "removed $target"
  elif [ "$FORCE" -eq 1 ]; then
    act rm -rf "$target"; did "removed $target ${DIM}(forced)${R}"
  else
    warn "$target is not something this installer created — left alone (use --force)"
  fi
}

# ── choosing agents ──────────────────────────────────────────────────────────

SELECTED=""

select_agents() {
  local a

  if [ -n "$AGENTS_ARG" ]; then
    for a in $(printf '%s' "$AGENTS_ARG" | tr ',' ' '); do
      if ! known_agent "$a"; then
        die "unknown agent: $a (known: $(printf '%s' "$ALL_AGENTS" | tr ' ' ','))"
      fi
      SELECTED="$SELECTED $a"
    done
    return
  fi

  if [ "$INSTALL_ALL" -eq 1 ]; then
    SELECTED="$ALL_AGENTS"
    return
  fi

  for a in $ALL_AGENTS; do
    if agent_detected "$a"; then SELECTED="$SELECTED $a"; fi
  done

  # Nothing detected is not the same as nothing wanted: ~/.agents/skills is read
  # by several agents and costs nothing if none of them ever turn up.
  if [ -z "$(printf '%s' "$SELECTED" | tr -d '[:space:]')" ]; then
    SELECTED="agents"
    NO_AGENT_DETECTED=1
  fi
}

# ── main ─────────────────────────────────────────────────────────────────────

TMUX_MISSING=0
PATH_HINT=""
NO_AGENT_DETECTED=0
SRC="$INSTALL_ROOT/current"
TMP_ROOT=""

cleanup() {
  if [ -n "$LOCK_DIR" ] && [ -d "$LOCK_DIR" ]; then rmdir "$LOCK_DIR" 2>/dev/null || true; fi
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then rm -rf "$TMP_ROOT"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -n "$PROJECT_DIR" ]; then
  [ -d "$PROJECT_DIR" ] || die "no such directory: $PROJECT_DIR"
  PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
fi

say ""
if [ "$UNINSTALL" -eq 1 ]; then
  step "Uninstalling tui-driver"
else
  step "Installing tui-driver"
fi
info "release: $RELEASE_TAG ($PLATFORM/$ARCH)"
info "install: $INSTALL_ROOT"
if [ -n "$PROJECT_DIR" ]; then info "project: $PROJECT_DIR"; fi
if [ "$DRY_RUN" -eq 1 ]; then info "${DIM}dry run — nothing will be written${R}"; fi
say ""

select_agents

if [ "$UNINSTALL" -eq 1 ]; then
  if [ "$NO_BIN" -eq 0 ]; then
    uninstall_bin
    say ""
  fi
  if [ "$NO_AGENTS" -eq 0 ]; then
    step "Removing skill links"
    for agent in $SELECTED; do
      target="$(agent_target "$agent")"
      if [ -n "$target" ]; then uninstall_skill "$target" "$(agent_kind "$agent")"; fi
    done
    say ""
  fi
  uninstall_release
  say ""
  exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
  plan_release
else
  fetch_release
fi
say ""

check_deps
say ""

if [ "$NO_BIN" -eq 0 ]; then
  install_bin
  say ""
fi

if [ "$NO_AGENTS" -eq 0 ]; then
  step "Installing the skill"
  if [ "$NO_AGENT_DETECTED" -eq 1 ]; then
    info "${DIM}no agent detected — using the shared .agents location${R}"
  fi

  for agent in $SELECTED; do
    target="$(agent_target "$agent")"
    label="$(agent_label "$agent")"
    if [ -z "$target" ]; then
      warn "$label: no global skill location — use --project DIR to install it per project"
      continue
    fi
    info "${B}$label${R}"
    if [ "$(agent_kind "$agent")" = "dir" ]; then
      install_skill_dir "$target"
    else
      install_skill_file "$target"
      info "${DIM}  no on-demand skill loader here — this file is read on every request${R}"
    fi
  done
  say ""
fi

# ── what to do next ──────────────────────────────────────────────────────────

step "Done"
if [ -n "$PATH_HINT" ]; then
  warn "$PATH_HINT is not on your PATH. Add it:"
  case "$(basename "${SHELL:-sh}")" in
    fish) info "      fish_add_path $PATH_HINT" ;;
    zsh)  info "      echo 'export PATH=\"$PATH_HINT:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
    *)    info "      echo 'export PATH=\"$PATH_HINT:\$PATH\"' >> ~/.bashrc && exec bash" ;;
  esac
fi
if [ "$TMUX_MISSING" -eq 1 ]; then warn "install tmux before running tui"; fi

say ""
info "Verify:   tui doctor"
info "Try it:   tui start --name htop -- htop && tui snap htop && tui stop htop"
info "Update:   rerun the latest release installer ${DIM}(--copy skills must be recopied)${R}"
info "Remove:   $INSTALL_ROOT/current/install.sh --uninstall"
say ""
