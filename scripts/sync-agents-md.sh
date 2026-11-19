#!/usr/bin/env bash
set -euo pipefail

SRC="$HOME/.agents/AGENTS.md"
CURSOR_RULE="$HOME/.cursor/rules/base.mdc"

TARGETS=(
  "$HOME/.claude/CLAUDE.md"
  "$HOME/.codex/AGENTS.md"
  "$HOME/.pi/agent/AGENTS.md"
  "$HOME/.omp/agent/AGENTS.md"
  "$HOME/.config/opencode/AGENTS.md"
  "$HOME/.gemini/GEMINI.md"
  "$HOME/.config/amp/AGENTS.md"
  "$HOME/.copilot/copilot-instructions.md"
  "$HOME/.dsh/AGENTS.md"
)

MODE="sync"
if [[ "${1:-}" == "--check" ]]; then
  MODE="check"
elif [[ $# -gt 0 ]]; then
  echo "Usage: $(basename "$0") [--check]" >&2
  exit 2
fi

if [[ ! -f "$SRC" || -L "$SRC" ]]; then
  echo "ERROR: Canonical file must be a regular file: $SRC" >&2
  exit 1
fi

render_cursor_rule() {
  printf -- '---\nalwaysApply: true\n---\n\n'
  cat "$SRC"
}

if [[ "$MODE" == "check" ]]; then
  status=0
  for dst in "${TARGETS[@]}"; do
    if [[ -L "$dst" && "$(readlink -f "$dst")" == "$(readlink -f "$SRC")" ]]; then
      echo "OK   $dst -> $SRC"
    else
      echo "DRIFT $dst"
      status=1
    fi
  done

  if [[ -f "$CURSOR_RULE" ]] && diff -q <(render_cursor_rule) "$CURSOR_RULE" >/dev/null 2>&1; then
    echo "OK   $CURSOR_RULE (matches $SRC)"
  else
    echo "DRIFT $CURSOR_RULE"
    status=1
  fi

  if [[ -e "$HOME/AGENTS.md" ]]; then
    echo "WARN $HOME/AGENTS.md still exists (may cause duplicate parent-walk loading)"
    status=1
  fi
  exit "$status"
fi

ts="$(date +%Y%m%d-%H%M%S)"
for dst in "${TARGETS[@]}"; do
  mkdir -p "$(dirname "$dst")"
  if [[ -e "$dst" && ! -L "$dst" ]]; then
    backup="${dst}.bak.${ts}"
    mv "$dst" "$backup"
    echo "BACKED UP $dst -> $backup"
  fi
  ln -sfn "$SRC" "$dst"
  echo "LINKED $dst -> $SRC"
done

mkdir -p "$(dirname "$CURSOR_RULE")"
tmp_cursor="$(mktemp)"
trap 'rm -f "$tmp_cursor"' EXIT
render_cursor_rule > "$tmp_cursor"
mv "$tmp_cursor" "$CURSOR_RULE"
echo "WROTE  $CURSOR_RULE"
