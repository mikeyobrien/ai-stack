#!/usr/bin/env bash
# Install this repo's DSH profile and pi configuration on the current machine.
set -euo pipefail

REPO="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-meta}"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
STAMP="$(date +%Y%m%d-%H%M%S)"
FORCE="${INSTALL_FORCE:-0}"
DRY_RUN=0

ARGS=()
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) ARGS+=("$arg") ;;
  esac
done
set -- "${ARGS[@]}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

install_dsh() {
  [ -n "$PROFILE" ] || die "set PROFILE to the profile name to install, e.g. PROFILE=meta ./install.sh dsh"
  command -v dsh  >/dev/null 2>&1 || die "dsh is not on PATH"
  command -v pnpm >/dev/null 2>&1 || die "pnpm is not on PATH"
  command -v node >/dev/null 2>&1 || die "node is not on PATH"

  local target="$DSH_HOME/profiles/$PROFILE" f

  # Refuse to replace a live profile with one that would drop bundles or
  # dependencies. The check is read-only and runs before any backup/copy.
  local guard_status=0
  if [ -f "$target/package.json" ]; then
    node - "$target/package.json" "$REPO/dsh/profile/package.json" <<'NODE' || guard_status=$?
const fs = require('node:fs')
const [targetPath, repoPath] = process.argv.slice(2)
const target = JSON.parse(fs.readFileSync(targetPath, 'utf8'))
const repo = JSON.parse(fs.readFileSync(repoPath, 'utf8'))
const targetBundles = new Set(target?.dsh?.profile?.bundles ?? [])
const repoBundles = new Set(repo?.dsh?.profile?.bundles ?? [])
const targetDeps = new Set(Object.keys(target?.dependencies ?? {}))
const repoDeps = new Set(Object.keys(repo?.dependencies ?? {}))
const lostBundles = [...targetBundles].filter((id) => !repoBundles.has(id))
const lostDeps = [...targetDeps].filter((id) => !repoDeps.has(id))
const addedBundles = [...repoBundles].filter((id) => !targetBundles.has(id))
if (lostBundles.length > 0 || lostDeps.length > 0) {
  console.error('install.sh: target profile would lose entries:')
  for (const id of lostBundles) console.error('  bundle: ' + id)
  for (const id of lostDeps) console.error('  dependency: ' + id)
  console.error('  repo adds: ' + (addedBundles.length === 0 ? '(none)' : addedBundles.join(', ')))
  process.exit(3)
}
NODE
    if [ "$guard_status" -eq 3 ] && [ "$DRY_RUN" = "1" ]; then
      say "dry run: target profile would lose entries (see above); no files written"
      return 0
    fi
    if [ "$guard_status" -eq 3 ] && [ "$FORCE" != "1" ]; then
      die "refusing to overwrite $target; use --force after reviewing the diff"
    fi
    if [ "$guard_status" -ne 0 ] && [ "$guard_status" -ne 3 ]; then
      die "profile guard failed for $target"
    fi
  else
    say "no live profile to compare at $target"
  fi

  if [ "$DRY_RUN" = "1" ]; then
    say "dry run: would write $target (guard passed)"
    return 0
  fi

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

link_pi_skill() {
  local dest="$PI_AGENT_DIR/skills/$1"
  if [ -e "$dest" ] && [ ! -L "$dest" ]; then
    say "pi: leaving existing $dest in place"
    return
  fi
  ln -sfn "$2" "$dest"
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

  # Share the mov-skills skills with pi, mirroring the provider: a folder
  # carrying its own SKILL.md, or one level of children named after the child
  # (internal/mov-mode -> mov-mode), so flows keep their runner. Existing real
  # directories win.
  local skill child
  for skill in "$REPO"/skills/*/; do
    case "$(basename "${skill%/}")" in .*) continue ;; esac
    if [ -f "${skill}SKILL.md" ]; then
      link_pi_skill "$(basename "${skill%/}")" "${skill%/}"
      continue
    fi
    for child in "${skill}"*/; do
      case "$(basename "${child%/}")" in .*) continue ;; esac
      [ -f "${child}SKILL.md" ] || continue
      link_pi_skill "$(basename "${child%/}")" "${child%/}"
    done
  done

  say "pi configuration -> $PI_AGENT_DIR"
}

case "${1:-all}" in
  all) install_dsh; install_pi ;;
  dsh) install_dsh ;;
  pi)  install_pi ;;
  -h|--help) say "usage: [PROFILE=<name>] $0 [all|dsh|pi]"; say "PROFILE names the profile the DSH half writes; it is required for all and dsh." ;;
  *) die "usage: [PROFILE=<name>] $0 [all|dsh|pi]" ;;
esac
