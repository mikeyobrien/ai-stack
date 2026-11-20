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

# Load optional gitignored .env without overriding already-exported env vars.
load_dotenv() {
  local env_file="$REPO/.env" line key val
  [ -f "$env_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in ''|\#*) continue ;; esac
    [[ "$line" == export\ * ]] && line="${line#export }"
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    val="${line#*=}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then
      val="${BASH_REMATCH[1]}"
    fi
    if [ -z "${!key+x}" ]; then
      export "$key=$val"
    fi
  done < "$env_file"
}

load_dotenv

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
  # resolve only through the harness they run inside. A node_modules symlink
  # under packages/ supplies the installed harness versions without polluting
  # the parent directory above the checkout.
  local shared="${DSH_PACKAGES:-$HOME/.local/share/dsh/node_modules}"
  local seam="$REPO/packages/node_modules"
  if [ -d "$shared" ]; then
    ln -sfn "$shared" "$seam"
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

install_skills() {
  "$REPO/scripts/sync-skills.sh"
  say "shared skills -> $HOME/.agents/skills"
}

install_agents() {
  local agents_dir="$HOME/.agents"
  local canonical="$agents_dir/AGENTS.md"
  mkdir -p "$agents_dir"
  if [ -f "$canonical" ] && [ ! -L "$canonical" ] && ! cmp -s "$REPO/agents/AGENTS.md" "$canonical"; then
    cp -p "$canonical" "$canonical.bak-$STAMP"
  fi
  cp "$REPO/agents/AGENTS.md" "$canonical"
  "$REPO/scripts/sync-agents-md.sh"
  say "shared global rules -> $canonical"
}

install_pi() {
  command -v npm  >/dev/null 2>&1 || die "npm is not on PATH"
  command -v node >/dev/null 2>&1 || die "node is not on PATH"

  mkdir -p "$PI_AGENT_DIR/npm" "$PI_AGENT_DIR/extensions" \
           "$PI_AGENT_DIR/themes" "$PI_AGENT_DIR/skills"

  local f
  for f in settings.json models.json; do
    [ -f "$PI_AGENT_DIR/$f" ] && cp -p "$PI_AGENT_DIR/$f" "$PI_AGENT_DIR/$f.bak-$STAMP"
  done

  # Render models.json from environment placeholders; drop providers whose
  # baseUrl resolves empty so unconfigured remote hosts stay out.
  node - "$REPO/pi/models.json" "$PI_AGENT_DIR/models.json" <<'NODE'
const fs = require('node:fs');
const [srcPath, dstPath] = process.argv.slice(2);
const expand = (input) => {
  let out = input;
  for (let i = 0; i < 6; i++) {
    const next = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^{}]*))?\}/g, (_, name, fallback) => {
      const val = process.env[name];
      if (val !== undefined && val !== '') return val;
      return fallback !== undefined ? fallback : '';
    });
    if (next === out) break;
    out = next;
  }
  return out;
};
const walk = (v) => {
  if (typeof v === 'string') return expand(v);
  if (Array.isArray(v)) return v.map(walk);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = walk(val);
    return out;
  }
  return v;
};
const doc = walk(JSON.parse(fs.readFileSync(srcPath, 'utf8')));
if (doc.providers && typeof doc.providers === 'object') {
  for (const [name, prov] of Object.entries(doc.providers)) {
    if (!prov || typeof prov.baseUrl !== 'string' || prov.baseUrl.trim() === '') {
      delete doc.providers[name];
    }
  }
}
fs.writeFileSync(dstPath, JSON.stringify(doc, null, 2) + '\n');
NODE

  # Render settings.json: apply PI_DEFAULT_PROVIDER / PI_DEFAULT_MODEL when set
  # and preserve machine-local state (deviceId, extensionChangelogVersions).
  node - "$REPO/pi/settings.json" "$PI_AGENT_DIR/settings.json" <<'NODE'
const fs = require('node:fs');
const [srcPath, dstPath] = process.argv.slice(2);
const next = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
if (process.env.PI_DEFAULT_PROVIDER) next.defaultProvider = process.env.PI_DEFAULT_PROVIDER;
if (process.env.PI_DEFAULT_MODEL) next.defaultModel = process.env.PI_DEFAULT_MODEL;
if (fs.existsSync(dstPath)) {
  try {
    const prev = JSON.parse(fs.readFileSync(dstPath, 'utf8'));
    if (prev.deviceId && !next.deviceId) next.deviceId = prev.deviceId;
    if (prev.extensionChangelogVersions && !next.extensionChangelogVersions) {
      next.extensionChangelogVersions = prev.extensionChangelogVersions;
    }
  } catch {}
}
fs.writeFileSync(dstPath, JSON.stringify(next, null, 2) + '\n');
NODE

  cp "$REPO/pi/themes/omarchy-system.json" "$PI_AGENT_DIR/themes/omarchy-system.json"
  cp "$REPO/pi/npm/package.json" "$PI_AGENT_DIR/npm/package.json"
  [ -f "$REPO/pi/npm/package-lock.json" ] \
    && cp "$REPO/pi/npm/package-lock.json" "$PI_AGENT_DIR/npm/package-lock.json"
  ( cd "$PI_AGENT_DIR/npm" && npm install --no-audit --no-fund )

  local ext dest_ext
  for ext in "$REPO"/pi/extensions/*.ts; do
    [ -f "$ext" ] || continue
    dest_ext="$PI_AGENT_DIR/extensions/$(basename "$ext")"
    if [ -f "$dest_ext" ] && [ ! -L "$dest_ext" ]; then
      mv "$dest_ext" "$dest_ext.bak-$STAMP"
    fi
    ln -sfn "$ext" "$dest_ext"
  done

  install_skills
  install_agents

  say "pi configuration -> $PI_AGENT_DIR"
}

case "${1:-all}" in
  all)    install_dsh; install_pi ;;
  dsh)    install_dsh ;;
  pi)     install_pi ;;
  agents) install_agents ;;
  skills) install_skills ;;
  -h|--help) say "usage: [PROFILE=<name>] $0 [all|dsh|pi|agents|skills]"; say "PROFILE names the profile the DSH half writes; it is required for all and dsh." ;;
  *) die "usage: [PROFILE=<name>] $0 [all|dsh|pi|agents|skills]" ;;
esac
