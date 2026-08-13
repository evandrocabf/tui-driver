#!/usr/bin/env bash
#
# tui-driver installer.
#
#   curl -fsSL https://raw.githubusercontent.com/evandrocabf/tui-driver/main/install.sh | bash
#   ./install.sh --agents claude,codex
#   ./install.sh --project .
#
# It does two separable things:
#
#   1. puts `tui` / `tui-driver` on your PATH, as a small shim that execs bun on
#      the checkout — so `git pull` is the whole update story;
#   2. links skills/tui-driver/ into wherever your coding agents look for skills.
#
# Everything it writes is named as it writes it, `--dry-run` shows the plan
# without touching anything, and `--uninstall` removes exactly what was added.

set -euo pipefail

REPO_URL="${TUI_DRIVER_REPO:-https://github.com/evandrocabf/tui-driver.git}"
SKILL_NAME="tui-driver"
MARKER="tui-driver-installer"
COPY_STAMP=".tui-driver-installed"

MIN_BUN="1.3.11"
MIN_TMUX="3.2"

# ── options ──────────────────────────────────────────────────────────────────

AGENTS_ARG=""
INSTALL_ALL=0
NO_AGENTS=0
NO_BIN=0
PROJECT_DIR=""
PREFIX="${XDG_BIN_HOME:-$HOME/.local/bin}"
SRC_DIR_ARG=""
GIT_REF=""
COPY=0
FORCE=0
DRY_RUN=0
UNINSTALL=0

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
  the CLI      a \`tui\` / \`tui-driver\` shim in ${PREFIX}
  the skill    skills/${SKILL_NAME}/ linked into each agent's skill directory

${B}Options${R}
  --agents LIST     comma-separated: claude, codex, cursor, opencode, gemini,
                    agents, cline, windsurf. Default: whatever is detected.
  --all             install for every supported agent, detected or not
  --no-agents       install the CLI only
  --no-bin          install the skill only
  --project [DIR]   install into a project (.claude/skills/…) instead of \$HOME
  --prefix DIR      where the CLI shim goes (default: \$XDG_BIN_HOME or ~/.local/bin)
  --dir DIR         where to clone the source when not run from a checkout
                    (default: \$XDG_DATA_HOME/tui-driver or ~/.local/share/tui-driver)
  --ref REF         git branch/tag/commit to install (implies a clone)
  --repo URL        clone from a fork instead (or set \$TUI_DRIVER_REPO)
  --copy            copy the skill instead of symlinking it (no live updates)
  --force           replace files this installer does not recognise
  --dry-run         print the plan, change nothing
  --uninstall       remove what this installer added
  -h, --help        this

${B}Examples${R}
  ./install.sh                          # detect agents, link everything
  ./install.sh --agents claude,codex    # only those two
  ./install.sh --project .              # into the current project instead
  ./install.sh --uninstall --all        # take it all back out
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --agents)     AGENTS_ARG="${2:-}"; shift 2 ;;
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
    --prefix)     PREFIX="${2:-}"; shift 2 ;;
    --prefix=*)   PREFIX="${1#*=}"; shift ;;
    --dir)        SRC_DIR_ARG="${2:-}"; shift 2 ;;
    --dir=*)      SRC_DIR_ARG="${1#*=}"; shift ;;
    --ref)        GIT_REF="${2:-}"; shift 2 ;;
    --ref=*)      GIT_REF="${1#*=}"; shift ;;
    --repo)       REPO_URL="${2:-}"; shift 2 ;;
    --repo=*)     REPO_URL="${1#*=}"; shift ;;
    --copy)       COPY=1; shift ;;
    --force)      FORCE=1; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    -h|--help)    usage; exit 0 ;;
    *)            die "unknown option: $1 (try --help)" ;;
  esac
done

case "$(uname -s)" in
  Linux|Darwin) ;;
  *) die "unsupported platform: $(uname -s). tui-driver drives tmux; use WSL on Windows." ;;
esac

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

# ── locating the source checkout ─────────────────────────────────────────────

is_checkout() {
  [ -f "$1/bin/tui.ts" ] && [ -f "$1/skills/$SKILL_NAME/SKILL.md" ] && [ -f "$1/package.json" ]
}

default_src_dir() {
  echo "${XDG_DATA_HOME:-$HOME/.local/share}/tui-driver"
}

resolve_source() {
  local self script_dir
  # Empty when piped through `curl | bash`, which is exactly when we must clone.
  self="${BASH_SOURCE[0]:-}"
  if [ -n "$self" ] && [ -f "$self" ]; then
    script_dir="$(cd "$(dirname "$self")" && pwd)"
    if is_checkout "$script_dir" && [ -z "$GIT_REF" ] && [ -z "$SRC_DIR_ARG" ]; then
      SRC="$script_dir"
      SRC_MODE="local"
      return
    fi
  fi
  SRC="${SRC_DIR_ARG:-$(default_src_dir)}"
  SRC_MODE="clone"
}

clone_or_update() {
  have git || die "git is required to fetch the source (or run install.sh from a checkout)"

  if [ -d "$SRC/.git" ]; then
    step "Updating $SRC"
    act git -C "$SRC" fetch --quiet --tags origin
    if [ -n "$GIT_REF" ]; then
      act git -C "$SRC" checkout --quiet "$GIT_REF"
      act git -C "$SRC" pull --quiet --ff-only origin "$GIT_REF" 2>/dev/null || true
    else
      act git -C "$SRC" pull --quiet --ff-only
    fi
    did "updated"
    return
  fi

  if [ -e "$SRC" ] && ! is_checkout "$SRC"; then
    die "$SRC exists and is not a tui-driver checkout"
  fi

  step "Cloning $REPO_URL"
  act mkdir -p "$(dirname "$SRC")"
  if [ -n "$GIT_REF" ]; then
    act git clone --quiet --depth 1 --branch "$GIT_REF" "$REPO_URL" "$SRC"
  else
    act git clone --quiet --depth 1 "$REPO_URL" "$SRC"
  fi
  did "cloned into $SRC"
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

  local v tv
  if have bun; then
    v="$(bun --version 2>/dev/null | tr -d '[:space:]')"
    if version_at_least "$v" "$MIN_BUN"; then
      ok "bun $v"
    else
      warn "bun $v is older than the required $MIN_BUN — upgrade with: bun upgrade"
    fi
  else
    BUN_MISSING=1
    warn "bun is not installed. tui-driver runs on bun; install it with:"
    info "      curl -fsSL https://bun.sh/install | bash"
  fi

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

# ── the CLI shim ─────────────────────────────────────────────────────────────

is_our_file() {
  [ -f "$1" ] && grep -q "$MARKER" "$1" 2>/dev/null
}

is_our_dir() {
  [ -f "$1/$COPY_STAMP" ]
}

install_bin() {
  step "Installing the CLI into $PREFIX"

  local shim="$PREFIX/tui" alt="$PREFIX/tui-driver" bun_path tmp
  bun_path="$(command -v bun 2>/dev/null || true)"

  if [ -e "$shim" ] && ! is_our_file "$shim" && [ "$FORCE" -eq 0 ]; then
    warn "$shim exists and was not written by this installer — skipping (use --force)"
    return
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    info "${DIM}would: write $shim${R}"
    info "${DIM}would: link  $alt -> tui${R}"
    return
  fi

  mkdir -p "$PREFIX"
  tmp="$(mktemp "$PREFIX/.tui.XXXXXX")"
  cat >"$tmp" <<EOF
#!/bin/sh
# $MARKER — generated file, edits will be overwritten.
TUI_DRIVER_SRC="$SRC"
if command -v bun >/dev/null 2>&1; then
  exec bun "\$TUI_DRIVER_SRC/bin/tui.ts" "\$@"
fi
# PATH is often thinner when an editor or agent spawns us, so fall back to
# wherever bun lived at install time before giving up.
if [ -x "$bun_path" ]; then
  exec "$bun_path" "\$TUI_DRIVER_SRC/bin/tui.ts" "\$@"
fi
echo "tui-driver: bun not found on PATH. Install it: curl -fsSL https://bun.sh/install | bash" >&2
exit 3
EOF
  chmod 755 "$tmp"
  mv -f "$tmp" "$shim"
  ok "$shim"

  if [ -e "$alt" ] && [ ! -L "$alt" ] && ! is_our_file "$alt" && [ "$FORCE" -eq 0 ]; then
    warn "$alt exists and was not written by this installer — skipping (use --force)"
  else
    ln -sfn "tui" "$alt"
    ok "$alt → tui"
  fi

  case ":${PATH}:" in
    *":$PREFIX:"*) ;;
    *) PATH_HINT="$PREFIX" ;;
  esac
}

uninstall_bin() {
  step "Removing the CLI from $PREFIX"
  local shim="$PREFIX/tui" alt="$PREFIX/tui-driver"

  if is_our_file "$shim"; then
    act rm -f "$shim"; did "removed $shim"
  elif [ -e "$shim" ]; then
    warn "$shim was not written by this installer — left alone"
  else
    skip "$shim (not present)"
  fi

  if [ -L "$alt" ] && [ "$(readlink "$alt")" = "tui" ]; then
    act rm -f "$alt"; did "removed $alt"
  elif [ -e "$alt" ]; then
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

BUN_MISSING=0
TMUX_MISSING=0
PATH_HINT=""
NO_AGENT_DETECTED=0
SRC=""
SRC_MODE=""

if [ -n "$PROJECT_DIR" ]; then
  [ -d "$PROJECT_DIR" ] || die "no such directory: $PROJECT_DIR"
  PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd)"
fi

resolve_source

if [ "$UNINSTALL" -eq 0 ] && [ "$SRC_MODE" = "clone" ]; then
  clone_or_update
fi

say ""
if [ "$UNINSTALL" -eq 1 ]; then
  step "Uninstalling tui-driver"
else
  step "Installing tui-driver"
  if ! is_checkout "$SRC"; then die "$SRC is not a tui-driver checkout"; fi
fi
info "source:  $SRC"
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
  say "The checkout at $SRC was left in place; delete it yourself if you want it gone."
  say ""
  exit 0
fi

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
if [ "$BUN_MISSING" -eq 1 ];  then warn "install bun before running tui"; fi
if [ "$TMUX_MISSING" -eq 1 ]; then warn "install tmux before running tui"; fi

say ""
info "Verify:   tui doctor"
info "Try it:   tui start --name htop -- htop && tui snap htop && tui stop htop"
info "Update:   git -C $SRC pull        ${DIM}(symlinked skills follow; --copy ones do not)${R}"
info "Remove:   $SRC/install.sh --uninstall"
say ""
