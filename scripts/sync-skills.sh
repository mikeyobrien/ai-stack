#!/usr/bin/env bash
set -euo pipefail

# Sync repo skills into ~/.agents/skills and mirror every skill in
# ~/.agents/skills across all installed coding agents' skill directories.
REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_SKILLS="$REPO/skills"
SHARED_SKILLS="$HOME/.agents/skills"

AGENT_SKILL_DIRS=(
  "$HOME/.claude/skills"
  "$HOME/.codex/skills"
  "$HOME/.pi/agent/skills"
  "$HOME/.gemini/config/skills"
)

MODE="sync"
if [[ "${1:-}" == "--check" ]]; then
  MODE="check"
elif [[ $# -gt 0 ]]; then
  echo "Usage: $(basename "$0") [--check]" >&2
  exit 2
fi

# Discover repo skills: flat <name>/SKILL.md or grouped <group>/<name>/SKILL.md.
declare -A REPO_MAP=()
if [[ -d "$REPO_SKILLS" ]]; then
  for entry in "$REPO_SKILLS"/*/; do
    [[ -d "$entry" ]] || continue
    base="$(basename "${entry%/}")"
    [[ "$base" == .* ]] && continue
    if [[ -f "${entry}SKILL.md" ]]; then
      REPO_MAP["$base"]="${entry%/}"
      continue
    fi
    for child in "${entry}"*/; do
      [[ -d "$child" ]] || continue
      cbase="$(basename "${child%/}")"
      [[ "$cbase" == .* ]] && continue
      [[ -f "${child}SKILL.md" ]] || continue
      REPO_MAP["$cbase"]="${child%/}"
    done
  done
fi

link_or_check() {
  local src="$1" dst="$2"
  local src_real
  src_real="$(readlink -f "$src")"

  if [[ "$MODE" == "check" ]]; then
    if [[ -L "$dst" && "$(readlink -f "$dst")" == "$src_real" ]]; then
      echo "OK    $dst -> $src"
      return 0
    elif [[ -d "$dst" && ! -L "$dst" ]]; then
      echo "LOCAL $dst (real directory kept)"
      return 0
    else
      echo "DRIFT $dst (expected -> $src)"
      return 1
    fi
  fi

  mkdir -p "$(dirname "$dst")"
  if [[ -e "$dst" && ! -L "$dst" ]]; then
    echo "KEEP  $dst (real directory wins)"
    return 0
  fi
  ln -sfn "$src" "$dst"
  echo "LINK  $dst -> $src"
}

status=0

# 1. Ensure repo skills are linked into ~/.agents/skills.
for name in $(printf '%s\n' "${!REPO_MAP[@]}" | sort); do
  link_or_check "${REPO_MAP[$name]}" "$SHARED_SKILLS/$name" || status=1
done

# 2. Mirror every skill in ~/.agents/skills into each agent's skills directory.
if [[ -d "$SHARED_SKILLS" ]]; then
  for entry in "$SHARED_SKILLS"/*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    name="$(basename "$entry")"
    [[ "$name" == .* ]] && continue
    [[ -f "$entry/SKILL.md" ]] || continue
    target="$(readlink -f "$entry")"
    for dir in "${AGENT_SKILL_DIRS[@]}"; do
      link_or_check "$target" "$dir/$name" || status=1
    done
  done
fi

exit "$status"
