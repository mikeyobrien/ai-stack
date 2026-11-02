#!/usr/bin/env bash
# Install this repo's DSH profile and pi configuration on the current machine.
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-meta}"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
STAMP="$(date +%Y%m%d-%H%M%S)"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

install_dsh() {
  command -v dsh  >/dev/null 2>&1 || die "dsh is not on PATH"
  command -v pnpm >/dev/null 2>&1 || die "pnpm is not on PATH"
  command -v node >/dev/null 2>&1 || die "node is not on PATH"

  local target="$DSH_HOME/profiles/$PROFILE" f
  mkdir -p "$target"
  for f in package.json cordis.patch.yml pnpm-workspace.yaml pnpm-lock.yaml; do
    [ -f "$target/$f" ] && cp -p "$target/$f" "$target/$f.bak-$STAMP"
  done

  cp "$REPO/dsh/profile/package.json" "$target/package.json"
  cp "$REPO/dsh/profile/cordis.patch.yml" "$target/cordis.patch.yml"
  cp "$REPO/dsh/profile/pnpm-workspace.yaml" "$target/pnpm-workspace.yaml"

  # Never commit absolute paths: resolve link:@REPO@ specs for this checkout.
  node - "$target/package.json" "$REPO" <<'NODE'
const fs = require('node:fs');
const [file, repo] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
  if (typeof spec === 'string' && spec.startsWith('link:@REPO@/')) {
    pkg.dependencies[name] = 'link:' + repo + spec.slice('link:@REPO@'.length);
  }
}
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
NODE

  # Install workspace dependencies (mov-skills needs `yaml`) so packages are
  # self-contained wherever the repo lives.
  say "installing workspace dependencies in $REPO"
  ( cd "$REPO" && pnpm install --config.confirmModulesPurge=false )

  # The plugins import @deepseek-ai/* without declaring it, so those imports
  # resolve only through the harness they run inside. A node_modules one level
  # above the checkout supplies exactly the installed versions; without it a
  # plugin loads from the profile but fails the moment Node resolves its import.
  local shared="${DSH_PACKAGES:-$HOME/.local/share/dsh/node_modules}"
  local seam="$(dirname "$REPO")/node_modules"
  if [ -d "$shared" ]; then
    [ -L "$seam" ] || ln -sfn "$shared" "$seam"
    say "plugin resolution: $seam -> $shared"
  else
    say "warning: $shared is missing; repo plugins will not resolve @deepseek-ai/*"
  fi

  dsh plugin --profile "$PROFILE" install

  say "DSH profile '$PROFILE' -> $target"
  say "  export SPARKS_API_KEY=..."
  say "  export DSH_SPARKS_BASE_URL=http://127.0.0.1:8888/v1   # if not local"
  say "  dsh --profile $PROFILE"
}

install_pi() {
  command -v npm >/dev/null 2>&1 || die "npm is not on PATH"

  mkdir -p "$PI_AGENT_DIR/npm" "$PI_AGENT_DIR/extensions" \
           "$PI_AGENT_DIR/themes" "$PI_AGENT_DIR/skills"

  local f
  for f in settings.json models.json AGENTS.md; do
    [ -f "$PI_AGENT_DIR/$f" ] && cp -p "$PI_AGENT_DIR/$f" "$PI_AGENT_DIR/$f.bak-$STAMP"
    cp "$REPO/pi/$f" "$PI_AGENT_DIR/$f"
  done
  cp "$REPO/pi/themes/omarchy-system.json" "$PI_AGENT_DIR/themes/omarchy-system.json"
  cp "$REPO/pi/npm/package.json" "$PI_AGENT_DIR/npm/package.json"
  [ -f "$REPO/pi/npm/package-lock.json" ] \
    && cp "$REPO/pi/npm/package-lock.json" "$PI_AGENT_DIR/npm/package-lock.json"
  ( cd "$PI_AGENT_DIR/npm" && npm install --no-audit --no-fund )

  # Share the mov-skills skills with pi. Existing real directories win.
  local skill name dest
  for skill in "$REPO"/skills/*/; do
    [ -f "${skill}SKILL.md" ] || continue
    name="$(basename "${skill%/}")"
    dest="$PI_AGENT_DIR/skills/$name"
    if [ -e "$dest" ] && [ ! -L "$dest" ]; then
      say "pi: leaving existing $dest in place"
      continue
    fi
    ln -sfn "${skill%/}" "$dest"
  done

  say "pi configuration -> $PI_AGENT_DIR"
}

case "${1:-all}" in
  all) install_dsh; install_pi ;;
  dsh) install_dsh ;;
  pi)  install_pi ;;
  -h|--help) say "usage: $0 [all|dsh|pi]" ;;
  *) die "usage: $0 [all|dsh|pi]" ;;
esac
